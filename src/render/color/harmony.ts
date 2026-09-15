/**
 * Привязка цвета к музыке: оттенок от тоники по квинтовому кругу и
 * гармонические схемы построения палитры от этого оттенка.
 */

import { NOTE_NAMES, type NoteName } from '../../audio/chroma.ts';
import { mixHue, normalizeHue } from './oklch.ts';

/**
 * Тоника → оттенок по квинтовому кругу, а не хроматически.
 *
 * Квинтовый круг: C G D A E B F# C# G# D# A# F. Позиция ноты n в нём — это
 * (n * 7) mod 12, потому что 7 обратно само себе по модулю 12. Родственные
 * тональности (до мажор и соль мажор) оказываются соседними цветами, поэтому
 * модуляция внутри трека даёт сдвиг оттенка, а не скачок через полкруга.
 */
export function tonicHue(tonic: NoteName): number {
  const chromatic = NOTE_NAMES.indexOf(tonic);
  if (chromatic < 0) return 0;
  const positionInFifths = (chromatic * 7) % 12;
  return positionInFifths * 30;
}

/** Тёплый полюс (янтарь/золото) и холодный (индиго) в координатах OKLCH. */
export const WARM_ANCHOR = 75;
export const COOL_ANCHOR = 252;

/**
 * Температура лада: мажор тянет палитру к тёплому полюсу, минор — к холодному.
 * Вес небольшой, чтобы тоника осталась главной, а лад читался как окраска.
 */
export function applyTemperature(hue: number, mode: 'major' | 'minor', amount: number): number {
  return mixHue(hue, mode === 'major' ? WARM_ANCHOR : COOL_ANCHOR, amount);
}

export interface HarmonyScheme {
  id: string;
  name: string;
  /**
   * Опорные смещения оттенка в градусах. Палитра интерполирует между ними,
   * а `spread` из секции сжимает или растягивает весь набор: на затишье
   * комплементарная схема превращается в аналоговую сама собой.
   */
  stops: number[];
  /** Множитель хромы на тех же опорных точках — чем схемы отличаются помимо оттенка. */
  chroma: number[];
}

export const HARMONY_SCHEMES: HarmonyScheme[] = [
  {
    id: 'analogous',
    name: 'Аналоговая',
    stops: [-34, -17, 0, 17, 34],
    chroma: [0.8, 0.95, 1, 0.95, 0.8],
  },
  {
    id: 'complementary',
    name: 'Комплементарная',
    stops: [0, 14, 166, 180],
    chroma: [1, 0.85, 0.85, 1],
  },
  {
    id: 'split-complementary',
    name: 'Сплит-комплементарная',
    stops: [0, 18, 150, 210],
    chroma: [1, 0.8, 0.9, 0.9],
  },
  {
    id: 'triadic',
    name: 'Триадная',
    stops: [0, 120, 240],
    chroma: [1, 0.88, 0.88],
  },
  {
    id: 'mono-accent',
    name: 'Монохромная с акцентом',
    // Почти весь диапазон — базовый оттенок; выделяется только последняя точка.
    stops: [0, 0, 6, 186],
    chroma: [0.32, 0.4, 0.5, 1],
  },
];

export function findHarmony(id: string): HarmonyScheme {
  return HARMONY_SCHEMES.find((scheme) => scheme.id === id) ?? HARMONY_SCHEMES[0];
}

/**
 * Смещение оттенка в точке t (0..1) выбранной схемы.
 * @param spread 0 — всё схлопывается в один оттенок, 1 — схема во всю ширину.
 */
export function hueOffsetAt(scheme: HarmonyScheme, t: number, spread: number): number {
  return sampleRamp(scheme.stops, t) * spread;
}

/** Множитель хромы в точке t выбранной схемы. */
export function chromaScaleAt(scheme: HarmonyScheme, t: number): number {
  return sampleRamp(scheme.chroma, t);
}

/** Линейная выборка из массива опорных точек по t 0..1. */
function sampleRamp(values: number[], t: number): number {
  if (values.length === 1) return values[0];
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const position = clamped * (values.length - 1);
  const index = Math.min(values.length - 2, Math.floor(position));
  const fraction = position - index;
  return values[index] + (values[index + 1] - values[index]) * fraction;
}

/** Ширина палитры по секции: затишье — узкий сектор, дроп — полный контраст. */
export function spreadForSection(section: 'calm' | 'steady' | 'buildup' | 'drop'): number {
  switch (section) {
    case 'calm': return 0.34;
    case 'steady': return 0.62;
    case 'buildup': return 0.8;
    case 'drop': return 1;
  }
}

/** Комплементарный оттенок — им красится цветовое эхо удара. */
export function complementOf(hue: number): number {
  return normalizeHue(hue + 180);
}
