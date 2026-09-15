/**
 * Сведение слоёв в один кадр. Здесь же живут генератор, палитра,
 * измерение fps и авто-подстройка тяжёлого raymarch под реальную машину.
 */

import { clamp, clamp01 } from '../audio/features.ts';
import type { MoodVector } from '../audio/mood-vector.ts';
import type { CoverArt } from '../cover/cover-art.ts';
import type { Settings } from '../settings.ts';
import { Generator } from './generator.ts';
import { BaseLayer } from './layer-base.ts';
import { GenreLayer } from './layer-genre.ts';
import { TransientLayer, type TransientDebug } from './layer-transient.ts';
import { findHarmony, PaletteEngine, type HarmonyScheme, type Palette } from './palette.ts';
import type { PrimitiveId, RenderFrame } from './primitives/types.ts';
import { Scene, type SceneState } from './scene.ts';
import { trackKey } from './seed.ts';

export interface CompositorStats {
  fps: number;
  frameMs: number;
  activePrimitives: PrimitiveId[];
  baseId: PrimitiveId;
  transient: TransientDebug;
  palette: Palette;
  scene: SceneState;
  effectiveQuality: number;
  seedLabel: string;
  /** Имя действующей гармонической схемы — для панели и отладки. */
  harmonyName: string;
}

/** Ниже этого fps начинаем экономить на разрешении шейдера. */
const FPS_FLOOR = 50;
const FPS_CEILING = 58;
const QUALITY_MIN = 0.3;
const QUALITY_STEP = 0.1;
const QUALITY_CHECK_MS = 2000;

export class Compositor {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base = new BaseLayer();
  private readonly genre = new GenreLayer();
  private readonly transient = new TransientLayer();
  private readonly generator: Generator;
  private readonly paletteEngine = new PaletteEngine();
  private readonly scene = new Scene();

  private width = 1;
  private height = 1;
  private lastPalette: Palette | null = null;

  private frameTimes: number[] = [];
  private fps = 60;
  private effectiveQuality = 0.5;
  private lastQualityCheckMs = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('2D-контекст недоступен');
    this.ctx = ctx;
    this.generator = new Generator(trackKey(null, null));
    this.reseedLayers();
  }

  get seedLabel(): string {
    return this.generator.seed.label;
  }

  get palette(): Palette | null {
    return this.lastPalette;
  }

  resize(cssWidth: number, cssHeight: number, dpr = window.devicePixelRatio || 1): void {
    // Пиксельный размер ограничиваем: на 4K-телике честный DPR убивает fps,
    // а разница на генеративной картинке почти не видна.
    const scale = Math.min(dpr, 1.5);
    this.width = Math.max(1, Math.round(cssWidth * scale));
    this.height = Math.max(1, Math.round(cssHeight * scale));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    this.base.resize(this.width, this.height);
    this.genre.resize(this.width, this.height);
    this.transient.resize(this.width, this.height);
  }

  /** @returns true, если seed сменился и слои были переинициализированы. */
  setTrack(artist: string | null, title: string | null): boolean {
    const changed = this.generator.setTrack(trackKey(artist, title));
    if (changed) this.reseedLayers();
    return changed;
  }

  reshuffle(): void {
    this.generator.reshuffle();
    this.reseedLayers();
  }

  render(mood: MoodVector, settings: Settings, cover: CoverArt): CompositorStats {
    const started = performance.now();
    const harmony = this.activeHarmony(settings);

    // Сцена идёт первой: от неё зависят и палитра, и набор примитивов, и камера.
    const scene = this.scene.update(mood, clamp01(settings.transients.intensity));
    const palette = this.buildPalette(mood, settings, cover, harmony);
    this.lastPalette = palette;

    this.applyQuality(mood.timeMs, settings);
    const state = this.generator.update(mood, settings, scene);

    const frame: Omit<RenderFrame, 'ctx' | 'params' | 'weight'> = {
      width: this.width,
      height: this.height,
      mood,
      palette,
      scene,
      dtMs: mood.deltaMs,
      timeMs: mood.timeMs,
    };

    if (settings.layers.base.enabled) this.base.render(frame, state, settings, cover);
    const activePrimitives = settings.layers.genre.enabled ? this.genre.render(frame, state) : [];

    this.transient.update(mood, settings, scene);
    const transientDebug = settings.layers.transient.enabled
      ? this.transient.render(palette, scene, clamp01(settings.layers.transient.weight))
      : { particles: 0, rings: 0, glitch: false, flash: 0 };

    this.compose(settings, scene);
    if (settings.layers.transient.enabled) this.transient.applyGlitch(this.ctx, mood, settings);

    const frameMs = performance.now() - started;
    this.trackFps(mood.deltaMs);

    return {
      fps: this.fps,
      frameMs,
      activePrimitives,
      baseId: state.baseId,
      transient: transientDebug,
      palette,
      scene,
      effectiveQuality: this.effectiveQuality,
      seedLabel: state.seed.label,
      harmonyName: harmony.name,
    };
  }

  dispose(): void {
    this.base.dispose();
    this.genre.dispose();
  }

  /**
   * Сведение слоёв через камеру. Камера — такая же сущность сцены, как свет и
   * вещество: её дрейф, орбита, наезд и крен применяются здесь одним
   * преобразованием, поверх которого ложится толчок от импульса.
   */
  private compose(settings: Settings, scene: SceneState): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);

    const shake = settings.layers.transient.enabled ? this.transient.shake : { x: 0, y: 0 };
    const minSide = Math.min(this.width, this.height);
    const camera = settings.camera.enabled ? scene.camera : IDLE_CAMERA;
    const amount = clamp01(settings.camera.amount);

    const offsetX = camera.x * minSide * amount + shake.x;
    const offsetY = camera.y * minSide * amount + shake.y;
    const roll = camera.roll * amount;
    const shakeMargin = Math.max(Math.abs(offsetX), Math.abs(offsetY)) / minSide;
    // Кадр должен покрыть себя после поворота и сдвига, иначе по краям чернота.
    const overscale = coverScale(this.width, this.height, roll) * (1 + shakeMargin * 2.2);
    const scale = Math.max(1, camera.zoom * amount + (1 - amount)) * overscale;

    const cx = this.width / 2;
    const cy = this.height / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(cx + offsetX, cy + offsetY);
    ctx.rotate(roll);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    if (settings.layers.base.enabled) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp01(settings.layers.base.weight);
      ctx.drawImage(this.base.canvas, 0, 0);
    }
    if (settings.layers.genre.enabled) {
      // 'screen' вместо 'lighter': жанровый слой светится, но плавно упирается
      // в единицу, а не выбивает кадр в белое на дропе. Транзиентам ниже
      // сложение оставлено — им как раз положено бить.
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = clamp01(settings.layers.genre.weight);
      ctx.drawImage(this.genre.canvas, 0, 0);
    }
    if (settings.layers.transient.enabled) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      ctx.drawImage(this.transient.canvas, 0, 0);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** 'auto' — схему выбирает seed трека; иначе пользователь фиксирует её вручную. */
  private activeHarmony(settings: Settings): HarmonyScheme {
    return findHarmony(settings.palette.harmonyId === 'auto'
      ? this.generator.seed.harmonyId
      : settings.palette.harmonyId);
  }

  private buildPalette(
    mood: MoodVector,
    settings: Settings,
    cover: CoverArt,
    harmony: HarmonyScheme,
  ): Palette {
    return this.paletteEngine.build({
      mood,
      tuning: settings.palette.tuning,
      harmony,
      seedHueShift: this.generator.seed.hueShift,
      cover,
      useCover: settings.cover.useForPalette,
    });
  }

  /**
   * Авто-качество: если кадры не укладываются в 60 fps, режем разрешение
   * шейдера; когда запас появился — возвращаем обратно, но не выше настройки.
   */
  private applyQuality(nowMs: number, settings: Settings): void {
    const target = clamp(QUALITY_MIN, 1, settings.generator.quality);
    if (this.lastQualityCheckMs === 0) {
      this.effectiveQuality = target;
      this.lastQualityCheckMs = nowMs;
    }
    if (nowMs - this.lastQualityCheckMs >= QUALITY_CHECK_MS) {
      this.lastQualityCheckMs = nowMs;
      if (this.fps < FPS_FLOOR) {
        this.effectiveQuality = Math.max(QUALITY_MIN, this.effectiveQuality - QUALITY_STEP);
      } else if (this.fps > FPS_CEILING && this.effectiveQuality < target) {
        this.effectiveQuality = Math.min(target, this.effectiveQuality + QUALITY_STEP);
      }
    }
    this.effectiveQuality = Math.min(this.effectiveQuality, target);
    this.genre.setQuality(this.effectiveQuality);
  }

  private trackFps(deltaMs: number): void {
    this.frameTimes.push(deltaMs);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const average = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = average > 0 ? 1000 / average : 60;
  }

  private reseedLayers(): void {
    const seed = this.generator.seed;
    this.base.reseed(seed);
    this.genre.reseed(seed);
    this.scene.reseed(seed);
  }
}

/** Камера в покое: ею подменяется сцена, когда камера выключена в настройках. */
const IDLE_CAMERA = { x: 0, y: 0, zoom: 1, roll: 0 } as const;

/**
 * Минимальный масштаб, при котором повёрнутый кадр всё ещё накрывает экран.
 * Без него крен камеры открывает чёрные клинья по углам.
 */
function coverScale(width: number, height: number, roll: number): number {
  const sin = Math.abs(Math.sin(roll));
  const cos = Math.abs(Math.cos(roll));
  return Math.max(
    (width * cos + height * sin) / width,
    (height * cos + width * sin) / height,
  );
}
