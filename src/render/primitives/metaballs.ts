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
  tone: number;
}

/**
 * Слияние блобов. Настоящий threshold делается фильтром canvas
 * (blur + contrast) — это на порядок дешевле, чем marching squares на CPU.
 */
export class MetaballsPrimitive implements DrawPrimitive {
  readonly id = 'metaballs' as const;
  readonly kind = 'draw' as const;

  private noise = new SimplexNoise();
  private balls: Ball[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private buffer: CanvasRenderingContext2D | null = null;
  private width = 1;
  private height = 1;
  private phase = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const canvas = this.canvas ?? document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * DOWNSCALE));
    canvas.height = Math.max(1, Math.round(height * DOWNSCALE));
    this.canvas = canvas;
    this.buffer = canvas.getContext('2d');
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x51ed270b);
    this.noise = new SimplexNoise(rng);
    this.phase = seed.phase.metaballs;
    this.balls = Array.from({ length: MAX_BALLS }, () => ({
      seedX: rng() * 100,
      seedY: rng() * 100,
      radius: 0.5 + rng() * 0.9,
      tone: rng(),
    }));
  }

  dispose(): void {
    this.canvas = null;
    this.buffer = null;
  }

  draw(frame: RenderFrame): void {
    const buffer = this.buffer;
    const canvas = this.canvas;
    if (!buffer || !canvas) return;

    const { params, mood, palette, weight } = frame;
    const count = Math.max(3, Math.round(MAX_BALLS * (0.22 + params.density * 0.78)));
    const t = (frame.timeMs / 1000) * (0.06 + params.speed * 0.3) + this.phase;
    const w = canvas.width;
    const h = canvas.height;
    const baseRadius = (0.06 + params.scale * 0.16) * Math.min(w, h) * (0.75 + mood.energy * 0.7);

    buffer.setTransform(1, 0, 0, 1, 0, 0);
    buffer.clearRect(0, 0, w, h);
    // contrast режет размытые хвосты — чем выше sharpness, тем чётче граница слияния.
    buffer.filter = `blur(${(6 + params.scale * 10).toFixed(1)}px) contrast(${(6 + params.sharpness * 22).toFixed(1)})`;
    buffer.globalCompositeOperation = 'lighter';

    for (let i = 0; i < count; i++) {
      const ball = this.balls[i];
      const drift = 0.35 + params.chaos * 1.2;
      const x = (0.5 + this.noise.noise2D(ball.seedX, t * drift) * 0.52) * w;
      const y = (0.5 + this.noise.noise2D(ball.seedY, t * drift + 31.7) * 0.52) * h;
      const pulse = 1 + Math.sin(mood.beatPhase * Math.PI * 2 + i) * mood.energy * 0.25;
      const radius = baseRadius * ball.radius * pulse;

      const gradient = buffer.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, palette.accentAlpha(ball.tone, 1));
      gradient.addColorStop(0.65, palette.accentAlpha(ball.tone, 0.55));
      gradient.addColorStop(1, palette.accentAlpha(ball.tone, 0));
      buffer.fillStyle = gradient;
      buffer.beginPath();
      buffer.arc(x, y, radius, 0, Math.PI * 2);
      buffer.fill();
    }
    buffer.filter = 'none';

    const ctx = frame.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.45 + mood.energy * 0.5) * weight;
    ctx.drawImage(canvas, 0, 0, this.width, this.height);
    ctx.restore();
  }
}
