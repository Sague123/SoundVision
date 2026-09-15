/**
 * Палитра строится непрерывно: схема (мажор/минор) + сдвиг от seed'а трека +
 * живая модуляция от mood vector. Никаких «переключений темы» — только дрейф.
 */

import type { MoodVector } from '../audio/mood-vector.ts';
import { clamp, clamp01 } from '../audio/features.ts';

export interface PaletteSpec {
  /** Базовый оттенок, градусы 0..360. */
  hue: number;
  /** Разброс оттенков между акцентами, градусы. */
  spread: number;
  saturation: number;
  lightness: number;
}

export interface ColorScheme {
  id: string;
  name: string;
  major: PaletteSpec;
  minor: PaletteSpec;
}

export const COLOR_SCHEMES: ColorScheme[] = [
  {
    id: 'aurora',
    name: 'Aurora',
    major: { hue: 160, spread: 80, saturation: 72, lightness: 58 },
    minor: { hue: 222, spread: 70, saturation: 64, lightness: 46 },
  },
  {
    id: 'ember',
    name: 'Ember',
    major: { hue: 36, spread: 60, saturation: 84, lightness: 56 },
    minor: { hue: 352, spread: 48, saturation: 66, lightness: 40 },
  },
  {
    id: 'neon',
    name: 'Neon',
    major: { hue: 300, spread: 120, saturation: 92, lightness: 60 },
    minor: { hue: 258, spread: 96, saturation: 80, lightness: 46 },
  },
  {
    id: 'tide',
    name: 'Tide',
    major: { hue: 190, spread: 64, saturation: 70, lightness: 56 },
    minor: { hue: 210, spread: 44, saturation: 44, lightness: 38 },
  },
  {
    id: 'mono',
    name: 'Mono',
    major: { hue: 45, spread: 20, saturation: 14, lightness: 66 },
    minor: { hue: 230, spread: 18, saturation: 12, lightness: 44 },
  },
];

export const ACCENT_COUNT = 6;

export interface Palette {
  bgTop: string;
  bgBottom: string;
  accents: string[];
  ink: string;
  hue: number;
  /** Непрерывная выборка по палитре, t 0..1 (заворачивается по кругу). */
  accent(t: number): string;
  /** То же, но с альфой — для аддитивных заливок. */
  accentAlpha(t: number, alpha: number): string;
}

export interface PaletteInput {
  scheme: ColorScheme;
  mood: MoodVector;
  /** Сдвиг оттенка от seed'а трека. */
  hueShift: number;
  /** Доминирующие оттенки обложки, если включено использование обложки. */
  coverHue: number | null;
  coverSaturation: number | null;
}

export function buildPalette(input: PaletteInput): Palette {
  const { scheme, mood, hueShift } = input;
  const spec = mood.key.mode === 'major' ? scheme.major : scheme.minor;

  // Обложка перетягивает оттенок тем сильнее, чем меньше мы уверены в тональности.
  const coverWeight = input.coverHue === null ? 0 : 0.45 + (1 - mood.key.confidence) * 0.25;
  const baseHue = input.coverHue === null
    ? spec.hue + hueShift
    : mixHue(spec.hue + hueShift, input.coverHue, coverWeight);

  // Яркий тембр уводит оттенок вперёд по кругу, энергия поднимает насыщенность.
  const hue = baseHue + (mood.brightness - 0.4) * 34 + mood.energySlope * 12;
  const saturation = clamp(8, 100,
    (input.coverSaturation ?? spec.saturation) * (0.82 + mood.energy * 0.4) + mood.flux * 10);
  const lightness = clamp(8, 82, spec.lightness * (0.72 + mood.energy * 0.5));

  const sectionLift = mood.section === 'drop' ? 1.18 : mood.section === 'calm' ? 0.72 : 1;

  const accents: string[] = [];
  for (let i = 0; i < ACCENT_COUNT; i++) {
    const t = i / (ACCENT_COUNT - 1);
    accents.push(hsl(
      hue + (t - 0.5) * spec.spread,
      clamp(6, 100, saturation * (0.85 + t * 0.3)),
      clamp(10, 92, lightness * sectionLift * (0.7 + t * 0.65)),
    ));
  }

  const bgLightness = clamp(2, 26, 4 + mood.energy * 10 + (mood.section === 'calm' ? 2 : 0));
  const bgTop = hsl(hue - spec.spread * 0.3, clamp(6, 70, saturation * 0.5), bgLightness);
  const bgBottom = hsl(hue + spec.spread * 0.35, clamp(6, 70, saturation * 0.35), bgLightness * 0.45);
  const ink = hsl(hue + 180, clamp(0, 30, saturation * 0.25), 94);

  const sample = (t: number): [number, number, number] => {
    const wrapped = ((t % 1) + 1) % 1;
    return [
      hue + (wrapped - 0.5) * spec.spread,
      clamp(6, 100, saturation * (0.85 + wrapped * 0.3)),
      clamp(10, 92, lightness * sectionLift * (0.7 + wrapped * 0.65)),
    ];
  };

  return {
    bgTop,
    bgBottom,
    accents,
    ink,
    hue,
    accent(t) {
      const [h, s, l] = sample(t);
      return hsl(h, s, l);
    },
    accentAlpha(t, alpha) {
      const [h, s, l] = sample(t);
      return `hsl(${normalizeHue(h).toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}% / ${clamp01(alpha).toFixed(3)})`;
    },
  };
}

export function hsl(h: number, s: number, l: number): string {
  return `hsl(${normalizeHue(h).toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
}

function normalizeHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Смешивание по кратчайшей дуге — иначе переход через 0° делает полный оборот. */
function mixHue(a: number, b: number, t: number): number {
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  return a + diff * clamp01(t);
}

export function findScheme(id: string): ColorScheme {
  return COLOR_SCHEMES.find((scheme) => scheme.id === id) ?? COLOR_SCHEMES[0];
}

/**
 * Разбор строки `hsl(h s% l%)` в RGB 0..255.
 * Нужен примитивам, которые пишут прямо в ImageData: там цвет нужен числами.
 */
export function parseHsl(color: string): [number, number, number] {
  const match = /hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)/.exec(color);
  if (!match) return [255, 255, 255];
  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  if (s === 0) {
    const value = Math.round(l * 255);
    return [value, value, value];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, h) * 255),
    Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  ];
}

function hueToChannel(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}
