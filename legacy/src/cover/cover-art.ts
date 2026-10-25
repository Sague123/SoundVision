import { rgbToOklch, type Oklch } from '../render/color/oklch.ts';

/**
 * Загрузка обложки и извлечение из неё доминантных цветов для палитры.
 * Всё best-effort: если CORS не дал прочитать пиксели, просто остаёмся
 * без цвета — фон и палитра работают и без обложки.
 */

export interface CoverArt {
  url: string;
  image: HTMLImageElement | null;
  /**
   * Два-три доминантных цвета обложки в OKLCH, от самого весомого к менее.
   * Пустой массив — пиксели прочитать не удалось (CORS) или цвета в обложке нет.
   */
  colors: Oklch[];
}

const EMPTY: CoverArt = { url: '', image: null, colors: [] };
const SAMPLE_SIZE = 48;
/** Сколько доминантных цветов вытаскиваем: больше трёх палитре уже не нужно. */
const MAX_COLORS = 3;
/** Соседние по оттенку кластеры — это один и тот же цвет, схлопываем. */
const MERGE_DEGREES = 35;

export class CoverArtLoader {
  private current: CoverArt = EMPTY;
  private pendingUrl: string | null = null;

  get art(): CoverArt {
    return this.current;
  }

  /** Идемпотентно: повторный вызов с тем же URL ничего не делает. */
  async load(url: string | null): Promise<void> {
    if (!url) {
      this.current = EMPTY;
      this.pendingUrl = null;
      return;
    }
    if (url === this.current.url || url === this.pendingUrl) return;
    this.pendingUrl = url;

    try {
      const image = await loadImage(url);
      if (this.pendingUrl !== url) return; // трек успел смениться
      this.current = { url, image, colors: extractDominant(image) };
    } catch {
      if (this.pendingUrl !== url) return;
      this.current = { url, image: null, colors: [] };
    } finally {
      if (this.pendingUrl === url) this.pendingUrl = null;
    }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Без этого канвас «протухнет» и getImageData бросит SecurityError.
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cover load failed: ${url}`));
    image.src = url;
  });
}

/**
 * Гистограмма по оттенкам прямо в OKLCH, взвешенная хромой.
 *
 * Взвешивание нужно, чтобы серый фон обложки не побеждал по площади: почти
 * ахроматические пиксели почти не голосуют. Считается один раз на трек.
 */
function extractDominant(image: HTMLImageElement): Oklch[] {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return []; // canvas tainted — обложка без CORS-заголовков
  }

  const BUCKETS = 36;
  const weight = new Float64Array(BUCKETS);
  const sumL = new Float64Array(BUCKETS);
  const sumC = new Float64Array(BUCKETS);
  const sumSin = new Float64Array(BUCKETS);
  const sumCos = new Float64Array(BUCKETS);

  for (let i = 0; i < data.length; i += 4) {
    const color = rgbToOklch(data[i], data[i + 1], data[i + 2]);
    if (color.l < 0.12 || color.l > 0.96) continue; // почти чёрное и почти белое ничего не говорят
    const bucket = Math.min(BUCKETS - 1, Math.floor((color.h / 360) * BUCKETS));
    const vote = color.c * color.c;
    weight[bucket] += vote;
    sumL[bucket] += color.l * vote;
    sumC[bucket] += color.c * vote;
    // Оттенок усредняем через синус и косинус: среднее 350° и 10° — это 0°, а не 180°.
    const radians = (color.h * Math.PI) / 180;
    sumSin[bucket] += Math.sin(radians) * vote;
    sumCos[bucket] += Math.cos(radians) * vote;
  }

  const candidates: Array<{ color: Oklch; weight: number }> = [];
  for (let i = 0; i < BUCKETS; i++) {
    if (weight[i] < 0.5) continue;
    candidates.push({
      weight: weight[i],
      color: {
        l: sumL[i] / weight[i],
        c: sumC[i] / weight[i],
        h: ((Math.atan2(sumSin[i], sumCos[i]) * 180) / Math.PI + 360) % 360,
      },
    });
  }
  candidates.sort((a, b) => b.weight - a.weight);

  const picked: Oklch[] = [];
  for (const candidate of candidates) {
    if (picked.length >= MAX_COLORS) break;
    const tooClose = picked.some((chosen) => hueDistance(chosen.h, candidate.color.h) < MERGE_DEGREES);
    if (!tooClose) picked.push(candidate.color);
  }
  return picked;
}

function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}
