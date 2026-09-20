/**
 * Базовый слой: палитра и фон. Реагирует на тональность (мажор/минор) и
 * энергию, ведёт один медленный примитив в качестве «подложки».
 */

import { clamp01 } from '../audio/features.ts';
import type { CoverArt } from '../cover/cover-art.ts';
import type { Settings } from '../settings.ts';
import type { Light } from './scene.ts';
import { createPrimitive } from './generator.ts';
import type { GeneratorState } from './generator.ts';
import { BASE_LAYER_IDS } from './generator.ts';
import type { DrawPrimitive, PrimitiveId, RenderFrame } from './primitives/types.ts';
import type { GeneratorSeed } from './seed.ts';

export class BaseLayer {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly primitives = new Map<PrimitiveId, DrawPrimitive>();
  private width = 1;
  private height = 1;

  constructor() {
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D-контекст недоступен');
    this.ctx = ctx;
    for (const id of BASE_LAYER_IDS) {
      const primitive = createPrimitive(id);
      if (primitive.kind === 'draw') this.primitives.set(id, primitive);
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    for (const primitive of this.primitives.values()) primitive.resize(width, height);
  }

  reseed(seed: GeneratorSeed): void {
    for (const primitive of this.primitives.values()) primitive.reseed(seed);
  }

  render(frame: Omit<RenderFrame, 'ctx' | 'params' | 'weight' | 'tuning'>, state: GeneratorState, settings: Settings, cover: CoverArt): void {
    const { palette, mood, scene } = frame;
    const ctx = this.ctx;

    // Заливка фоном служит и очисткой, и затуханием следов: чем ниже alpha,
    // тем дольше живут прошлые кадры.
    const fade = clamp01(0.05 + (1 - state.baseParams.trail) * 0.95);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = fade;

    if (settings.cover.useAsBackground && cover.image) {
      this.drawCover(cover.image, mood.energy);
      ctx.globalAlpha = fade * 0.72; // градиент поверх обложки, но не вместо неё
    }

    // Градиент фона направлен от источника света — он обходит сцену по орбите,
    // поэтому «освещённая сторона» медленно едет вместе с ним.
    const reach = Math.hypot(this.width, this.height) * 0.5;
    const lx = Math.cos(scene.light.angle) * reach;
    const ly = Math.sin(scene.light.angle) * reach;
    const gradient = ctx.createLinearGradient(
      this.width / 2 - lx, this.height / 2 - ly,
      this.width / 2 + lx, this.height / 2 + ly,
    );
    gradient.addColorStop(0, palette.bgTop);
    gradient.addColorStop(1, palette.bgBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;

    const primitive = this.primitives.get(state.baseId);
    if (primitive && state.baseWeight > 0.01) {
      /*
       * Вклад за кадр делится на затухание.
       *
       * Слой со следами копит: если каждый кадр добавлять `baseWeight`, а
       * гасить на `fade`, установившаяся яркость выходит `baseWeight / fade`
       * — при длинных следах это единица, то есть белое. Из-за этого фон
       * светил наравне с соло, хотя по иерархии ролей ему положено 5-10%.
       * С делением установившееся значение равно ровно `baseWeight`.
       */
      primitive.draw({
        ...frame,
        ctx,
        params: state.baseParams,
        tuning: state.tunings.get(state.baseId) ?? {},
        weight: state.baseWeight * fade,
      });
    }

    // Вспышка раньше заливала аддитивным прямоугольником весь кадр — это
    // поднимало яркость каждого пикселя разом и делало картинку мутной.
    // Теперь она локальная: свечение вокруг самого источника света, а общий
    // отклик на удар несёт дыхание экспозиции в проходе света.
    if (scene.light.flash > 0.01) {
      const x = scene.light.x * this.width;
      const y = scene.light.y * this.height;
      const radius = Math.min(this.width, this.height) * (0.25 + scene.light.flash * 0.35);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, palette.accentAlpha(scene.light.warmth, Math.min(0.3, scene.light.flash * 0.3)));
      glow.addColorStop(1, palette.accentAlpha(scene.light.warmth, 0));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }

    this.drawVignette(mood.energy, scene.light);
  }

  dispose(): void {
    for (const primitive of this.primitives.values()) primitive.dispose();
    this.primitives.clear();
  }

  /** Обложка растягивается «по короткой стороне» и размывается — это фон, не картинка. */
  private drawCover(image: HTMLImageElement, energy: number): void {
    const ctx = this.ctx;
    const scale = Math.max(this.width / image.width, this.height / image.height) * 1.08;
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.save();
    ctx.filter = `blur(${(28 + energy * 18).toFixed(0)}px) saturate(1.4) brightness(0.55)`;
    ctx.drawImage(image, (this.width - w) / 2, (this.height - h) / 2, w, h);
    ctx.filter = 'none';
    ctx.restore();
  }

  /**
   * Виньетка собирает взгляд к центру и прячет края на большом экране.
   * Её центр смещён к источнику света: тень падает с противоположной стороны.
   */
  private drawVignette(energy: number, light: Light): void {
    const ctx = this.ctx;
    const radius = Math.hypot(this.width, this.height) / 2;
    const shiftX = Math.cos(light.angle) * this.width * 0.06;
    const shiftY = Math.sin(light.angle) * this.height * 0.06;
    const gradient = ctx.createRadialGradient(
      this.width / 2 + shiftX, this.height / 2 + shiftY, radius * 0.32,
      this.width / 2, this.height / 2, radius,
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    // Слабая: основную виньетку теперь ведёт проход света, и она динамическая.
    // Эта остаётся страховкой на случай, когда пост-конвейер недоступен.
    gradient.addColorStop(1, `rgba(0,0,0,${(0.26 - energy * 0.1).toFixed(3)})`);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }
}
