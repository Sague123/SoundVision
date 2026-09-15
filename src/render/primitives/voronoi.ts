import { ContourBuilder, strokeContour } from '../contour.ts';
import { SimplexNoise } from '../noise.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

const MAX_SITES = 42;
/** Разрешение поля расстояний. Из него берётся только геометрия рёбер. */
const FIELD_LONG_SIDE = 190;
/** Поле пересчитывается на 30 Гц: ячейки двигаются медленно, разницы не видно. */
const FIELD_INTERVAL_MS = 33;

interface Site {
  seedX: number;
  seedY: number;
  tone: number;
  weight: number;
}

/**
 * Ячейки Вороного рёбрами, а не заливкой.
 *
 * Поле хранит отношение расстояний до первого и второго ближайших сайтов:
 * на самом ребре оно равно единице и падает к центрам ячеек. Изолиния этого
 * поля и есть сетка рёбер — тонкая, гладкая и в физическом разрешении экрана,
 * тогда как раньше поле растягивалось на весь кадр и давало блочную заливку.
 */
export class VoronoiPrimitive implements DrawPrimitive {
  readonly id = 'voronoi' as const;
  readonly kind = 'draw' as const;

  private noise = new SimplexNoise();
  private sites: Site[] = [];
  private field = new Float32Array(1);
  private readonly contour = new ContourBuilder(9000);
  private cols = 1;
  private rows = 1;
  private width = 1;
  private height = 1;
  private phase = 0;
  private lastFieldMs = 0;

  private readonly siteX = new Float32Array(MAX_SITES);
  private readonly siteY = new Float32Array(MAX_SITES);

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const aspect = width / Math.max(1, height);
    this.cols = Math.max(16, Math.round(aspect >= 1 ? FIELD_LONG_SIDE : FIELD_LONG_SIDE * aspect));
    this.rows = Math.max(16, Math.round(aspect >= 1 ? FIELD_LONG_SIDE / aspect : FIELD_LONG_SIDE));
    this.field = new Float32Array(this.cols * this.rows);
    this.lastFieldMs = 0;
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x27d4eb2f);
    this.noise = new SimplexNoise(rng);
    this.phase = seed.phase.voronoi;
    this.sites = Array.from({ length: MAX_SITES }, () => ({
      seedX: rng() * 100,
      seedY: rng() * 100,
      tone: rng(),
      weight: 0.7 + rng() * 0.6,
    }));
    this.lastFieldMs = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, params, mood, palette, weight } = frame;

    if (frame.timeMs - this.lastFieldMs >= FIELD_INTERVAL_MS) {
      this.lastFieldMs = frame.timeMs;
      this.buildField(frame);
    }

    // Чем выше sharpness, тем ближе изолиния к самому ребру, то есть тем тоньше
    // и резче сетка. Низкий sharpness даёт широкие мягкие «коридоры».
    // Порог ближе к единице — уже линия ребра.
    const level = 0.84 + params.sharpness * 0.11;
    this.contour.build(this.field, this.cols, this.rows, level);
    if (this.contour.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, 0.8 + params.sharpness * 0.8);
    ctx.strokeStyle = palette.accentAlpha(0.55, (0.35 + mood.energy * 0.45) * weight);
    strokeContour(ctx, this.contour, this.width / (this.cols - 1), this.height / (this.rows - 1));
    ctx.restore();
  }

  private buildField(frame: RenderFrame): void {
    const { params } = frame;
    const { cols, rows, field } = this;
    // Меньше сайтов — крупнее ячейки и меньше рёбер: сетка из сорока ячеек
    // на дропе закрывала кадр целиком.
    const count = Math.max(4, Math.round(MAX_SITES * (0.1 + params.density * 0.42)));
    const t = (frame.timeMs / 1000) * (0.05 + params.speed * 0.28) + this.phase;
    const drift = 0.4 + params.chaos * 1.4;

    for (let i = 0; i < count; i++) {
      const site = this.sites[i];
      this.siteX[i] = (0.5 + this.noise.noise2D(site.seedX, t * drift) * 0.55) * cols;
      this.siteY[i] = (0.5 + this.noise.noise2D(site.seedY, t * drift + 17.3) * 0.55) * rows;
    }

    for (let y = 0; y < rows; y++) {
      const rowOffset = y * cols;
      for (let x = 0; x < cols; x++) {
        let best = Infinity;
        let second = Infinity;
        for (let i = 0; i < count; i++) {
          const dx = x - this.siteX[i];
          const dy = y - this.siteY[i];
          const d = (dx * dx + dy * dy) * this.sites[i].weight;
          if (d < best) {
            second = best;
            best = d;
          } else if (d < second) {
            second = d;
          }
        }
        // Отношение расстояний: единица ровно на ребре, ноль в центре ячейки.
        field[rowOffset + x] = second > 0 ? Math.sqrt(best / second) : 0;
      }
    }
  }
}
