/**
 * Палитра в OKLCH.
 *
 * Всё строится от музыки: оттенок — от тоники по квинтовому кругу, температура —
 * от лада, хрома — от яркости тембра, светлота — от энергии (через контраст
 * фона и форм, а не общую яркость), ширина схемы — от секции.
 *
 * Движок держит состояние между кадрами: смена тональности или секции не
 * применяется мгновенно, а мигрирует за ~1.5 секунды. Плюс «дыхание» —
 * медленная осцилляция хромы и светлоты в темпе трека.
 */

import { clamp, clamp01 } from '../audio/features.ts';
import type { MoodVector } from '../audio/mood-vector.ts';
import type { CoverArt } from '../cover/cover-art.ts';
import {
  chromaScaleAt, complementOf, hueOffsetAt, spreadForSection,
  applyTemperature, tonicHue, type HarmonyScheme,
} from './color/harmony.ts';
import {
  mixHue, mixOklch, normalizeHue, oklchToRgb, rgbToCss, rgbToCssAlpha,
  type Oklch, type Rgb,
} from './color/oklch.ts';

export { HARMONY_SCHEMES, findHarmony, type HarmonyScheme } from './color/harmony.ts';

export const ACCENT_COUNT = 6;
/** Размер таблицы предпосчитанных цветов: accent() зовут сотни раз за кадр. */
const LUT_SIZE = 64;
/** Постоянная времени миграции палитры: ~95% перехода за 1.4 секунды. */
const MIGRATION_TAU = 0.47;

export interface Palette {
  /** Непрерывная выборка по палитре, t 0..1 (заворачивается по кругу). */
  accent(t: number): string;
  /** То же с альфой — для аддитивных заливок. */
  accentAlpha(t: number, alpha: number): string;
  /** То же числами: примитивы, пишущие в ImageData, не должны парсить строки. */
  accentRgb(t: number): Rgb;
  accents: string[];
  bgTop: string;
  bgBottom: string;
  /** Цвет текста песни. */
  ink: string;
  /** Текущий базовый оттенок — им же красится свет сцены. */
  hue: number;
  /** Комплементарный оттенок: цветовое эхо удара. */
  echoHue: number;
  /** Цвет эха заданной силы. */
  echo(strength: number, alpha: number): string;
}

export interface PaletteTuning {
  /** Ручной сдвиг всей палитры по кругу, градусы. */
  hueOffset: number;
  /** Множитель хромы, 0..2. */
  chromaBoost: number;
  /** Множитель светлоты форм, 0.5..1.5. */
  lightnessBoost: number;
  /** Сила температурного сдвига лада, 0..1. */
  temperature: number;
  /** Вес якоря обложки, 0..1. */
  coverWeight: number;
}

export function defaultTuning(): PaletteTuning {
  return { hueOffset: 0, chromaBoost: 1, lightnessBoost: 1, temperature: 0.18, coverWeight: 0.4 };
}

export interface PaletteInput {
  mood: MoodVector;
  tuning: PaletteTuning;
  /** Гармоническая схема; выбирается seed'ом трека. */
  harmony: HarmonyScheme;
  /** Небольшой сдвиг оттенка от seed'а — два трека в одной тональности не совпадают. */
  seedHueShift: number;
  cover: CoverArt;
  /** Учитывать ли цвета обложки. */
  useCover: boolean;
}

/** Плавно едущее скалярное значение — основа миграции палитры. */
class Drift {
  private value: number | null = null;

  update(target: number, k: number): number {
    this.value = this.value === null ? target : this.value + (target - this.value) * k;
    return this.value;
  }
}

/** То же для оттенка: по кратчайшей дуге, иначе смена тоники крутит полный круг. */
class HueDrift {
  private value: number | null = null;

  update(target: number, k: number): number {
    this.value = this.value === null ? target : mixHue(this.value, target, k);
    return this.value;
  }
}

export class PaletteEngine {
  private readonly hue = new HueDrift();
  private readonly chroma = new Drift();
  private readonly lightness = new Drift();
  private readonly bgLightness = new Drift();
  private readonly spread = new Drift();
  private readonly coverHue = new HueDrift();
  private readonly coverAmount = new Drift();

  /** Музыкальные часы: такт и фраза. Их не восстановить из beatPhase, он вертится. */
  private barPhase = 0;
  private phrasePhase = 0;

  build(input: PaletteInput): Palette {
    const { mood, tuning, harmony } = input;
    const dt = Math.min(0.1, mood.deltaMs / 1000);
    const k = 1 - Math.exp(-dt / MIGRATION_TAU);

    this.advanceClock(dt, mood.bpm);

    // --- оттенок: тоника по квинтовому кругу + температура лада ---
    const fromTonic = tonicHue(mood.key.tonic) + input.seedHueShift + tuning.hueOffset;
    const tempered = applyTemperature(fromTonic, mood.key.mode, tuning.temperature * mood.key.confidence);

    // --- якорь обложки ---
    const coverColors = input.useCover ? input.cover.colors : [];
    const anchor = coverColors[0] ?? null;
    // Чем меньше уверенность в тональности, тем охотнее слушаем обложку.
    const anchorTarget = anchor ? tuning.coverWeight * (0.6 + (1 - mood.key.confidence) * 0.4) : 0;
    const coverAmount = this.coverAmount.update(anchorTarget, k);
    const coverHue = this.coverHue.update(anchor?.h ?? tempered, k);
    const baseHue = normalizeHue(this.hue.update(mixHue(tempered, coverHue, anchorTarget * 0.7), k));

    // --- хрома от яркости тембра, светлота от энергии ---
    const breathChroma = 1 + Math.sin(this.barPhase * Math.PI * 2) * 0.07;
    const breathLight = Math.sin(this.phrasePhase * Math.PI * 2) * 0.025;

    const chromaTarget = (0.035 + mood.brightness * 0.15 + mood.flux * 0.02) * tuning.chromaBoost;
    const chroma = clamp(0.004, 0.33, this.chroma.update(chromaTarget, k) * breathChroma);

    // Энергия разводит фон и формы: формы светлее, фон темнее. Это контраст,
    // а не «сделать всё ярче» — иначе на дропе кадр просто выцветает.
    const formTarget = (0.5 + mood.energy * 0.3) * tuning.lightnessBoost;
    const formLightness = clamp(0.12, 0.95, this.lightness.update(formTarget, k) + breathLight);
    // Фон почти чёрный и остаётся таким. Серый или коричневый фон — это уже
    // заливка средними тонами, из-за неё кадр читается мутным независимо от
    // того, что нарисовано поверх. Яркость набирается линиями, а не фоном.
    const bgTarget = 0.05 - mood.energy * 0.018;
    const backgroundLightness = clamp(0.012, 0.075, this.bgLightness.update(bgTarget, k));

    const spread = this.spread.update(spreadForSection(mood.section), k);

    return this.assemble({
      harmony, baseHue, chroma, formLightness, backgroundLightness, spread,
      coverColors, coverAmount,
    });
  }

  /**
   * Такт — четыре доли, фраза — четыре такта. Дыхание палитры идёт по ним,
   * а не по каждому биту: на бите это читалось бы как мигание.
   */
  private advanceClock(dt: number, bpm: number): void {
    const beatsPerSecond = Math.max(0.5, bpm) / 60;
    this.barPhase = (this.barPhase + (dt * beatsPerSecond) / 4) % 1;
    this.phrasePhase = (this.phrasePhase + (dt * beatsPerSecond) / 16) % 1;
  }

  private assemble(input: {
    harmony: HarmonyScheme;
    baseHue: number;
    chroma: number;
    formLightness: number;
    backgroundLightness: number;
    spread: number;
    coverColors: Oklch[];
    coverAmount: number;
  }): Palette {
    const { harmony, baseHue, chroma, formLightness, backgroundLightness, spread } = input;

    const sample = (t: number): Oklch => {
      const wrapped = ((t % 1) + 1) % 1;
      const generated: Oklch = {
        l: clamp(0.08, 0.97, formLightness * (0.66 + wrapped * 0.6)),
        c: chroma * chromaScaleAt(harmony, wrapped),
        h: baseHue + hueOffsetAt(harmony, wrapped, spread),
      };
      return blendCover(generated, input.coverColors, input.coverAmount, wrapped);
    };

    // Таблица цветов на кадр: дальше accent() — это просто индексация.
    const lutRgb: Rgb[] = new Array(LUT_SIZE);
    const lutCss: string[] = new Array(LUT_SIZE);
    for (let i = 0; i < LUT_SIZE; i++) {
      lutRgb[i] = oklchToRgb(sample(i / (LUT_SIZE - 1)));
      lutCss[i] = rgbToCss(lutRgb[i]);
    }
    const indexOf = (t: number): number => {
      const wrapped = ((t % 1) + 1) % 1;
      return Math.min(LUT_SIZE - 1, Math.round(wrapped * (LUT_SIZE - 1)));
    };

    const accents: string[] = [];
    for (let i = 0; i < ACCENT_COUNT; i++) accents.push(lutCss[indexOf(i / (ACCENT_COUNT - 1))]);

    const bgTop = rgbToCss(oklchToRgb({
      l: backgroundLightness,
      c: chroma * 0.42,
      h: baseHue + hueOffsetAt(harmony, 0.15, spread) * 0.5,
    }));
    const bgBottom = rgbToCss(oklchToRgb({
      l: backgroundLightness * 0.4,
      c: chroma * 0.3,
      h: baseHue + hueOffsetAt(harmony, 0.85, spread) * 0.5,
    }));
    // Текст должен читаться поверх любой картинки: высокая светлота, низкая хрома.
    const ink = rgbToCss(oklchToRgb({ l: 0.96, c: Math.min(0.04, chroma * 0.3), h: baseHue }));

    const echoHue = complementOf(baseHue);

    return {
      accent: (t) => lutCss[indexOf(t)],
      accentRgb: (t) => lutRgb[indexOf(t)],
      accentAlpha: (t, alpha) => rgbToCssAlpha(lutRgb[indexOf(t)], alpha),
      accents,
      bgTop,
      bgBottom,
      ink,
      hue: baseHue,
      echoHue,
      echo: (strength, alpha) => rgbToCssAlpha(
        oklchToRgb({
          l: clamp(0.3, 0.95, formLightness * (1 + strength * 0.5)),
          c: clamp(0.02, 0.33, chroma * (1 + strength)),
          h: echoHue,
        }),
        alpha,
      ),
    };
  }
}

/**
 * Подмешивание доминантных цветов обложки. Точка t выбирает, к какому из
 * двух-трёх цветов тянуться, поэтому обложка задаёт характер всей палитры,
 * а не только базового оттенка.
 */
function blendCover(generated: Oklch, colors: Oklch[], amount: number, t: number): Oklch {
  if (colors.length === 0 || amount <= 0.001) return generated;

  const position = t * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(position));
  const target = colors.length === 1
    ? colors[0]
    : mixOklch(colors[index], colors[index + 1], position - index);

  // Светлоту обложки берём лишь частично: она задана печатью, а не музыкой.
  const anchored = mixOklch(generated, target, clamp01(amount));
  return { l: generated.l * 0.75 + anchored.l * 0.25, c: anchored.c, h: anchored.h };
}
