/**
 * Сведение слоёв в один кадр. Здесь же живут генератор, палитра,
 * измерение fps и авто-подстройка тяжёлого raymarch под реальную машину.
 */

import { clamp, clamp01 } from '../audio/features.ts';
import type { MoodVector } from '../audio/mood-vector.ts';
import type { CoverArt } from '../cover/cover-art.ts';
import type { Settings } from '../settings.ts';
import { FlowField } from './flow-field.ts';
import { Generator } from './generator.ts';
import { BaseLayer } from './layer-base.ts';
import { GenreLayer } from './layer-genre.ts';
import { TransientLayer, type TransientDebug } from './layer-transient.ts';
import { findHarmony, PaletteEngine, type HarmonyScheme, type Palette } from './palette.ts';
import type { PrimitiveId, RenderFrame } from './primitives/types.ts';
import { Scene, type SceneConfig, type SceneState } from './scene.ts';
import { PostPass, QUALITY_ORDER, type LightSettings, type QualityLevel } from './post-pass.ts';
import { trackKey } from './seed.ts';

export interface CompositorStats {
  fps: number;
  frameMs: number;
  activePrimitives: PrimitiveId[];
  baseId: PrimitiveId;
  transient: TransientDebug;
  /** Отработал ли пост-конвейер в этом кадре. */
  postActive: boolean;
  palette: Palette;
  scene: SceneState;
  /** Действующий уровень качества цепочки; 'off' — цепочка снята целиком. */
  quality: QualityLevel | 'off';
  seedLabel: string;
  /** Имя действующей гармонической схемы — для панели и отладки. */
  harmonyName: string;
  /** Текущий адаптивный порог свечения. */
  bloomThreshold: number;
  /** Средняя яркость кадра: по ней текст подбирает контрастный цвет. */
  meanLuminance: number;
}

/** Ниже этого fps начинаем снижать качество, выше — пробуем вернуть. */
const FPS_FLOOR = 50;
const FPS_CEILING = 58;
const QUALITY_CHECK_MS = 2000;
/** Сколько проверок подряд должен держаться провал, прежде чем снижать. */
const DOWNGRADE_STREAK = 2;
/** И сколько — запас, прежде чем повышать обратно. Возвращаемся неохотно. */
const UPGRADE_STREAK = 6;

/** Размер копии кадра для замера средней яркости и период замера. */
const LUMA_WIDTH = 16;
const LUMA_HEIGHT = 9;
const LUMA_INTERVAL_FRAMES = 6;

export class Compositor {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base = new BaseLayer();
  private readonly genre = new GenreLayer();
  /** Общее поле потока: им несёт и линии фона, и все частицы. */
  private readonly field = new FlowField();
  private readonly transient = new TransientLayer(this.field);
  private readonly generator: Generator;
  private readonly paletteEngine = new PaletteEngine();
  private readonly scene = new Scene();
  private readonly post = new PostPass();

  /**
   * Слои сводятся сюда, а не сразу на экран: варп читает сведённый кадр
   * текстурой, а из самого себя канвас читать нельзя.
   */
  private readonly composed = document.createElement('canvas');
  private readonly composedCtx: CanvasRenderingContext2D;

  private width = 1;
  private height = 1;
  private lastPalette: Palette | null = null;

  private frameTimes: number[] = [];
  private fps = 60;
  private qualityIndex = 1;
  private lastQualityCheckMs = 0;
  private highFpsStreak = 0;
  /**
   * Пост-конвейер — четыре полноэкранных прохода. Если разрешение raymarch
   * уже на минимуме, а fps всё равно не вытягивает, снимаем его целиком:
   * лучше без деформаций и света, но плавно.
   */
  private postAllowed = true;
  private lowFpsStreak = 0;
  /** Адаптивный порог bloom и средняя яркость кадра, см. measureLuminance. */
  private bloomThreshold = 0.5;
  private meanLuminance = 0.2;
  private frameCounter = 0;
  private readonly lumaCanvas = document.createElement('canvas');
  private readonly lumaCtx: CanvasRenderingContext2D | null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const composedCtx = this.composed.getContext('2d', { alpha: false });
    if (!ctx || !composedCtx) throw new Error('2D-контекст недоступен');
    this.ctx = ctx;
    this.composedCtx = composedCtx;
    this.lumaCanvas.width = LUMA_WIDTH;
    this.lumaCanvas.height = LUMA_HEIGHT;
    this.lumaCtx = this.lumaCanvas.getContext('2d', { willReadFrequently: true });
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
    // Основной проход идёт в физическом разрешении экрана без всяких потолков.
    // Ограничение DPR давало мыло на 4K: холст рисовался мельче экрана и
    // растягивался. Экономить разрешение можно только вспомогательным
    // проходам (свечение, размытие), но не самой картинке.
    this.width = Math.max(1, Math.round(cssWidth * dpr));
    this.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    this.composed.width = this.width;
    this.composed.height = this.height;
    this.base.resize(this.width, this.height);
    this.genre.resize(this.width, this.height);
    this.transient.resize(this.width, this.height);
    this.post.resize(this.width, this.height);
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
    const scene = this.scene.update(mood, sceneConfig(settings));
    const palette = this.buildPalette(mood, settings, cover, harmony);
    this.lastPalette = palette;

    this.applyQuality(mood.timeMs, settings);
    const state = this.generator.update(mood, settings, scene);

    const frame: Omit<RenderFrame, 'ctx' | 'params' | 'weight' | 'tuning'> = {
      width: this.width,
      height: this.height,
      mood,
      palette,
      scene,
      dtMs: mood.deltaMs,
      timeMs: mood.timeMs,
    };

    if (settings.layers.base.enabled) this.base.render(frame, state, settings, cover);
    const activePrimitives = settings.layers.genre.enabled
      ? this.genre.render(frame, state, clamp01(settings.memory.trails))
      : [];

    this.transient.update(mood, settings, scene, settings.particles);
    const transientDebug = settings.layers.transient.enabled
      ? this.transient.render(palette, scene, clamp01(settings.layers.transient.weight))
      : { particles: 0, rings: 0, flash: 0, particleTypes: [] };

    this.compose(settings, scene);
    this.measureLuminance(settings);
    const posted = this.applyPost(scene, settings, palette);

    const frameMs = performance.now() - started;
    this.trackFps(mood.deltaMs);

    return {
      fps: this.fps,
      frameMs,
      activePrimitives,
      baseId: state.baseId,
      transient: transientDebug,
      postActive: posted,
      palette,
      scene,
      quality: this.postAllowed ? QUALITY_ORDER[this.qualityIndex] : 'off',
      seedLabel: state.seed.label,
      harmonyName: harmony.name,
      bloomThreshold: this.bloomThreshold,
      meanLuminance: this.meanLuminance,
    };
  }

  dispose(): void {
    this.base.dispose();
    this.genre.dispose();
    this.post.dispose();
  }

  /**
   * Сведение слоёв через камеру. Камера — такая же сущность сцены, как свет и
   * вещество: её дрейф, орбита, наезд и крен применяются здесь одним
   * преобразованием, поверх которого ложится толчок от импульса.
   */
  private compose(settings: Settings, scene: SceneState): void {
    const ctx = this.composedCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);

    const minSide = Math.min(this.width, this.height);
    const camera = settings.camera.enabled ? scene.camera : IDLE_CAMERA;
    // Мастер амплитуды уже применён внутри сцены — здесь только ручка камеры.
    const amount = clamp01(settings.camera.amount);

    // Тряска входит в смещение камеры: это её толчок, а не отдельный эффект.
    const offsetX = camera.x * minSide * amount;
    const offsetY = camera.y * minSide * amount;
    const roll = camera.roll * amount;

    // Точка интереса: наезд и крен идут вокруг неё, а не вокруг центра кадра.
    const cx = this.width / 2;
    const cy = this.height / 2;
    const focusX = cx + (camera.focusX - 0.5) * this.width * amount;
    const focusY = cy + (camera.focusY - 0.5) * this.height * amount;

    // Кадр должен покрыть себя после поворота, сдвига и ухода точки интереса.
    const margin = (Math.max(Math.abs(offsetX), Math.abs(offsetY))
      + Math.max(Math.abs(focusX - cx), Math.abs(focusY - cy))) / minSide;
    const overscale = coverScale(this.width, this.height, roll) * (1 + margin * 2.2);
    const scale = Math.max(1, camera.zoom * amount + (1 - amount)) * overscale;
    // Сжатие по вертикали компенсируем растяжением по горизонтали: кадр
    // «придавливает», а не уменьшает.
    const squash = 1 - (1 - camera.squash) * amount;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(focusX + offsetX, focusY + offsetY);
    ctx.rotate(roll);
    ctx.scale(scale / squash, scale * squash);
    ctx.translate(-focusX, -focusY);

    if (settings.layers.base.enabled) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp01(settings.layers.base.weight);
      ctx.drawImage(this.base.canvas, 0, 0);
    }
    if (settings.layers.genre.enabled) {
      // Сложение, а не 'screen': яркость должна набираться наложением линий —
      // там, где их много, получается яркий гребень. От выбивания в белое
      // защищает тон-маппинг в конце цепочки, а не режим смешивания.
      ctx.globalCompositeOperation = 'lighter';
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

  /**
   * Проход искажения и перенос кадра на экран.
   * @returns отработал ли варп; false — кадр ушёл на экран как есть.
   */
  private applyPost(scene: SceneState, settings: Settings, palette: Palette): boolean {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Широкое поле зрения гнёт кадр бочкой, узкое — выпрямляет. Это статичная
    // часть линзы, в отличие от импульсной lensPulse.
    const fovLens = settings.camera.enabled
      ? (scene.camera.fov - 1) * 0.3 * clamp01(settings.camera.amount)
      : 0;

    const light: LightSettings = {
      bloom: clamp01(settings.light.bloom),
      bloomThreshold: this.bloomThreshold,
      rays: clamp01(settings.light.rays),
      rim: clamp01(settings.light.rim),
      lightColour: toUnitRgb(palette.accentRgb(scene.light.warmth)),
      rimColour: toUnitRgb(palette.accentRgb(0.95)),
      // Точка белого едет за средней яркостью: на светлом кадре запас нужен
      // больше, иначе тон-маппинг съедает контраст.
      whitePoint: clamp(1.2, 2.4, 1.2 + this.meanLuminance * 2),
    };
    // Выключенные дыхание и виньетка — это нейтральные значения, а не отдельная
    // ветка в шейдере.
    const lightState = {
      ...scene.light,
      exposure: settings.light.exposure ? scene.light.exposure : 1,
      vignette: settings.light.vignette ? scene.light.vignette : 0,
      flare: settings.light.flare ? scene.light.flare : 0,
    };

    const idle = PostPass.isIdle(scene.deformation, scene.impact, scene.memory, light)
      && Math.abs(fovLens) < 0.004;
    const output = idle || !this.postAllowed || !this.post.available
      ? null
      : this.post.render(
        this.composed, scene.deformation, scene.impact, scene.memory, lightState, light, fovLens,
      );

    ctx.drawImage(output ?? this.composed, 0, 0, this.width, this.height);
    return output !== null;
  }

  /**
   * Средняя яркость кадра для адаптивного порога bloom.
   *
   * Считается по крошечной копии и не каждый кадр: getImageData синхронизирует
   * конвейер, а порог по своей природе медленный и в частых замерах не нуждается.
   */
  private measureLuminance(settings: Settings): void {
    if (this.frameCounter++ % LUMA_INTERVAL_FRAMES !== 0) return;
    const ctx = this.lumaCtx;
    if (!ctx) return;

    ctx.drawImage(this.composed, 0, 0, LUMA_WIDTH, LUMA_HEIGHT);
    let sum = 0;
    try {
      const data = ctx.getImageData(0, 0, LUMA_WIDTH, LUMA_HEIGHT).data;
      for (let i = 0; i < data.length; i += 4) {
        sum += (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
      }
    } catch {
      return;
    }
    const mean = sum / (LUMA_WIDTH * LUMA_HEIGHT);
    this.meanLuminance += (mean - this.meanLuminance) * 0.25;
    // Порог держится выше средней яркости: светится то, что выделяется на фоне
    // кадра, а не весь кадр целиком. Именно это и не даёт выжечь картинку.
    // Порог держится заметно выше средней яркости: на тёмной картинке с
    // тонкими линиями светиться должны только сами линии, а не фон вокруг них.
    // Ручной сдвиг порога складывается с адаптивным: плюс оставляет свечение
    // только самому яркому, минус опускает порог к фону.
    const target = clamp(0.3, 0.92, mean * 2.2 + 0.3 + settings.light.bloomBias);
    this.bloomThreshold += (target - this.bloomThreshold) * 0.25;
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
    const target = QUALITY_ORDER.indexOf(settings.quality.level);
    const ceiling = target < 0 ? 1 : target;

    if (this.lastQualityCheckMs === 0) {
      this.qualityIndex = ceiling;
      this.lastQualityCheckMs = nowMs;
    }

    if (settings.quality.auto && nowMs - this.lastQualityCheckMs >= QUALITY_CHECK_MS) {
      this.lastQualityCheckMs = nowMs;
      if (this.fps < FPS_FLOOR) {
        this.highFpsStreak = 0;
        this.lowFpsStreak++;
        if (this.lowFpsStreak >= DOWNGRADE_STREAK) {
          this.lowFpsStreak = 0;
          // Ступень ниже самого низкого уровня — снять цепочку целиком.
          if (this.qualityIndex > 0) this.qualityIndex--;
          else this.postAllowed = false;
        }
      } else if (this.fps > FPS_CEILING) {
        this.lowFpsStreak = 0;
        this.highFpsStreak++;
        if (this.highFpsStreak >= UPGRADE_STREAK) {
          this.highFpsStreak = 0;
          if (!this.postAllowed) this.postAllowed = true;
          else if (this.qualityIndex < ceiling) this.qualityIndex++;
        }
      } else {
        this.lowFpsStreak = 0;
        this.highFpsStreak = 0;
      }
    }

    // Ручной выбор всегда потолок: авто может только опустить, но не поднять выше.
    this.qualityIndex = Math.min(this.qualityIndex, ceiling);
    if (!settings.quality.auto) {
      this.qualityIndex = ceiling;
      this.postAllowed = true;
    }

    this.post.setQuality(QUALITY_ORDER[this.qualityIndex]);
    this.genre.setQuality(this.post.qualityPreset.raymarch);
  }

  private trackFps(deltaMs: number): void {
    this.frameTimes.push(deltaMs);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const average = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = average > 0 ? 1000 / average : 60;
  }

  private reseedLayers(): void {
    const seed = this.generator.seed;
    // Поле пересевается первым: слои и частицы должны получить уже новое.
    this.field.reseed(seed);
    this.base.reseed(seed);
    this.genre.reseed(seed);
    this.genre.useField(this.field);
    this.transient.reseed(seed, this.field);
    this.scene.reseed(seed);
  }
}

/** Камера в покое: ею подменяется сцена, когда камера выключена в настройках. */
const IDLE_CAMERA = {
  x: 0, y: 0, zoom: 1, roll: 0, squash: 1,
  focusX: 0.5, focusY: 0.5, fov: 1, dolly: 0, cutId: 0,
} as const;

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

/** Разрешения для сцены собираются из настроек здесь: сцена в Settings не лезет. */
function sceneConfig(settings: Settings): SceneConfig {
  const t = settings.transients;
  return {
    intensity: clamp01(t.intensity),
    shake: t.shake,
    shockwave: t.shockwave,
    ripple: t.ripple,
    punchZoom: t.punchZoom,
    lensPulse: t.lensPulse,
    rollKick: t.rollKick,
    compression: t.compression,
    chromaticBurst: t.chromaticBurst,
    slice: t.slice,
    pressureWave: t.pressureWave,
    // Деформации тоже участвуют в укачивании, поэтому мастер движения их гасит.
    deformation: settings.deformation.enabled
      ? clamp01(settings.deformation.amount) * clamp01(settings.motion.amount)
      : 0,
    deformations: {
      domainWarp: clamp01(settings.deformation.domainWarp),
      twist: clamp01(settings.deformation.twist),
      wave: clamp01(settings.deformation.wave),
      turbulence: clamp01(settings.deformation.turbulence),
      melt: clamp01(settings.deformation.melt),
      fold: clamp01(settings.deformation.fold),
    },
    cut: settings.camera.enabled && settings.camera.cut,
    feedback: clamp01(settings.memory.feedback),
    smear: clamp01(settings.memory.smear),
    echo: clamp01(settings.memory.echo),
    ghosts: settings.memory.ghosts,
    flare: settings.light.flare,
    budget: Math.max(0, settings.motion.budget),
    motion: clamp01(settings.motion.amount),
  };
}

/** Цвет палитры 0..255 → 0..1 для шейдера. */
function toUnitRgb([r, g, b]: [number, number, number]): [number, number, number] {
  return [r / 255, g / 255, b / 255];
}
