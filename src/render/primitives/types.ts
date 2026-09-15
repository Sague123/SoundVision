/** Общий контракт генеративных примитивов. */

import type { MoodVector } from '../../audio/mood-vector.ts';
import type { Palette } from '../palette.ts';
import type { SceneState } from '../scene.ts';
import type { GeneratorSeed } from '../seed.ts';

export const ALL_PRIMITIVE_IDS = [
  'flow-field',
  'metaballs',
  'voronoi',
  'kaleidoscope',
  'cellular',
  'l-system',
  'raymarch',
] as const;

export type PrimitiveId = (typeof ALL_PRIMITIVE_IDS)[number];

export const PRIMITIVE_LABELS: Record<PrimitiveId, string> = {
  'flow-field': 'Flow field',
  metaballs: 'Metaballs',
  voronoi: 'Voronoi',
  kaleidoscope: 'Kaleidoscope',
  cellular: 'Cellular automata',
  'l-system': 'L-system',
  raymarch: 'Raymarch',
};

/**
 * Непрерывное пространство параметров генератора. Ни одно поле не «переключает
 * режим» — все меняются плавно, поэтому картинка эволюционирует, а не щёлкает.
 */
export interface GenParams {
  /** Плотность элементов, 0..1. */
  density: number;
  /** Скорость движения, 0..1. */
  speed: number;
  /** Характерный размер деталей, 0..1 (0 — мелко, 1 — крупно). */
  scale: number;
  /** Мягкие блобы (0) ↔ жёсткие грани (1). */
  sharpness: number;
  /** Хаотичность траекторий, 0..1. */
  chaos: number;
  /** Сила искажения пространства шумом, 0..1. */
  warp: number;
  /** Длина следов: 0 — чистый кадр, 1 — почти без очистки. */
  trail: number;
  /** Порядок симметрии калейдоскопа, 3..12. */
  symmetry: number;
}

export interface RenderFrame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  mood: MoodVector;
  palette: Palette;
  /** Состояние сцены: вещество, свет, камера, живые импульсы. */
  scene: SceneState;
  params: GenParams;
  /** Вклад примитива прямо сейчас, 0..1 — этим делается кроссфейд. */
  weight: number;
  dtMs: number;
  timeMs: number;
}

interface PrimitiveBase {
  readonly id: PrimitiveId;
  resize(width: number, height: number): void;
  reseed(seed: GeneratorSeed): void;
  dispose(): void;
}

export interface DrawPrimitive extends PrimitiveBase {
  readonly kind: 'draw';
  draw(frame: RenderFrame): void;
}

export interface ModifierPrimitive extends PrimitiveBase {
  readonly kind: 'modifier';
  /** Переписывает содержимое `frame.ctx`, используя `source` как исходник. */
  apply(frame: RenderFrame, source: CanvasImageSource): void;
}

export type Primitive = DrawPrimitive | ModifierPrimitive;

/** Плавный переход 0→1 на отрезке [edge0, edge1] — вместо ступенек. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
