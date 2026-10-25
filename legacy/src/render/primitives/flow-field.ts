import { FlowField } from '../flow-field.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

const MAX_PARTICLES = 2600;
const COLOR_BANDS = 6;

/**
 * Частицы, которых несёт поле симплекс-шума. Самый «читаемый» примитив:
 * хорошо показывает и темп, и настроение, и служит подложкой для остальных.
 */
export class FlowFieldPrimitive implements DrawPrimitive {
  readonly id = 'flow-field' as const;
  readonly kind = 'draw' as const;

  private readonly xs = new Float32Array(MAX_PARTICLES);
  private readonly ys = new Float32Array(MAX_PARTICLES);
  private readonly ages = new Float32Array(MAX_PARTICLES);
  private readonly lives = new Float32Array(MAX_PARTICLES);
  private width = 1;
  private height = 1;
  private rng = mulberry32(1);
  /** Поле потока общее со всей сценой: его задаёт компоновщик. */
  private field = new FlowField();
  private readonly push = { x: 0, y: 0 };

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    for (let i = 0; i < MAX_PARTICLES; i++) this.respawn(i);
  }

  reseed(seed: GeneratorSeed): void {
    this.rng = mulberry32(seed.seed ^ 0x9e3779b9);
    for (let i = 0; i < MAX_PARTICLES; i++) this.respawn(i);
  }

  /** Поле потока приходит снаружи — одно на всю сцену, вместе с частицами. */
  useField(field: FlowField): void {
    this.field = field;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, params, mood, palette, weight } = frame;
    // Плотность заметно ниже прежней: кадр должен оставаться в основном
    // тёмным, а яркость набираться там, где линии сходятся.
    // Плотность растёт корнем, а не линейно: на пике линии должны сгущаться
    // в гребни, а не покрывать кадр целиком.
    const count = Math.floor(
      MAX_PARTICLES * (0.05 + Math.sqrt(params.density) * 0.28) * (0.35 + weight * 0.65)
      * frame.tuning.particles,
    );
    if (count <= 0) return;

    const dt = Math.min(0.05, frame.dtMs / 1000);
    const seconds = frame.timeMs / 1000;
    const turbulence = 1 + params.chaos * 2.4;
    const velocity = (30 + params.speed * 230 + mood.energy * 260) * frame.tuning.speed;
    const step = velocity * dt;

    // Фронты волн от ударов: вещество расталкивается там, где проходит волна.
    const waves = FlowField.prepareWaves(
      frame.scene.impulses, this.width, this.height, velocity, dt, frame.scene.impact.pressure,
    );

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // Одна-две физические точки: толстые линии заливают кадр площадью.
    ctx.lineWidth = Math.max(1, (1 + params.sharpness * 0.8) * frame.tuning.lineWidth);

    const bandSize = Math.ceil(count / COLOR_BANDS);
    for (let band = 0; band < COLOR_BANDS; band++) {
      const from = band * bandSize;
      const to = Math.min(count, from + bandSize);
      if (from >= to) break;

      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const x = this.xs[i];
        const y = this.ys[i];
        const angle = this.field.angleAt(
          x, y, seconds, params.speed, params.scale * frame.tuning.fieldScale, turbulence,
        );
        FlowField.pushAt(waves, x, y, this.push);
        const nx = x + Math.cos(angle) * step + this.push.x;
        const ny = y + Math.sin(angle) * step + this.push.y;

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
      ctx.strokeStyle = palette.accentAlpha(tone, (0.08 + mood.energy * 0.28) * weight);
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
