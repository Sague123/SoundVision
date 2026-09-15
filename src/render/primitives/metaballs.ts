import { ContourBuilder, strokeContour } from '../contour.ts';
import { SimplexNoise } from '../noise.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

const MAX_BALLS = 26;
/**
 * Разрешение скалярного поля. Оно грубое намеренно: из него достаётся только
 * геометрия контура, а рисуется контур линиями в физическом разрешении экрана.
 */
const FIELD_LONG_SIDE = 150;
/** Уровень изолинии: классический метаболл-порог суммы обратных квадратов. */
const ISO_LEVEL = 1;

interface Ball {
  seedX: number;
  seedY: number;
  radius: number;
}

/**
 * Слияние блобов в контурном виде.
 *
 * Раньше блобы рисовались заливкой через blur+contrast в половинном
 * разрешении: края ступенчатые, а кадр целиком залит средними тонами.
 * Теперь считается честное поле суммы обратных квадратов, из него берётся
 * изолиния, и она обводится тонкой линией. Заливка осталась как опция и
 * идёт очень приглушённо.
 */
export class MetaballsPrimitive implements DrawPrimitive {
  readonly id = 'metaballs' as const;
  readonly kind = 'draw' as const;

  private noise = new SimplexNoise();
  private balls: Ball[] = [];
  private field = new Float32Array(1);
  private readonly contour = new ContourBuilder(6000);
  private cols = 1;
  private rows = 1;
  private width = 1;
  private height = 1;
  private phase = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const aspect = width / Math.max(1, height);
    this.cols = Math.max(16, Math.round(aspect >= 1 ? FIELD_LONG_SIDE : FIELD_LONG_SIDE * aspect));
    this.rows = Math.max(16, Math.round(aspect >= 1 ? FIELD_LONG_SIDE / aspect : FIELD_LONG_SIDE));
    this.field = new Float32Array(this.cols * this.rows);
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

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, params, mood, palette, weight } = frame;
    const count = Math.max(3, Math.round(MAX_BALLS * (0.22 + params.density * 0.78)));
    const t = (frame.timeMs / 1000) * (0.06 + params.speed * 0.3) + this.phase;
    const radius = (0.05 + params.scale * 0.09) * Math.min(this.cols, this.rows)
      * (0.8 + mood.energy * 0.4);

    this.buildField(count, t, params.chaos, radius);

    const scaleX = this.width / (this.cols - 1);
    const scaleY = this.height / (this.rows - 1);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Несколько вложенных изолиний вместо одной заливки: получается «горбыль»
    // из тонких линий, где яркость набирается их сгущением, а не площадью.
    const shells = 1 + Math.round(params.density * 2);
    for (let shell = 0; shell < shells; shell++) {
      const level = ISO_LEVEL * (0.7 + shell * 0.45);
      this.contour.build(this.field, this.cols, this.rows, level);
      if (this.contour.length === 0) continue;
      const fade = 1 - shell / (shells + 0.5);
      ctx.strokeStyle = palette.accentAlpha(0.2 + shell * 0.2, (0.22 + mood.energy * 0.3) * fade * weight);
      ctx.lineWidth = Math.max(1, (0.9 + params.sharpness) * fade);
      strokeContour(ctx, this.contour, scaleX, scaleY);
    }
    ctx.restore();
  }

  /** Поле метаболлов: сумма обратных квадратов расстояний до центров. */
  private buildField(count: number, t: number, chaos: number, radius: number): void {
    const { cols, rows, field } = this;
    field.fill(0);
    const drift = 0.35 + chaos * 1.2;
    const radiusSquared = radius * radius;

    for (let i = 0; i < count; i++) {
      const ball = this.balls[i];
      const cx = (0.5 + this.noise.noise2D(ball.seedX, t * drift) * 0.52) * cols;
      const cy = (0.5 + this.noise.noise2D(ball.seedY, t * drift + 31.7) * 0.52) * rows;
      const scale = radiusSquared * ball.radius * ball.radius;

      // Ограничиваем вклад радиусом влияния: дальше он всё равно ничтожен,
      // а полный проход по сетке на каждый блоб был бы втрое дороже.
      const reach = radius * 2.6 * ball.radius;
      const x0 = Math.max(0, Math.floor(cx - reach));
      const x1 = Math.min(cols - 1, Math.ceil(cx + reach));
      const y0 = Math.max(0, Math.floor(cy - reach));
      const y1 = Math.min(rows - 1, Math.ceil(cy + reach));

      for (let y = y0; y <= y1; y++) {
        const dy = y - cy;
        const rowOffset = y * cols;
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx;
          const distanceSquared = dx * dx + dy * dy;
          field[rowOffset + x] += scale / (distanceSquared + 1);
        }
      }
    }
  }
}
