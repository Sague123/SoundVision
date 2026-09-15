import { SimplexNoise } from '../noise.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

const MAX_SITES = 42;
/** Длинная сторона поля расстояний. Дальше картинка растягивается с интерполяцией. */
const FIELD_LONG_SIDE = 168;
/** Поле пересчитывается на 30 Гц: ячейки двигаются медленно, разницы не видно. */
const FIELD_INTERVAL_MS = 33;

interface Site {
  seedX: number;
  seedY: number;
  tone: number;
  weight: number;
}

/**
 * Ячейки Вороного. Считаем поле ближайших сайтов в низком разрешении и
 * растягиваем — на CPU это единственный способ уложиться в 60 fps.
 */
export class VoronoiPrimitive implements DrawPrimitive {
  readonly id = 'voronoi' as const;
  readonly kind = 'draw' as const;

  private noise = new SimplexNoise();
  private sites: Site[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private buffer: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
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
    const fw = Math.max(16, Math.round(aspect >= 1 ? FIELD_LONG_SIDE : FIELD_LONG_SIDE * aspect));
    const fh = Math.max(16, Math.round(aspect >= 1 ? FIELD_LONG_SIDE / aspect : FIELD_LONG_SIDE));

    const canvas = this.canvas ?? document.createElement('canvas');
    canvas.width = fw;
    canvas.height = fh;
    this.canvas = canvas;
    this.buffer = canvas.getContext('2d', { willReadFrequently: false });
    this.image = this.buffer?.createImageData(fw, fh) ?? null;
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

  dispose(): void {
    this.canvas = null;
    this.buffer = null;
    this.image = null;
  }

  draw(frame: RenderFrame): void {
    const canvas = this.canvas;
    const buffer = this.buffer;
    const image = this.image;
    if (!canvas || !buffer || !image) return;

    if (frame.timeMs - this.lastFieldMs >= FIELD_INTERVAL_MS) {
      this.lastFieldMs = frame.timeMs;
      this.renderField(frame, image, canvas.width, canvas.height);
      buffer.putImageData(image, 0, 0);
    }

    const ctx = frame.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.24 + frame.mood.energy * 0.3) * frame.weight;
    ctx.imageSmoothingEnabled = true;
    // 'medium' достаточно: поле и так растягивается в 7-8 раз из мягкой картинки,
    // а 'high' на слабой встроенной графике заметно дороже.
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(canvas, 0, 0, this.width, this.height);
    ctx.restore();
  }

  private renderField(frame: RenderFrame, image: ImageData, fw: number, fh: number): void {
    const { params, mood, palette } = frame;
    const count = Math.max(4, Math.round(MAX_SITES * (0.14 + params.density * 0.86)));
    const t = (frame.timeMs / 1000) * (0.05 + params.speed * 0.28) + this.phase;
    const drift = 0.4 + params.chaos * 1.4;

    for (let i = 0; i < count; i++) {
      const site = this.sites[i];
      this.siteX[i] = (0.5 + this.noise.noise2D(site.seedX, t * drift) * 0.55) * fw;
      this.siteY[i] = (0.5 + this.noise.noise2D(site.seedY, t * drift + 17.3) * 0.55) * fh;
    }

    // Цвета ячеек считаем один раз на пересчёт поля, а не на каждый пиксель.
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < count; i++) colors.push(palette.accentRgb(this.sites[i].tone));

    // Чем выше sharpness, тем уже светящаяся граница между ячейками.
    const edgeWidth = 0.28 - params.sharpness * 0.22;
    const edgeGlow = 0.5 + mood.flux * 0.5;
    const data = image.data;

    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        let best = Infinity;
        let second = Infinity;
        let bestIndex = 0;
        for (let i = 0; i < count; i++) {
          const dx = x - this.siteX[i];
          const dy = y - this.siteY[i];
          const d = (dx * dx + dy * dy) * this.sites[i].weight;
          if (d < best) {
            second = best;
            best = d;
            bestIndex = i;
          } else if (d < second) {
            second = d;
          }
        }

        // Близость к границе: отношение расстояний до первого и второго сайта.
        const ratio = second > 0 ? Math.sqrt(best / second) : 0;
        const edge = ratio > 1 - edgeWidth ? (ratio - (1 - edgeWidth)) / (edgeWidth || 1e-6) : 0;
        const fill = 0.16 + edge * edge * edgeGlow;

        const [r, g, b] = colors[bestIndex];
        const offset = (y * fw + x) * 4;
        data[offset] = r * fill;
        data[offset + 1] = g * fill;
        data[offset + 2] = b * fill;
        data[offset + 3] = 255;
      }
    }
  }
}

