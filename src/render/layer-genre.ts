/**
 * Жанровый слой: геометрия и движение. Здесь живёт весь активный набор
 * примитивов с их весами и калейдоскоп как модификатор поверх результата.
 */

import { clamp01 } from '../audio/features.ts';
import { createPrimitive } from './generator.ts';
import type { GeneratorState } from './generator.ts';
import type { DrawPrimitive, ModifierPrimitive, PrimitiveId, RenderFrame } from './primitives/types.ts';
import { ALL_PRIMITIVE_IDS } from './primitives/types.ts';
import type { GeneratorSeed } from './seed.ts';
import { RaymarchPrimitive } from './primitives/raymarch.ts';

/** Ниже этого веса примитив не рисуем: платить за кадр ради невидимого нет смысла. */
const MIN_VISIBLE_WEIGHT = 0.02;

export class GenreLayer {
  /** Персистентный холст со следами — в него рисуют примитивы. */
  private readonly content = document.createElement('canvas');
  private readonly contentCtx: CanvasRenderingContext2D;
  /** Выход слоя: либо content напрямую, либо отражённая калейдоскопом копия. */
  private readonly output = document.createElement('canvas');
  private readonly outputCtx: CanvasRenderingContext2D;

  private readonly drawables = new Map<PrimitiveId, DrawPrimitive>();
  private readonly modifiers = new Map<PrimitiveId, ModifierPrimitive>();
  private width = 1;
  private height = 1;
  private usingModifier = false;

  constructor() {
    const contentCtx = this.content.getContext('2d');
    const outputCtx = this.output.getContext('2d');
    if (!contentCtx || !outputCtx) throw new Error('2D-контекст недоступен');
    this.contentCtx = contentCtx;
    this.outputCtx = outputCtx;

    for (const id of ALL_PRIMITIVE_IDS) {
      const primitive = createPrimitive(id);
      if (primitive.kind === 'draw') this.drawables.set(id, primitive);
      else this.modifiers.set(id, primitive);
    }
  }

  get canvas(): HTMLCanvasElement {
    return this.usingModifier ? this.output : this.content;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    for (const canvas of [this.content, this.output]) {
      canvas.width = width;
      canvas.height = height;
    }
    for (const primitive of this.drawables.values()) primitive.resize(width, height);
    for (const primitive of this.modifiers.values()) primitive.resize(width, height);
  }

  reseed(seed: GeneratorSeed): void {
    for (const primitive of this.drawables.values()) primitive.reseed(seed);
    for (const primitive of this.modifiers.values()) primitive.reseed(seed);
  }

  /** Разрешение raymarch-шейдера: единственный примитив, который заметно зависит от него. */
  setQuality(scale: number): void {
    const raymarch = this.drawables.get('raymarch');
    if (raymarch instanceof RaymarchPrimitive) raymarch.setQuality(scale);
  }

  /** @returns примитивы, реально нарисованные в этом кадре — для дебаг-оверлея. */
  render(frame: Omit<RenderFrame, 'ctx' | 'params' | 'weight'>, state: GeneratorState): PrimitiveId[] {
    const ctx = this.contentCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // destination-out гасит старое, не подмешивая цвет: слой остаётся прозрачным.
    const fadeRate = 0.8 + (1 - state.genreParams.trail) * 28;
    const fade = clamp01(1 - Math.exp(-(frame.dtMs / 1000) * fadeRate));
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(0,0,0,${fade.toFixed(4)})`;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'source-over';

    const active: PrimitiveId[] = [];
    for (const [id, primitive] of this.drawables) {
      const weight = state.weights.get(id) ?? 0;
      if (weight < MIN_VISIBLE_WEIGHT) continue;
      if (primitive instanceof RaymarchPrimitive && !primitive.available) continue;
      primitive.draw({ ...frame, ctx, params: state.genreParams, weight });
      active.push(id);
    }

    const kaleidoscope = this.modifiers.get('kaleidoscope');
    this.usingModifier = Boolean(kaleidoscope) && state.kaleidoscopeWeight > MIN_VISIBLE_WEIGHT;
    if (kaleidoscope && this.usingModifier) {
      this.outputCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.outputCtx.globalCompositeOperation = 'source-over';
      this.outputCtx.globalAlpha = 1;
      kaleidoscope.apply(
        { ...frame, ctx: this.outputCtx, params: state.genreParams, weight: clamp01(state.kaleidoscopeWeight) },
        this.content,
      );
      active.push('kaleidoscope');
    }
    return active;
  }

  dispose(): void {
    for (const primitive of this.drawables.values()) primitive.dispose();
    for (const primitive of this.modifiers.values()) primitive.dispose();
    this.drawables.clear();
    this.modifiers.clear();
  }
}
