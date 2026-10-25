/**
 * OKLCH и преобразование в sRGB.
 *
 * Зачем не HSL: интерполяция в HSL/RGB проходит через грязно-серые
 * промежуточные цвета, а одинаковая «светлота» у разных оттенков выглядит
 * по-разному яркой. OKLab перцептивно равномерен, поэтому переход между двумя
 * акцентами остаётся чистым, а L действительно означает воспринимаемую яркость.
 *
 * Матрицы — Björn Ottosson, https://bottosson.github.io/posts/oklab/
 */

export interface Oklch {
  /** Светлота, 0..1. */
  l: number;
  /** Хрома (насыщенность), 0..~0.37 в пределах sRGB. */
  c: number;
  /** Оттенок в градусах, 0..360. */
  h: number;
}

export type Rgb = [number, number, number];

/** Сколько шагов деления отрезка тратим на подгонку хромы в охват sRGB. */
const GAMUT_STEPS = 12;

export function oklch(l: number, c: number, h: number): Oklch {
  return { l, c, h };
}

export function normalizeHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/**
 * Смешивание оттенков по кратчайшей дуге.
 * Через 0° иначе делается полный оборот по кругу вместо короткого шага.
 */
export function mixHue(a: number, b: number, t: number): number {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return normalizeHue(a + diff * t);
}

export function mixOklch(a: Oklch, b: Oklch, t: number): Oklch {
  return {
    l: a.l + (b.l - a.l) * t,
    c: a.c + (b.c - a.c) * t,
    h: mixHue(a.h, b.h, t),
  };
}

/** OKLCH → линейный sRGB. Значения могут выйти за 0..1 — это выход за охват. */
function toLinearRgb(color: Oklch): Rgb {
  const hueRad = (normalizeHue(color.h) * Math.PI) / 180;
  const a = color.c * Math.cos(hueRad);
  const b = color.c * Math.sin(hueRad);

  const lRoot = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = color.l - 0.0894841775 * a - 1.291485548 * b;

  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut([r, g, b]: Rgb): boolean {
  const limit = 1.0001; // допуск на ошибку округления в матрицах
  return r >= -0.0001 && r <= limit && g >= -0.0001 && g <= limit && b >= -0.0001 && b <= limit;
}

function gammaEncode(value: number): number {
  const clamped = value <= 0 ? 0 : value >= 1 ? 1 : value;
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/**
 * OKLCH → sRGB 0..255 с приведением в охват.
 *
 * Хрома снижается делением отрезка при сохранении L и H: так цвет теряет
 * насыщенность, но не «уезжает» в другой оттенок и не темнеет, как при
 * простом обрезании каналов.
 */
export function oklchToRgb(color: Oklch): Rgb {
  const l = color.l < 0 ? 0 : color.l > 1 ? 1 : color.l;
  let linear = toLinearRgb({ l, c: color.c, h: color.h });

  if (!inGamut(linear)) {
    let low = 0;
    let high = color.c;
    for (let i = 0; i < GAMUT_STEPS; i++) {
      const mid = (low + high) / 2;
      if (inGamut(toLinearRgb({ l, c: mid, h: color.h }))) low = mid;
      else high = mid;
    }
    linear = toLinearRgb({ l, c: low, h: color.h });
  }

  return [
    Math.round(gammaEncode(linear[0]) * 255),
    Math.round(gammaEncode(linear[1]) * 255),
    Math.round(gammaEncode(linear[2]) * 255),
  ];
}

export function rgbToCss([r, g, b]: Rgb): string {
  return `rgb(${r} ${g} ${b})`;
}

export function rgbToCssAlpha([r, g, b]: Rgb, alpha: number): string {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

export function oklchToCss(color: Oklch): string {
  return rgbToCss(oklchToRgb(color));
}

/** sRGB 0..255 → OKLCH. Нужен, чтобы затащить цвета обложки в ту же систему. */
export function rgbToOklch(r: number, g: number, b: number): Oklch {
  const lr = gammaDecode(r / 255);
  const lg = gammaDecode(g / 255);
  const lb = gammaDecode(b / 255);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const labL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    l: labL,
    c: Math.hypot(labA, labB),
    h: normalizeHue((Math.atan2(labB, labA) * 180) / Math.PI),
  };
}

function gammaDecode(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}
