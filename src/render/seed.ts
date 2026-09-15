/**
 * Seed трека: хэш artist+title задаёт стартовую точку генератора.
 * Один и тот же трек узнаваем при повторном прослушивании, но это не клип —
 * дальше всё двигает mood vector.
 */

import { HARMONY_SCHEMES } from './color/harmony.ts';
import { ALL_PRIMITIVE_IDS, type PrimitiveId } from './primitives/types.ts';

export type Rng = () => number;

/** FNV-1a, 32 бита — быстрый и достаточно «размазанный» для наших целей. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratorSeed {
  seed: number;
  label: string;
  rng: Rng;
  /** Примитивы, доступные этому треку: остальные не включатся даже на дропе. */
  pool: PrimitiveId[];
  /** Порядок симметрии калейдоскопа: 3..12. */
  symmetry: number;
  /** Сдвиг оттенка палитры в градусах, -40..40. */
  hueShift: number;
  /**
   * Гармоническая схема построения палитры. Из-за неё два трека в одной
   * тональности всё равно звучат по-разному в цвете.
   */
  harmonyId: string;
  /** Множитель скорости морфинга, 0.7..1.5. */
  morphRate: number;
  /** Стартовые смещения по каждому примитиву — чтобы фазы не совпадали. */
  phase: Record<PrimitiveId, number>;
}

/** Примитивы, к которым «тянется» трек, — не все сразу, иначе каша. */
const POOL_SIZE_MIN = 3;
const POOL_SIZE_MAX = 5;

export function makeSeed(trackKey: string, salt = 0): GeneratorSeed {
  const seed = hashString(`${trackKey}::${salt}`);
  const rng = mulberry32(seed);

  const shuffled = [...ALL_PRIMITIVE_IDS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const poolSize = POOL_SIZE_MIN + Math.floor(rng() * (POOL_SIZE_MAX - POOL_SIZE_MIN + 1));
  const pool = shuffled.slice(0, poolSize);
  // Калейдоскоп — модификатор, сам по себе он ничего не рисует.
  if (!pool.some((id) => id !== 'kaleidoscope')) pool.push('flow-field');

  const phase = {} as Record<PrimitiveId, number>;
  for (const id of ALL_PRIMITIVE_IDS) phase[id] = rng() * 1000;

  return {
    seed,
    label: trackKey,
    rng,
    pool,
    symmetry: 3 + Math.floor(rng() * 10),
    hueShift: (rng() * 2 - 1) * 40,
    harmonyId: HARMONY_SCHEMES[Math.floor(rng() * HARMONY_SCHEMES.length)].id,
    morphRate: 0.7 + rng() * 0.8,
    phase,
  };
}

/** Ключ трека для сида: регистр и лишние пробелы не должны менять картинку. */
export function trackKey(artist: string | null, title: string | null): string {
  const normalized = `${artist ?? ''} ${title ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalized || 'soundvision:no-track';
}
