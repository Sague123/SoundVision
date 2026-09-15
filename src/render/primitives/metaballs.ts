import { SimplexNoise } from '../noise.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

const MAX_BALLS = 26;
/** Метаболлы рисуем в половинном разрешении: blur+contrast там заметно дешевле. */
const DOWNSCALE = 0.5;

interface Ball {
  seedX: number;
  seedY: number;
  radius: number;
}

/**
 * Слияние блобов.
 *
 * Порог делается фильтром canvas, а не marching squares — это на порядок
 * дешевле. Два неочевидных момента, от которых зависит, получится ли вообще
 * эффект слияния:
 *  - `contrast()` меняет RGB и не трогает альфу, поэтому поле рисуется белым
 *    по непрозрачному чёрному: мягкость должна жить в цвете, а не в прозрачности;
 *  - фильтр применяется к каждому вызову отрисовки, поэтому блобы сперва
 *    складываются в отдельном холсте и лишь потом переносятся одним `drawImage`
 *    с фильтром — иначе порог срабатывает на каждом блобе по отдельности и
 *    они не сливаются.
 */
export class MetaballsPrimitive implements DrawPrimitive {
  readonly id = 'metaballs' as const;
  readonly kind = 'draw' as const;

  private noise = new SimplexNoise();
  private balls: Ball[] = [];
  /** Сложенное поле блобов, до порога. */
  private field: HTMLCanvasElement | null = null;
  private fieldCtx: CanvasRenderingContext2D | null = null;
  /** Результат: поле после порога, окрашенное палитрой. */
  private canvas: HTMLCanvasElement | null = null;
  private buffer: CanvasRenderingContext2D | null = null;
  private width = 1;
  private height = 1;
  private phase = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const w = Math.max(1, Math.round(width * DOWNSCALE));
    const h = Math.max(1, Math.round(height * DOWNSCALE));

    const canvas = this.canvas ?? document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    this.canvas = canvas;
    this.buffer = canvas.getContext('2d');

    const field = this.field ?? document.createElement('canvas');
    field.width = w;
    field.height = h;
    this.field = field;
    this.fieldCtx = field.getContext('2d', { alpha: false });
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x51ed270b);
    this.noise = new SimplexNoise(rng);
    this.phase = seed.phase.metaballs;
    this.balls = Array.from({ length: MAX_BALLS }, () => ({
      seedX: rng() * 100,
      seedY: rng() * 100,
      radius: 0.5 + rng() * 0.9,
    }));
  }

  dispose(): void {
    this.canvas = null;
    this.buffer = null;
    this.field = null;
    this.fieldCtx = null;
  }

  draw(frame: RenderFrame): void {
    const buffer = this.buffer;
    const canvas = this.canvas;
    const fieldCtx = this.fieldCtx;
    const field = this.field;
    if (!buffer || !canvas || !fieldCtx || !field) return;

    const { params, mood, palette, weight } = frame;
    const count = Math.max(3, Math.round(MAX_BALLS * (0.22 + params.density * 0.78)));
    const t = (frame.timeMs / 1000) * (0.06 + params.speed * 0.3) + this.phase;
    const w = canvas.width;
    const h = canvas.height;
    // Радиус держим небольшим: крупные блобы мгновенно сливаются в одно пятно.
    const baseRadius = (0.035 + params.scale * 0.075) * Math.min(w, h) * (0.8 + mood.energy * 0.45);

    // 1. Складываем поле: белые блобы по чёрному, без фильтра.
    fieldCtx.setTransform(1, 0, 0, 1, 0, 0);
    fieldCtx.globalCompositeOperation = 'source-over';
    fieldCtx.filter = 'none';
    fieldCtx.fillStyle = '#000';
    fieldCtx.fillRect(0, 0, w, h);
    fieldCtx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < count; i++) {
      const ball = this.balls[i];
      const drift = 0.35 + params.chaos * 1.2;
      const x = (0.5 + this.noise.noise2D(ball.seedX, t * drift) * 0.52) * w;
      const y = (0.5 + this.noise.noise2D(ball.seedY, t * drift + 31.7) * 0.52) * h;
      const pulse = 1 + Math.sin(mood.beatPhase * Math.PI * 2 + i) * mood.energy * 0.25;
      const radius = baseRadius * ball.radius * pulse;

      const gradient = fieldCtx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, '#fff');
      gradient.addColorStop(0.55, '#6f6f6f');
      gradient.addColorStop(1, '#000');
      fieldCtx.fillStyle = gradient;
      fieldCtx.beginPath();
      fieldCtx.arc(x, y, radius, 0, Math.PI * 2);
      fieldCtx.fill();
    }

    // 2. Порог по всему полю разом: получается резкая граница слияния.
    const blurPx = Math.max(1.5, baseRadius * (0.34 - params.sharpness * 0.14));
    buffer.setTransform(1, 0, 0, 1, 0, 0);
    buffer.globalCompositeOperation = 'source-over';
    buffer.clearRect(0, 0, w, h);
    buffer.filter = `blur(${blurPx.toFixed(1)}px) contrast(${(7 + params.sharpness * 18).toFixed(1)})`;
    buffer.drawImage(field, 0, 0);
    buffer.filter = 'none';

    // 3. Красим: multiply по чёрному фону оставляет цвет только на блобах.
    buffer.globalCompositeOperation = 'multiply';
    const tint = buffer.createLinearGradient(0, 0, w, h);
    tint.addColorStop(0, palette.accent(0.15));
    tint.addColorStop(0.5, palette.accent(0.55));
    tint.addColorStop(1, palette.accent(0.95));
    buffer.fillStyle = tint;
    buffer.fillRect(0, 0, w, h);
    buffer.globalCompositeOperation = 'source-over';

    const ctx = frame.ctx;
    ctx.save();
    // Фон поля чёрный, а при сложении чёрный ничего не добавляет — переносим как есть.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.35 + mood.energy * 0.35) * weight;
    ctx.drawImage(canvas, 0, 0, this.width, this.height);
    ctx.restore();
  }
}
