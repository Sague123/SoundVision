/**
 * Генеративный директор: решает, какие примитивы сейчас живут, с каким весом,
 * и с какими непрерывными параметрами. Здесь же живёт seed трека и морфинг.
 *
 * Ключевая идея: никаких дискретных пресетов. Набор активных примитивов —
 * верхушка непрерывного рейтинга «уместности», а веса едут к цели плавно.
 */

import type { MoodVector, Section } from '../audio/mood-vector.ts';
import { clamp, clamp01 } from '../audio/features.ts';
import type { SceneState } from './scene.ts';
import type { PrimitiveRole, Settings } from '../settings.ts';
import { makeSeed, mulberry32, type GeneratorSeed } from './seed.ts';
import { CellularPrimitive } from './primitives/cellular.ts';
import { OscilloscopePrimitive } from './primitives/oscilloscope.ts';
import { RadialWaveformPrimitive } from './primitives/radial-waveform.ts';
import { SpectrumPrimitive } from './primitives/spectrum.ts';
import { WaveMeshPrimitive } from './primitives/wave-mesh.ts';
import { WaveformTerrainPrimitive } from './primitives/waveform-terrain.ts';
import { FlowFieldPrimitive } from './primitives/flow-field.ts';
import { KaleidoscopePrimitive } from './primitives/kaleidoscope.ts';
import { LSystemPrimitive } from './primitives/l-system.ts';
import { MetaballsPrimitive } from './primitives/metaballs.ts';
import { RaymarchPrimitive } from './primitives/raymarch.ts';
import { VoronoiPrimitive } from './primitives/voronoi.ts';
import {
  ALL_PRIMITIVE_IDS,
  lerp,
  smoothstep,
  type DrawPrimitive,
  type GenParams,
  type ModifierPrimitive,
  type Primitive,
  type PrimitiveId,
} from './primitives/types.ts';
import { resolvePrimitiveParams, type Tuning } from './primitives/tuning.ts';

/** Базовый слой держит только дешёвые примитивы: он идёт фоном ко всему. */
const BASE_LAYER_IDS: PrimitiveId[] = ['flow-field', 'metaballs', 'voronoi'];

/**
 * Класс формы примитива. Нужен для правил совместимости: два линейных
 * примитива спорят между собой и дают кашу, линейный с точечным — нет.
 */
export type PrimitiveClass = 'line' | 'bar' | 'point' | 'volume' | 'modifier';

const PRIMITIVE_CLASS: Record<PrimitiveId, PrimitiveClass> = {
  'waveform-terrain': 'line',
  'wave-mesh': 'line',
  'radial-waveform': 'line',
  oscilloscope: 'line',
  spectrum: 'bar',
  'flow-field': 'line',
  'l-system': 'line',
  voronoi: 'line',
  metaballs: 'line',
  cellular: 'point',
  raymarch: 'volume',
  kaleidoscope: 'modifier',
};

/**
 * Можно ли поставить `accent` рядом с `solo`.
 *
 * Правило простое и жёсткое: одинаковые классы спорят, разные — дополняют.
 * Точечный акцент разрешён к любому соло: точки не конкурируют с линиями за
 * внимание, а подчёркивают их.
 */
export function isCompatible(solo: PrimitiveId, accent: PrimitiveId): boolean {
  const soloClass = PRIMITIVE_CLASS[solo];
  const accentClass = PRIMITIVE_CLASS[accent];
  if (accentClass === 'point') return true;
  return soloClass !== accentClass;
}

/** Роли и их доли визуального веса. */
export const ROLE_WEIGHT = { solo: 1, accent: 0.26, background: 0.1 } as const;

/**
 * Стартовая выдержка соло до первой смены. Дальше её задаёт раздел «Фокус»:
 * длительность соло — настройка, а не константа рендера.
 */
const SOLO_MIN_MS = 22_000;

/**
 * Место каждого примитива на оси агрегатного состояния вещества:
 * 0 — туман, 0.33 — жидкость, 0.66 — кристалл, 1 — плазма.
 * Это главный источник рейтинга: набор на экране — прямое следствие того,
 * из чего сейчас сделан мир.
 */
const SUBSTANCE_POSITION: Record<PrimitiveId, number> = {
  'waveform-terrain': 0.2,
  'wave-mesh': 0.3,
  'radial-waveform': 0.45,
  oscilloscope: 0.6,
  spectrum: 0.85,
  'flow-field': 0.05,
  'l-system': 0.26,
  metaballs: 0.36,
  voronoi: 0.66,
  cellular: 0.74,
  kaleidoscope: 0.78,
  raymarch: 0.97,
};

/** Насколько узко примитив держится своего места на оси. */
const SUBSTANCE_TOLERANCE = 0.42;

/** Кто сейчас какую роль играет. */
export interface FocusState {
  solo: PrimitiveId;
  accent: PrimitiveId | null;
  /** Уходящее соло во время перехода; null — перехода нет. */
  leaving: PrimitiveId | null;
  /** Сколько секунд соло уже держится. */
  soloHeldMs: number;
}

export interface GeneratorState {
  seed: GeneratorSeed;
  focus: FocusState;
  /**
   * Свои параметры каждого примитива, уже дополненные дефолтами и обрезанные
   * по диапазону. Слои берут их отсюда, а не из настроек напрямую: примитив
   * не должен знать ни про панель, ни про расширенный режим.
   */
  tunings: Map<PrimitiveId, Tuning>;
  baseParams: GenParams;
  genreParams: GenParams;
  /** Сглаженные веса примитивов жанрового слоя. */
  weights: Map<PrimitiveId, number>;
  /** Вес калейдоскопа как модификатора жанрового слоя, 0..1. */
  kaleidoscopeWeight: number;
  /** Примитив, который сейчас ведёт базовый слой. */
  baseId: PrimitiveId;
  baseWeight: number;
}

export function createPrimitive(id: PrimitiveId): Primitive {
  switch (id) {
    case 'waveform-terrain': return new WaveformTerrainPrimitive();
    case 'wave-mesh': return new WaveMeshPrimitive();
    case 'spectrum': return new SpectrumPrimitive();
    case 'radial-waveform': return new RadialWaveformPrimitive();
    case 'oscilloscope': return new OscilloscopePrimitive();
    case 'flow-field': return new FlowFieldPrimitive();
    case 'metaballs': return new MetaballsPrimitive();
    case 'voronoi': return new VoronoiPrimitive();
    case 'cellular': return new CellularPrimitive();
    case 'l-system': return new LSystemPrimitive();
    case 'raymarch': return new RaymarchPrimitive();
    case 'kaleidoscope': return new KaleidoscopePrimitive();
  }
}

export class Generator {
  private seedValue: GeneratorSeed;
  private salt = 0;
  private key = '';
  /** Случайное смещение рейтинга на каждый примитив — «характер» трека. */
  private bias = new Map<PrimitiveId, number>();
  private readonly weights = new Map<PrimitiveId, number>();
  private kaleidoscope = 0;
  private baseId: PrimitiveId = 'flow-field';
  private baseWeight = 0;
  private baseSwitchAt = 0;

  /** Фокус: ровно одно соло, максимум один акцент. */
  private solo: PrimitiveId = 'flow-field';
  private accent: PrimitiveId | null = null;
  private background: PrimitiveId | null = null;
  private leaving: PrimitiveId | null = null;
  private soloSince = 0;
  private leavingUntil = 0;
  private enteringUntil = 0;
  private soloHold = SOLO_MIN_MS;
  private prevSection: Section | null = null;

  constructor(trackKeyValue: string) {
    this.key = trackKeyValue;
    this.seedValue = makeSeed(trackKeyValue, this.salt);
    this.applySeedBias();
    for (const id of ALL_PRIMITIVE_IDS) this.weights.set(id, 0);
    this.solo = this.drawablePool()[0] ?? 'flow-field';
  }

  /**
   * Рисующие примитивы из пула трека, за вычетом выключенных в панели.
   * Если выключили всё, оставляем flow field: пустой кадр — не настройка,
   * а поломка.
   */
  private drawablePool(settings?: Settings): PrimitiveId[] {
    const enabled = (id: PrimitiveId): boolean =>
      id !== 'kaleidoscope' && (settings?.primitives[id]?.enabled ?? true);

    const pool = this.seedValue.pool.filter(enabled);
    if (pool.length > 0) return pool;

    // Пул трека выключили целиком — берём любой разрешённый примитив, а не
    // flow field вслепую: иначе выключенное всё равно оказывается на экране.
    const anyEnabled = ALL_PRIMITIVE_IDS.filter(enabled);
    if (anyEnabled.length > 0) return anyEnabled;

    // Выключено вообще всё. Пустой кадр — это не настройка, а поломка.
    return ['flow-field'];
  }

  get seed(): GeneratorSeed {
    return this.seedValue;
  }

  /** Новый трек — новый seed, но веса не обнуляем: переход остаётся плавным. */
  setTrack(trackKeyValue: string): boolean {
    if (trackKeyValue === this.key) return false;
    this.key = trackKeyValue;
    this.salt = 0;
    this.seedValue = makeSeed(trackKeyValue, this.salt);
    this.applySeedBias();
    return true;
  }

  /** Ручной «Reshuffle»: тот же трек, другая точка пространства. */
  reshuffle(): GeneratorSeed {
    this.salt++;
    this.seedValue = makeSeed(this.key, this.salt);
    this.applySeedBias();
    return this.seedValue;
  }

  update(mood: MoodVector, settings: Settings, scene: SceneState): GeneratorState {
    const dt = Math.min(0.1, mood.deltaMs / 1000);
    const morphRate = settings.generator.morphRate * this.seedValue.morphRate;
    // Кроссфейд: чем выше morphRate, тем быстрее веса догоняют цель.
    const k = 1 - Math.exp(-dt * 0.9 * morphRate);

    const targets = this.targetWeights(mood, settings, scene);
    for (const id of ALL_PRIMITIVE_IDS) {
      const current = this.weights.get(id) ?? 0;
      this.weights.set(id, lerp(current, targets.get(id) ?? 0, k));
    }

    const kaleidoscopeTarget = targets.get('kaleidoscope') ?? 0;
    this.kaleidoscope = lerp(this.kaleidoscope, kaleidoscopeTarget, k);

    this.updateBase(mood, settings, scene, k);

    return {
      seed: this.seedValue,
      tunings: this.tunings(settings),
      focus: {
        solo: this.solo,
        accent: this.accent,
        leaving: this.leaving,
        soloHeldMs: mood.timeMs - this.soloSince,
      },
      baseParams: this.baseLayerParams(mood, scene),
      genreParams: this.genreLayerParams(mood, scene),
      weights: this.weights,
      kaleidoscopeWeight: this.kaleidoscope,
      baseId: this.baseId,
      baseWeight: this.baseWeight,
    };
  }

  /**
   * Рейтинг «уместности» → целевые веса. В auto набор берётся из пула трека,
   * в manual — ровно то, что выбрал пользователь.
   */
  /**
   * Целевые веса из иерархии ролей.
   *
   * Раньше здесь одновременно жили N примитивов с нормированными весами, и на
   * экране получалась каша: пять несвязанных вещей, ни одна из которых не
   * главная. Теперь ровно одно соло на 60-80% веса, максимум один совместимый
   * акцент и фон — остальные строго в нуле.
   */
  private targetWeights(mood: MoodVector, settings: Settings, scene: SceneState): Map<PrimitiveId, number> {
    const targets = new Map<PrimitiveId, number>();
    for (const id of ALL_PRIMITIVE_IDS) targets.set(id, 0);

    // Соло-режим панели: на экране ровно один примитив, всё остальное в нуле.
    // Без него параметры примитива не подобрать — он тонет в общем кадре.
    const forced = settings.generator.solo;
    if (forced) {
      targets.set(forced, 1);
      // Калейдоскоп — модификатор: сам он ничего не рисует, ему нужен источник.
      if (forced === 'kaleidoscope') targets.set('flow-field', 1);
      return targets;
    }

    if (settings.generator.mode === 'manual') {
      const manual = settings.generator.manual;
      for (const id of manual) targets.set(id, 1);
      return targets;
    }

    this.updateFocus(mood, scene, settings);

    targets.set(this.solo, ROLE_WEIGHT.solo * this.enterFactor(mood.timeMs, settings));
    if (this.leaving) {
      // Старое соло уводится, а не растворяется встык с новым: одновременный
      // кроссфейд двух сложных примитивов даёт ровно ту кашу, от которой ушли.
      targets.set(this.leaving, ROLE_WEIGHT.solo * this.exitFactor(mood.timeMs, settings));
    }
    if (this.accent) targets.set(this.accent, clamp01(settings.focus.accentWeight));
    if (this.background) targets.set(this.background, clamp01(settings.focus.backgroundWeight));

    if (this.seedValue.pool.includes('kaleidoscope')) {
      targets.set('kaleidoscope', smoothstep(0.42, 0.88, this.affinity('kaleidoscope', mood, scene)));
    }
    return targets;
  }

  /**
   * Смена соло. Только на границе секции и не чаще, чем раз в 22-42 секунды:
   * внутри секции соло не меняется вообще, иначе теряется опора для взгляда.
   */
  private updateFocus(mood: MoodVector, scene: SceneState, settings: Settings): void {
    const pool = this.drawablePool(settings);
    if (!pool.includes(this.solo)) this.solo = pool[0];

    // Роль, назначенная вручную, сильнее автоматики: пользователь уже решил.
    const pinned = (role: PrimitiveRole): PrimitiveId | null =>
      ALL_PRIMITIVE_IDS.find((id) => settings.primitives[id]?.enabled !== false
        && settings.primitives[id]?.role === role) ?? null;
    const pinnedSolo = pinned('solo');
    if (pinnedSolo) {
      this.solo = pinnedSolo;
      this.leaving = null;
    }

    const sectionChanged = this.prevSection !== null && mood.section !== this.prevSection;
    this.prevSection = mood.section;
    if (this.soloSince === 0) this.soloSince = mood.timeMs;

    const held = mood.timeMs - this.soloSince;
    const canChange = pinnedSolo === null
      && sectionChanged && held >= this.soloHold && this.leaving === null;

    if (canChange) {
      const ranked = pool
        .map((id) => ({ id, score: this.affinity(id, mood, scene) }))
        .sort((a, b) => b.score - a.score);
      const next = ranked.find((entry) => entry.id !== this.solo);
      if (next) {
        this.leaving = this.solo;
        this.solo = next.id;
        this.soloSince = mood.timeMs;
        this.leavingUntil = mood.timeMs + settings.focus.exitMs;
        // Новое входит после того, как старое почти ушло.
        this.enteringUntil = mood.timeMs + settings.focus.exitMs + settings.focus.enterMs;
        const min = settings.focus.soloMinSec * 1000;
        const max = Math.max(min, settings.focus.soloMaxSec * 1000);
        this.soloHold = min + this.seedValue.rng() * (max - min);
      }
    }

    if (this.leaving && mood.timeMs > this.leavingUntil) this.leaving = null;

    // Акцент выбирается только среди совместимых с соло и обновляется свободно:
    // он не опора кадра, и его смена не сбивает взгляд.
    const candidates = pool.filter((id) => id !== this.solo && isCompatible(this.solo, id));
    const pinnedAccent = pinned('accent');
    this.accent = pinnedAccent && pinnedAccent !== this.solo
      ? pinnedAccent
      : candidates.length === 0
        ? null
        : candidates.reduce((best, id) =>
          this.affinity(id, mood, scene) > this.affinity(best, mood, scene) ? id : best);

    // Фон — атмосфера на 5-10% веса: он не спорит ни с соло, ни с акцентом.
    const pinnedBackground = pinned('background');
    this.background = pinnedBackground !== null
      && pinnedBackground !== this.solo && pinnedBackground !== this.accent
      ? pinnedBackground
      : null;
  }

  /** Разрешённые параметры на кадр: словарь строится один раз за кадр. */
  private tunings(settings: Settings): Map<PrimitiveId, Tuning> {
    const out = new Map<PrimitiveId, Tuning>();
    for (const id of ALL_PRIMITIVE_IDS) {
      out.set(id, resolvePrimitiveParams(id, settings.primitives[id]?.params, settings.advanced));
    }
    return out;
  }

  private exitFactor(nowMs: number, settings: Settings): number {
    return clamp01((this.leavingUntil - nowMs) / Math.max(1, settings.focus.exitMs));
  }

  private enterFactor(nowMs: number, settings: Settings): number {
    if (this.enteringUntil <= nowMs) return 1;
    return clamp01(1 - (this.enteringUntil - nowMs) / Math.max(1, settings.focus.enterMs));
  }

  /**
   * Насколько примитив «к месту», примерно 0..1.
   *
   * Основа — расстояние до текущей точки на оси вещества; поверх неё
   * настроение и смещение от seed'а трека. Так набор примитивов становится
   * проявлением агрегатного состояния, а не отдельным независимым выбором.
   */
  private affinity(id: PrimitiveId, mood: MoodVector, scene: SceneState): number {
    const bias = this.bias.get(id) ?? 0;
    const distance = Math.abs(scene.substance.axis - SUBSTANCE_POSITION[id]);
    const substanceFit = Math.max(0, 1 - distance / SUBSTANCE_TOLERANCE);
    const drop = mood.section === 'drop' ? 1 : 0;
    const calm = mood.section === 'calm' ? 1 : 0;
    const buildup = mood.section === 'buildup' ? 1 : 0;

    let score = 0.3;
    switch (id) {
      case 'waveform-terrain':
        // Ландшафт хорош там, где волна крупная и читаемая: много энергии,
        // не слишком шумно.
        score = 0.35 + mood.energy * 0.4 - mood.noisiness * 0.25;
        break;
      case 'wave-mesh':
        // Поток линий — про плавность: чистый сигнал и уверенная тональность.
        score = 0.4 + (1 - mood.noisiness) * 0.35 + mood.key.confidence * 0.15 - drop * 0.15;
        break;
      case 'spectrum':
        // Спектр читается как анализатор: ему нужен плотный верх и ритм.
        score = 0.25 + mood.bands.high * 0.45 + mood.beatConfidence * 0.2 + drop * 0.15;
        break;
      case 'radial-waveform':
        score = 0.3 + mood.energy * 0.3 + calm * 0.2 - mood.noisiness * 0.15;
        break;
      case 'oscilloscope':
        // Осциллограф живее всего на чистом гармоничном материале.
        score = 0.3 + (1 - mood.noisiness) * 0.3 + mood.key.confidence * 0.2;
        break;
      case 'flow-field':
        score = 0.5 + mood.energy * 0.25 - mood.noisiness * 0.2 + buildup * 0.25;
        break;
      case 'metaballs':
        score = 0.55 - mood.brightness * 0.45 + calm * 0.35 - mood.noisiness * 0.15;
        break;
      case 'voronoi':
        score = 0.15 + mood.brightness * 0.6 + mood.flux * 0.2;
        break;
      case 'cellular':
        score = 0.1 + mood.noisiness * 0.65 + smoothstep(110, 160, mood.bpm) * 0.25;
        break;
      case 'l-system':
        score = 0.45 - mood.energy * 0.35 + calm * 0.45 - mood.noisiness * 0.2;
        break;
      case 'raymarch':
        score = 0.2 + mood.energy * 0.4 + drop * 0.45 + mood.brightness * 0.15;
        break;
      case 'kaleidoscope':
        score = 0.25 + mood.brightness * 0.3 + drop * 0.35 + buildup * 0.15 - mood.noisiness * 0.2;
        break;
    }
    // Вещество весит больше настроения: оно и есть «из чего сделан мир».
    return clamp01(substanceFit * 0.62 + score * 0.38 + bias);
  }

  /**
   * Базовый слой реагирует на тональность и энергию, поэтому меняется редко:
   * его примитив переключается не чаще раза в 20 секунд.
   */
  private updateBase(mood: MoodVector, settings: Settings, scene: SceneState, k: number): void {
    const allowed = settings.generator.mode === 'manual'
      ? settings.generator.manual.filter((id) => BASE_LAYER_IDS.includes(id))
      : this.seedValue.pool.filter((id) => BASE_LAYER_IDS.includes(id));
    const candidates = allowed.length > 0 ? allowed : BASE_LAYER_IDS;

    if (mood.timeMs - this.baseSwitchAt > 20000 || !candidates.includes(this.baseId)) {
      this.baseSwitchAt = mood.timeMs;
      let best = candidates[0];
      let bestScore = -Infinity;
      for (const id of candidates) {
        const score = this.affinity(id, mood, scene);
        if (score > bestScore) {
          bestScore = score;
          best = id;
        }
      }
      this.baseId = best;
    }

    // Базовый слой — атмосфера, а не участник: по иерархии ролей ему положено
    // 5-10% визуального веса, не больше.
    const target = settings.layers.base.enabled ? 0.08 + mood.energy * 0.12 : 0;
    this.baseWeight = lerp(this.baseWeight, target, k);
  }

  /** Медленный, «дышащий» вариант параметров: фон не должен спорить с жанровым слоем. */
  private baseLayerParams(mood: MoodVector, scene: SceneState): GenParams {
    const genre = this.genreLayerParams(mood, scene);
    return {
      ...genre,
      density: genre.density * 0.55,
      speed: genre.speed * 0.35,
      scale: clamp01(genre.scale * 0.6 + 0.4),
      sharpness: genre.sharpness * 0.4,
      chaos: genre.chaos * 0.5,
      trail: clamp01(genre.trail * 0.6 + 0.35),
    };
  }

  private genreLayerParams(mood: MoodVector, scene: SceneState): GenParams {
    const tempo = smoothstep(70, 170, mood.bpm);
    const { substance } = scene;
    return {
      density: clamp01(0.18 + mood.energy * 0.5 + substance.axis * 0.25 + (mood.section === 'drop' ? 0.15 : 0)),
      speed: clamp01(0.12 + tempo * 0.45 + mood.energy * 0.3 + scene.impulseEnergy * 0.2),
      // Яркий тембр — мелкая деталь; глухой — крупные пятна.
      scale: clamp01(0.85 - mood.brightness * 0.6),
      // Жёсткость вещества — это и есть резкость форм: туман мягкий, кристалл колется.
      sharpness: clamp01(substance.stiffness * 0.7 + mood.brightness * 0.3),
      chaos: clamp01(mood.noisiness * 0.5 + mood.flux * 0.3 + substance.axis * 0.3),
      // Пространство коробит проходящими волнами — это видимая часть импульса.
      warp: clamp01(substance.deformation * 0.7 + mood.flux * 0.4),
      // Память сцены сама решает, насколько долго держатся следы.
      trail: clamp01(scene.memory.trail + (mood.section === 'calm' ? 0.12 : 0)),
      symmetry: clamp(3, 12, this.seedValue.symmetry),
    };
  }

  private applySeedBias(): void {
    // Тот же mood vector на разных треках даёт разный рейтинг — это и есть
    // «разные треки с похожим настроением выглядят по-разному».
    const rng = mulberry32(this.seedValue.seed ^ 0xc2b2ae35);
    this.bias.clear();
    for (const id of ALL_PRIMITIVE_IDS) this.bias.set(id, (rng() * 2 - 1) * 0.25);
  }
}

export function isModifier(primitive: Primitive): primitive is ModifierPrimitive {
  return primitive.kind === 'modifier';
}

export function isDrawable(primitive: Primitive): primitive is DrawPrimitive {
  return primitive.kind === 'draw';
}

export { BASE_LAYER_IDS };
