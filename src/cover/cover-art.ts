/**
 * Загрузка обложки и извлечение из неё доминирующего цвета для палитры.
 * Всё best-effort: если CORS не дал прочитать пиксели, просто остаёмся
 * без цвета — фон и палитра работают и без обложки.
 */

export interface CoverArt {
  url: string;
  image: HTMLImageElement | null;
  /** Доминирующий оттенок в градусах, null — прочитать не удалось. */
  hue: number | null;
  saturation: number | null;
}

const EMPTY: CoverArt = { url: '', image: null, hue: null, saturation: null };
const SAMPLE_SIZE = 48;

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
      const dominant = extractDominant(image);
      this.current = { url, image, hue: dominant?.hue ?? null, saturation: dominant?.saturation ?? null };
    } catch {
      if (this.pendingUrl !== url) return;
      this.current = { url, image: null, hue: null, saturation: null };
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
 * Гистограмма по оттенкам, взвешенная насыщенностью: серые пиксели почти
 * не влияют, иначе доминирующим цветом почти всегда оказывается фон обложки.
 */
function extractDominant(image: HTMLImageElement): { hue: number; saturation: number } | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return null; // canvas tainted — обложка без CORS-заголовков
  }

  const buckets = new Float64Array(36);
  const saturations = new Float64Array(36);
  for (let i = 0; i < data.length; i += 4) {
    const [hue, saturation, lightness] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (lightness < 0.12 || lightness > 0.94) continue; // почти чёрное и почти белое цвета не несут
    const bucket = Math.min(35, Math.floor(hue / 10));
    const weight = saturation * saturation;
    buckets[bucket] += weight;
    saturations[bucket] += saturation * weight;
  }

  let bestBucket = -1;
  let bestWeight = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] > bestWeight) {
      bestWeight = buckets[i];
      bestBucket = i;
    }
  }
  if (bestBucket < 0 || bestWeight < 1) return null;

  return {
    hue: bestBucket * 10 + 5,
    saturation: Math.min(100, (saturations[bestBucket] / bestWeight) * 100),
  };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];

  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) hue = ((bn - rn) / delta + 2) / 6;
  else hue = ((rn - gn) / delta + 4) / 6;
  return [hue * 360, saturation, lightness];
}
