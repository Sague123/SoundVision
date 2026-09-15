/**
 * Базовый слой: палитра и фон. Реагирует на тональность (мажор/минор) и
 * энергию, ведёт один медленный примитив в качестве «подложки».
 */

import { clamp01 } from '../audio/features.ts';
import type { CoverArt } from '../cover/cover-art.ts';
import type { Settings } from '../settings.ts';
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

  render(frame: Omit<RenderFrame, 'ctx' | 'params' | 'weight'>, state: GeneratorState, settings: Settings, cover: CoverArt): void {
    const { palette, mood } = frame;
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

    const gradient = ctx.createLinearGradient(0, 0, this.width * 0.35, this.height);
    gradient.addColorStop(0, palette.bgTop);
    gradient.addColorStop(1, palette.bgBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;

    const primitive = this.primitives.get(state.baseId);
    if (primitive && state.baseWeight > 0.01) {
      primitive.draw({
        ...frame,
        ctx,
        params: state.baseParams,
        weight: state.baseWeight,
      });
    }

    this.drawVignette(mood.energy);
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

  /** Виньетка собирает взгляд к центру и прячет края на большом экране. */
  private drawVignette(energy: number): void {
    const ctx = this.ctx;
    const radius = Math.hypot(this.width, this.height) / 2;
    const gradient = ctx.createRadialGradient(
      this.width / 2, this.height / 2, radius * 0.32,
      this.width / 2, this.height / 2, radius,
    );
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, `rgba(0,0,0,${(0.55 - energy * 0.2).toFixed(3)})`);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }
}
