/**
 * Сцены — композиции модулей, а не зашитые пресеты.
 *
 * Сцена говорит, какой примитив ведёт кадр, что поддерживает его, какие
 * частицы, свет, камера и обработка к нему подходят, и как всё это привязано
 * к звуку. Сами модули живут отдельно: одна и та же волна над сеткой может
 * быть главной в одной сцене и фоном в другой. Отсюда комбинаторика — сцены
 * собираются из модулей, модули параметризуются вариациями, вариации
 * привязываются к звуку.
 *
 * `fits` — глобальное знание: в каком музыкальном состоянии сцена уместна.
 * Это стартовая точка режиссёра, а поверх неё ложится то, чему он научился
 * у конкретного зрителя.
 */

import type { ParticleType } from '../render/particles.ts';
import type { PrimitiveId } from '../render/primitives/types.ts';
import type { BindingSpec } from './binding.ts';
import type { FeatureKey } from './audio-features.ts';
import type { MusicalState } from './musical-state.ts';

export type LayerRole = 'primary' | 'secondary' | 'background';

export interface SceneLayer {
  primitive: PrimitiveId;
  role: LayerRole;
  /** Вес слоя при полном присутствии сцены. */
  weight: number;
}

export type CameraStyle = 'static' | 'smooth' | 'orbit' | 'forward' | 'aggressive' | 'impact';

/** Черты, по которым обучение строит профиль зрителя. */
export type VisualTrait =
  | 'particles' | 'geometry' | 'organic' | 'glitch' | 'typography' | 'minimal' | 'impact' | 'dark';

export interface SceneDef {
  id: string;
  name: string;
  layers: SceneLayer[];
  /** Частицы — продолжение главного слоя, первым идёт предпочтительный тип. */
  particles: ParticleType[];
  /** Базовая плотность частиц сцены, 0..1. */
  particleDensity: number;
  lighting: { bloom: number; rays: number; rim: number };
  camera: CameraStyle;
  /** Доля обратной связи кадра — «память» сцены. */
  feedback: number;
  /** Насколько сцене к лицу текст песни, 0..1. */
  typography: number;
  /** Собственная визуальная сложность сцены, 0..1. */
  complexity: number;
  /** Уместность по музыкальному состоянию — глобальное знание. */
  fits: Partial<Record<MusicalState, number>>;
  /** Какие признаки звука сцене нравятся: к ним она тянется сильнее. */
  affinity: Partial<Record<FeatureKey, number>>;
  traits: VisualTrait[];
  /** Привязки параметров сцены к звуку. */
  bindings: Record<string, BindingSpec>;
}

/**
 * Имена параметров, которые понимает интеграция в рендер. Сцена может
 * привязать любой из них; непривязанный берёт значение по умолчанию.
 */
export const SCENE_PARAMS = [
  // Множитель веса главного слоя: дышит вместе с музыкой.
  'primaryPulse',
  // Множитель свечения.
  'glow',
  // Добавка к плотности частиц.
  'particleBoost',
  // Сила толчка камеры на атаке.
  'cameraKick',
  // Добавка к деформациям.
  'warp',
] as const;

/** Общие привязки: у большинства сцен свет дышит энергией, а удар толкает камеру. */
const COMMON_BINDINGS: Record<string, BindingSpec> = {
  primaryPulse: { source: 'energy', curve: 'ease-out', multiplier: 0.35, offset: 0.75, attack: 0.05, release: 0.6 },
  glow: { source: 'energy', curve: 'smooth', multiplier: 0.8, offset: 0.6, attack: 0.1, release: 0.9 },
  particleBoost: { source: 'transientStrength', threshold: 0.3, multiplier: 0.6, attack: 0, release: 0.35 },
  cameraKick: { source: 'transientStrength', threshold: 0.45, curve: 'ease-in', multiplier: 1, release: 0.25 },
  warp: { source: 'spectralFlux', deadzone: 0.1, multiplier: 0.4, smoothing: 0.4 },
};

export const SCENES: SceneDef[] = [
  {
    id: 'cyber-flow',
    name: 'Dark Cyber Flow',
    layers: [
      { primitive: 'wave-grid-3d', role: 'primary', weight: 1 },
      { primitive: 'flow-field', role: 'background', weight: 0.12 },
    ],
    particles: ['dust', 'sparks'],
    particleDensity: 0.45,
    lighting: { bloom: 0.55, rays: 0.1, rim: 0.1 },
    camera: 'smooth',
    feedback: 0.12,
    typography: 0.7,
    complexity: 0.45,
    fits: { BUILD: 0.8, RISING: 0.85, PEAK: 0.75, RHYTHMIC: 0.7, TRANSITION: 0.5, AMBIENT: 0.4 },
    affinity: { bass: 0.5, energy: 0.3, beatConfidence: 0.2 },
    traits: ['geometry', 'dark'],
    bindings: {
      ...COMMON_BINDINGS,
      // Волна дышит низом, а не общей громкостью: так она читается как бас.
      primaryPulse: { source: 'bass', curve: 'ease-out', multiplier: 0.4, offset: 0.7, attack: 0.02, release: 0.4 },
    },
  },
  {
    id: 'spectrum-stage',
    name: 'Spectrum Stage',
    layers: [
      { primitive: 'spectrum', role: 'primary', weight: 1 },
      { primitive: 'wave-mesh', role: 'background', weight: 0.1 },
    ],
    particles: ['sparks', 'streaks'],
    particleDensity: 0.55,
    lighting: { bloom: 0.6, rays: 0.25, rim: 0.12 },
    camera: 'aggressive',
    feedback: 0.08,
    typography: 0.35,
    complexity: 0.6,
    fits: { PEAK: 0.9, IMPACT: 0.85, RHYTHMIC: 0.8, CHAOTIC: 0.7, RISING: 0.55 },
    affinity: { treble: 0.3, highMid: 0.3, rhythmicDensity: 0.4 },
    traits: ['geometry', 'impact'],
    bindings: {
      ...COMMON_BINDINGS,
      particleBoost: { source: 'highMid', threshold: 0.4, multiplier: 0.7, attack: 0, release: 0.2 },
    },
  },
  {
    id: 'radial-core',
    name: 'Radial Core',
    layers: [
      { primitive: 'radial-waveform', role: 'primary', weight: 1 },
      { primitive: 'metaballs', role: 'background', weight: 0.1 },
    ],
    particles: ['bokeh', 'sparks'],
    particleDensity: 0.35,
    lighting: { bloom: 0.5, rays: 0.18, rim: 0.1 },
    camera: 'static',
    feedback: 0.15,
    typography: 1,
    complexity: 0.35,
    fits: { VOCAL_FOCUS: 0.9, AMBIENT: 0.6, BREAKDOWN: 0.7, RHYTHMIC: 0.5 },
    affinity: { vocalLikelihood: 0.6, mid: 0.3 },
    traits: ['typography', 'minimal'],
    bindings: {
      ...COMMON_BINDINGS,
      primaryPulse: { source: 'lowMid', curve: 'smooth', multiplier: 0.3, offset: 0.8, attack: 0.05, release: 0.5 },
    },
  },
  {
    id: 'organic-fluid',
    name: 'Organic Fluid',
    layers: [
      { primitive: 'metaballs', role: 'primary', weight: 1 },
      { primitive: 'wave-mesh', role: 'secondary', weight: 0.25 },
    ],
    particles: ['bokeh', 'embers', 'dust'],
    particleDensity: 0.3,
    lighting: { bloom: 0.5, rays: 0.2, rim: 0.25 },
    camera: 'orbit',
    feedback: 0.3,
    typography: 0.8,
    complexity: 0.45,
    fits: { AMBIENT: 0.85, BREAKDOWN: 0.8, VOCAL_FOCUS: 0.7, BUILD: 0.4 },
    affinity: { lowMid: 0.4, vocalLikelihood: 0.2, energyTrend: -0.2 },
    traits: ['organic'],
    bindings: {
      ...COMMON_BINDINGS,
      warp: { source: 'lowMid', curve: 'smooth', multiplier: 0.5, smoothing: 0.8 },
    },
  },
  {
    id: 'crystal-geometry',
    name: 'Crystal Geometry',
    layers: [
      { primitive: 'voronoi', role: 'primary', weight: 1 },
      { primitive: 'kaleidoscope', role: 'secondary', weight: 0.7 },
    ],
    particles: ['shards', 'sparks'],
    particleDensity: 0.45,
    lighting: { bloom: 0.45, rays: 0.15, rim: 0.3 },
    camera: 'orbit',
    feedback: 0.2,
    typography: 0.3,
    complexity: 0.65,
    fits: { RHYTHMIC: 0.85, PEAK: 0.7, CHAOTIC: 0.75, TRANSITION: 0.6 },
    affinity: { rhythmicDensity: 0.5, beatConfidence: 0.3 },
    traits: ['geometry', 'glitch'],
    bindings: COMMON_BINDINGS,
  },
  {
    id: 'terrain-flight',
    name: 'Terrain Flight',
    layers: [
      { primitive: 'waveform-terrain', role: 'primary', weight: 1 },
      { primitive: 'flow-field', role: 'background', weight: 0.1 },
    ],
    particles: ['dust', 'streaks'],
    particleDensity: 0.35,
    lighting: { bloom: 0.5, rays: 0.2, rim: 0.1 },
    camera: 'forward',
    feedback: 0.1,
    typography: 0.6,
    complexity: 0.5,
    fits: { BUILD: 0.85, RISING: 0.7, AMBIENT: 0.55, BREAKDOWN: 0.4 },
    affinity: { energyTrend: 0.5, mid: 0.2 },
    traits: ['organic', 'dark'],
    bindings: COMMON_BINDINGS,
  },
  {
    id: 'deep-minimal',
    name: 'Deep Minimal',
    layers: [
      { primitive: 'oscilloscope', role: 'primary', weight: 1 },
    ],
    particles: ['dust'],
    particleDensity: 0.15,
    lighting: { bloom: 0.45, rays: 0.05, rim: 0.05 },
    camera: 'static',
    feedback: 0.05,
    typography: 0.9,
    complexity: 0.15,
    fits: { SILENCE: 0.9, IDLE: 1, AMBIENT: 0.65, BREAKDOWN: 0.75, VOCAL_FOCUS: 0.5 },
    affinity: { silenceLevel: 0.4, stereoWidth: 0.4 },
    traits: ['minimal', 'dark'],
    bindings: {
      ...COMMON_BINDINGS,
      cameraKick: { source: 'transientStrength', threshold: 0.8, multiplier: 0.3, release: 0.3 },
    },
  },
  {
    id: 'plasma-core',
    name: 'Plasma Core',
    layers: [
      { primitive: 'raymarch', role: 'primary', weight: 1 },
      { primitive: 'oscilloscope', role: 'secondary', weight: 0.2 },
    ],
    particles: ['embers', 'sparks'],
    particleDensity: 0.4,
    lighting: { bloom: 0.6, rays: 0.3, rim: 0.3 },
    camera: 'aggressive',
    feedback: 0.15,
    typography: 0.25,
    complexity: 0.6,
    fits: { PEAK: 0.85, IMPACT: 0.9, CHAOTIC: 0.6, RISING: 0.5 },
    affinity: { bass: 0.4, energy: 0.4, dynamicRange: 0.2 },
    traits: ['impact', 'organic'],
    bindings: COMMON_BINDINGS,
  },
  {
    id: 'cellular-pulse',
    name: 'Cellular Pulse',
    layers: [
      { primitive: 'cellular', role: 'primary', weight: 1 },
      { primitive: 'l-system', role: 'secondary', weight: 0.2 },
    ],
    particles: ['sparks', 'dust'],
    particleDensity: 0.3,
    lighting: { bloom: 0.4, rays: 0.1, rim: 0.15 },
    camera: 'smooth',
    feedback: 0.15,
    typography: 0.5,
    complexity: 0.55,
    fits: { RHYTHMIC: 0.75, CHAOTIC: 0.8, TRANSITION: 0.55 },
    affinity: { rhythmicDensity: 0.5, zeroCrossingRate: 0.3 },
    traits: ['geometry', 'glitch'],
    bindings: COMMON_BINDINGS,
  },
];

export function findScene(id: string): SceneDef {
  return SCENES.find((scene) => scene.id === id) ?? SCENES[0];
}

/**
 * Собственная сложность модулей: сколько визуального внимания отнимает
 * каждый при полном весе. Из них складывается общая сложность кадра.
 */
export const PRIMITIVE_COMPLEXITY: Record<PrimitiveId, number> = {
  'wave-grid-3d': 0.4,
  'waveform-terrain': 0.45,
  'wave-mesh': 0.35,
  spectrum: 0.45,
  'radial-waveform': 0.3,
  oscilloscope: 0.2,
  'flow-field': 0.35,
  metaballs: 0.35,
  voronoi: 0.5,
  kaleidoscope: 0.3,
  cellular: 0.5,
  'l-system': 0.4,
  raymarch: 0.5,
};

/** Сколько сложности в кадре уместно в каждом состоянии музыки. */
export const TARGET_COMPLEXITY: Record<MusicalState, number> = {
  IDLE: 0.12, SILENCE: 0.12, AMBIENT: 0.32, BREAKDOWN: 0.3, VOCAL_FOCUS: 0.4,
  BUILD: 0.5, TRANSITION: 0.5, RHYTHMIC: 0.6, RISING: 0.65, PEAK: 0.8,
  IMPACT: 0.85, CHAOTIC: 0.8,
};
