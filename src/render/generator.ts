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
import type { Settings } from '../settings.ts';
import { makeSeed, mulberry32, type GeneratorSeed } from './seed.ts';
import { CellularPrimitive } from './primitives/cellular.ts';
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

/** Сколько примитивов звучит одновременно в каждой секции. */
const ACTIVE_COUNT: Record<Section, number> = {
  calm: 1,
  steady: 2,
  buildup: 2,
  drop: 3,
};

/** Базовый слой держит только дешёвые примитивы: он идёт фоном ко всему. */
const BASE_LAYER_IDS: PrimitiveId[] = ['flow-field', 'metaballs', 'voronoi'];

/** Бонус уже активному примитиву — гасит дребезг на границе рейтинга. */
const INCUMBENT_BONUS = 0.08;

/**
 * Место каждого примитива на оси агрегатного состояния вещества:
 * 0 — туман, 0.33 — жидкость, 0.66 — кристалл, 1 — плазма.
 * Это главный источник рейтинга: набор на экране — прямое следствие того,
 * из чего сейчас сделан мир.
 */
const SUBSTANCE_POSITION: Record<PrimitiveId, number> = {
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

export interface GeneratorState {
  seed: GeneratorSeed;
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

  constructor(trackKeyValue: string) {
    this.key = trackKeyValue;
    this.seedValue = makeSeed(trackKeyValue, this.salt);
    this.applySeedBias();
    for (const id of ALL_PRIMITIVE_IDS) this.weights.set(id, 0);
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
  private targetWeights(mood: MoodVector, settings: Settings, scene: SceneState): Map<PrimitiveId, number> {
    const targets = new Map<PrimitiveId, number>();
    for (const id of ALL_PRIMITIVE_IDS) targets.set(id, 0);

    if (settings.generator.mode === 'manual') {
      const manual = settings.generator.manual;
      const drawIds = manual.filter((id) => id !== 'kaleidoscope');
      for (const id of drawIds) targets.set(id, 1);
      targets.set('kaleidoscope', manual.includes('kaleidoscope') ? 1 : 0);
      return targets;
    }

    const pool = this.seedValue.pool.filter((id) => id !== 'kaleidoscope');
    const scored = pool
      .map((id) => ({
        id,
        score: this.affinity(id, mood, scene) + ((this.weights.get(id) ?? 0) > 0.15 ? INCUMBENT_BONUS : 0),
      }))
      .sort((a, b) => b.score - a.score);

    const count = Math.min(scored.length, ACTIVE_COUNT[mood.section]);
    const winners = scored.slice(0, count);
    const total = winners.reduce((sum, entry) => sum + Math.max(0.05, entry.score), 0);
    for (const entry of winners) {
      // Нормируем так, чтобы суммарная «плотность» картинки не росла с числом слоёв.
      targets.set(entry.id, clamp01((Math.max(0.05, entry.score) / total) * (0.6 + count * 0.25)));
    }

    if (this.seedValue.pool.includes('kaleidoscope')) {
      targets.set('kaleidoscope', smoothstep(0.42, 0.88, this.affinity('kaleidoscope', mood, scene)));
    }
    return targets;
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

    let score: number;
    switch (id) {
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
