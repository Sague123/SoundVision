import { ContourBuilder, strokeContour } from '../contour.ts';
import { mulberry32, type GeneratorSeed, type Rng } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

const GRID_LONG_SIDE = 128;

/**
 * Наборы правил «рождение/выживание». Классический Life скучен на музыке,
 * поэтому в пуле ещё несколько живучих и «дышащих» автоматов.
 */
const RULE_SETS: Array<{ birth: number[]; survive: number[] }> = [
  { birth: [3], survive: [2, 3] }, // Conway
  { birth: [3, 6], survive: [2, 3] }, // HighLife
  { birth: [3, 5, 6, 7, 8], survive: [5, 6, 7, 8] }, // Diamoeba
  { birth: [3, 4], survive: [3, 4] }, // 34 Life
  { birth: [2], survive: [] }, // Seeds — взрывной, хорош на дропах
];

/**
 * Клеточный автомат с «тепловым» следом: живые клетки нагревают буфер,
 * он остывает экспоненциально, поэтому переходы плавные, а не мигающие.
 *
 * Рисуется не заливкой сетки, а контуром теплового поля плюс точками на
 * живых клетках: раньше сетка 128 клеток растягивалась на весь кадр и давала
 * крупные блоки, теперь линии и точки идут в физическом разрешении экрана.
 */
export class CellularPrimitive implements DrawPrimitive {
  readonly id = 'cellular' as const;
  readonly kind = 'draw' as const;

  private cols = 1;
  private rows = 1;
  private cells = new Uint8Array(1);
  private next = new Uint8Array(1);
  private heat = new Float32Array(1);
  private readonly contour = new ContourBuilder(6000);
  private width = 1;
  private height = 1;
  private rule = RULE_SETS[0];
  private rng: Rng = mulberry32(1);
  private nextStepMs = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const aspect = width / Math.max(1, height);
    this.cols = Math.max(16, Math.round(aspect >= 1 ? GRID_LONG_SIDE : GRID_LONG_SIDE * aspect));
    this.rows = Math.max(16, Math.round(aspect >= 1 ? GRID_LONG_SIDE / aspect : GRID_LONG_SIDE));

    const size = this.cols * this.rows;
    this.cells = new Uint8Array(size);
    this.next = new Uint8Array(size);
    this.heat = new Float32Array(size);
    this.randomize(0.28);
  }

  reseed(seed: GeneratorSeed): void {
    this.rng = mulberry32(seed.seed ^ 0x165667b1);
    this.rule = RULE_SETS[Math.floor(this.rng() * RULE_SETS.length)];
    this.randomize(0.28);
    this.nextStepMs = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight } = frame;

    // Шаг автомата привязан к темпу: сетка «идёт» вместе с треком.
    const beatMs = 60000 / Math.max(40, mood.bpm);
    const divisions = Math.max(1, Math.round((1 + params.speed * 3) * frame.tuning.speed));
    const stepMs = Math.max(45, beatMs / divisions);

    if (frame.timeMs >= this.nextStepMs) {
      this.nextStepMs = frame.timeMs + stepMs;
      this.step();
    }
    // Удар подсыпает живых клеток — иначе автомат быстро вырождается.
    if (mood.onset) this.inject(0.02 + mood.onsetStrength * 0.08);

    const cool = Math.exp(-(frame.dtMs / 1000) * (1.6 + (1 - params.trail) * 5));
    for (let i = 0; i < this.heat.length; i++) this.heat[i] *= cool;

    const scaleX = this.width / (this.cols - 1);
    const scaleY = this.height / (this.rows - 1);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    // Контур тёплой области: границы живых скоплений, а не сами клетки.
    this.contour.build(this.heat, this.cols, this.rows,
      0.18 + params.sharpness * 0.15 + frame.tuning.birth * 0.3);
    if (this.contour.length > 0) {
      ctx.lineWidth = Math.max(1, 0.8 + params.sharpness * 0.7);
      ctx.strokeStyle = palette.accentAlpha(0.45, (0.22 + mood.energy * 0.28) * weight);
      strokeContour(ctx, this.contour, scaleX, scaleY);
    }

    // Точки на живых клетках — та самая мелкая деталь, которая читается
    // только в нативном разрешении.
    const dotSize = Math.max(1, Math.min(scaleX, scaleY) * 0.14 * frame.tuning.cellSize);
    if (frame.tuning.dots <= 0.02) {
      ctx.restore();
      return;
    }
    ctx.fillStyle = palette.accentAlpha(0.9,
      (0.18 + mood.energy * 0.25) * weight * frame.tuning.dots / 0.7);
    ctx.beginPath();
    for (let y = 0; y < this.rows; y++) {
      const rowOffset = y * this.cols;
      for (let x = 0; x < this.cols; x++) {
        if (this.cells[rowOffset + x] === 0) continue;
        ctx.moveTo(x * scaleX + dotSize, y * scaleY);
        ctx.arc(x * scaleX, y * scaleY, dotSize, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    ctx.restore();
  }

  private randomize(fill: number): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = this.rng() < fill ? 1 : 0;
      this.heat[i] = this.cells[i];
    }
  }

  private inject(fraction: number): void {
    const amount = Math.floor(this.cells.length * fraction);
    for (let i = 0; i < amount; i++) {
      const index = Math.floor(this.rng() * this.cells.length);
      this.cells[index] = 1;
      this.heat[index] = 1;
    }
  }

  private step(): void {
    const { cols, rows, cells, next, rule } = this;
    for (let y = 0; y < rows; y++) {
      const up = ((y - 1 + rows) % rows) * cols;
      const mid = y * cols;
      const down = ((y + 1) % rows) * cols;
      for (let x = 0; x < cols; x++) {
        const left = (x - 1 + cols) % cols;
        const right = (x + 1) % cols;
        const neighbours =
          cells[up + left] + cells[up + x] + cells[up + right] +
          cells[mid + left] + cells[mid + right] +
          cells[down + left] + cells[down + x] + cells[down + right];
        const alive = cells[mid + x] === 1;
        const survives = alive ? rule.survive.includes(neighbours) : rule.birth.includes(neighbours);
        next[mid + x] = survives ? 1 : 0;
      }
    }
    this.cells.set(next);
    for (let i = 0; i < this.heat.length; i++) {
      if (this.cells[i] === 1) this.heat[i] = 1;
    }
  }

}

