import { SimplexNoise } from '../noise.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

const MAX_PARTICLES = 2600;
const COLOR_BANDS = 6;
const TAU = Math.PI * 2;

/**
 * Частицы, которых несёт поле симплекс-шума. Самый «читаемый» примитив:
 * хорошо показывает и темп, и настроение, и служит подложкой для остальных.
 */
export class FlowFieldPrimitive implements DrawPrimitive {
  readonly id = 'flow-field' as const;
  readonly kind = 'draw' as const;

  private noise = new SimplexNoise();
  private readonly xs = new Float32Array(MAX_PARTICLES);
  private readonly ys = new Float32Array(MAX_PARTICLES);
  private readonly ages = new Float32Array(MAX_PARTICLES);
  private readonly lives = new Float32Array(MAX_PARTICLES);
  private width = 1;
  private height = 1;
  private phase = 0;
  private rng = mulberry32(1);

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    for (let i = 0; i < MAX_PARTICLES; i++) this.respawn(i);
  }

  reseed(seed: GeneratorSeed): void {
    this.rng = mulberry32(seed.seed ^ 0x9e3779b9);
    this.noise = new SimplexNoise(this.rng);
    this.phase = seed.phase['flow-field'];
    for (let i = 0; i < MAX_PARTICLES; i++) this.respawn(i);
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, params, mood, palette, weight } = frame;
    const count = Math.floor(MAX_PARTICLES * (0.18 + params.density * 0.82) * (0.35 + weight * 0.65));
    if (count <= 0) return;

    const dt = Math.min(0.05, frame.dtMs / 1000);
    const t = (frame.timeMs / 1000) * (0.05 + params.speed * 0.35) + this.phase;
    // Крупный scale — длинные плавные «реки», мелкий — рваная турбулентность.
    const fieldScale = 0.0016 + (1 - params.scale) * 0.007;
    const turbulence = 1 + params.chaos * 2.4;
    const velocity = 30 + params.speed * 230 + mood.energy * 260;
    const step = velocity * dt;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.6 + mood.energy * 2.2 + params.sharpness * 0.8;

    const bandSize = Math.ceil(count / COLOR_BANDS);
    for (let band = 0; band < COLOR_BANDS; band++) {
      const from = band * bandSize;
      const to = Math.min(count, from + bandSize);
      if (from >= to) break;

      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const x = this.xs[i];
        const y = this.ys[i];
        const angle = this.noise.noise3D(x * fieldScale, y * fieldScale, t) * TAU * turbulence;
        const nx = x + Math.cos(angle) * step;
        const ny = y + Math.sin(angle) * step;

        ctx.moveTo(x, y);
        ctx.lineTo(nx, ny);

        this.xs[i] = nx;
        this.ys[i] = ny;
        this.ages[i] += dt;

        const outside = nx < -40 || nx > this.width + 40 || ny < -40 || ny > this.height + 40;
        if (outside || this.ages[i] > this.lives[i]) this.respawn(i);
      }
      // Оттенок ведём и по полосе, и по фазе доли — на битах палитра «дышит».
      const tone = (band / COLOR_BANDS + mood.beatPhase * 0.12) % 1;
      ctx.strokeStyle = palette.accentAlpha(tone, (0.14 + mood.energy * 0.5) * weight);
      ctx.stroke();
    }
    ctx.restore();
  }

  private respawn(index: number): void {
    this.xs[index] = this.rng() * this.width;
    this.ys[index] = this.rng() * this.height;
    this.ages[index] = 0;
    this.lives[index] = 1.5 + this.rng() * 4;
  }
}
