/**
 * Mood vector — единственная точка, через которую рендер узнаёт о звуке.
 * Слои и примитивы не знают ни про FFT, ни про analyser: только про эти числа.
 */

import type { AudioCapture } from './capture.ts';
import { BeatTracker } from './beat-tracker.ts';
import { ChromaAnalyzer, type KeyEstimate } from './chroma.ts';
import { DEFAULT_FEATURE_CONFIG, FeatureExtractor, type FeatureConfig, type Section } from './features.ts';

export type { Section } from './features.ts';
export type { KeyEstimate } from './chroma.ts';

export interface MoodVector {
  /** Громкость, 0..1 — нормализована адаптивно к источнику. */
  energy: number;
  /** «Яркость» тембра из spectral centroid, 0..1. */
  brightness: number;
  /** Шумность/дисторшн из zero-crossing rate, 0..1. */
  noisiness: number;
  /** Скорость изменения спектра, 0..1 — глитчи и дропы. */
  flux: number;
  onset: boolean;
  onsetStrength: number;
  bpm: number;
  /** Позиция внутри доли, 0..1. */
  beatPhase: number;
  beatConfidence: number;
  key: KeyEstimate;
  section: Section;
  /** Наклон энергии в окне тренда, -1..1. */
  energySlope: number;
  chroma: Float32Array;
  silent: boolean;
  timeMs: number;
  deltaMs: number;
}

export interface MoodConfig extends FeatureConfig {
  /** Ручной темп из панели настроек; null — доверяем трекеру. */
  bpmOverride: number | null;
}

export const DEFAULT_MOOD_CONFIG: MoodConfig = {
  ...DEFAULT_FEATURE_CONFIG,
  bpmOverride: null,
};

export class MoodEngine {
  private readonly features: FeatureExtractor;
  private readonly chroma: ChromaAnalyzer;
  private readonly beat = new BeatTracker();
  private lastFrameMs = 0;

  /** Нужен только граф Web Audio — не весь захват; так движок можно гонять на синтетике. */
  constructor(capture: Pick<AudioCapture, 'context' | 'analyser'>) {
    const sampleRate = capture.context.sampleRate;
    this.features = new FeatureExtractor(capture.analyser, sampleRate);
    this.chroma = new ChromaAnalyzer(sampleRate / capture.analyser.fftSize);
  }

  update(nowMs: number, config: MoodConfig): MoodVector {
    // Первый кадр и возврат из фонового таба не должны давать гигантскую дельту.
    const deltaMs = this.lastFrameMs === 0 ? 16.7 : Math.min(100, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;

    const raw = this.features.analyze(nowMs, config);
    const chroma = this.chroma.update(raw.spectrum, raw.silent);
    const key = this.chroma.estimateKey();

    this.beat.update(nowMs, deltaMs, raw.onsetStrength, raw.flux);
    const beat = this.beat.state(nowMs, config.bpmOverride);

    return {
      energy: raw.energy,
      brightness: raw.brightness,
      noisiness: raw.noisiness,
      flux: raw.flux,
      onset: raw.onset,
      onsetStrength: raw.onsetStrength,
      bpm: beat.bpm,
      beatPhase: beat.phase,
      beatConfidence: beat.confidence,
      key,
      section: raw.section,
      energySlope: raw.energySlope,
      chroma,
      silent: raw.silent,
      timeMs: nowMs,
      deltaMs,
    };
  }
}

/** Нейтральный вектор — рендер может стартовать до первого кадра анализа. */
export function idleMood(timeMs = 0): MoodVector {
  return {
    energy: 0,
    brightness: 0.35,
    noisiness: 0.15,
    flux: 0,
    onset: false,
    onsetStrength: 0,
    bpm: 120,
    beatPhase: 0,
    beatConfidence: 0,
    key: { tonic: 'C', mode: 'major', confidence: 0 },
    section: 'calm',
    energySlope: 0,
    chroma: new Float32Array(12),
    silent: true,
    timeMs,
    deltaMs: 16.7,
  };
}
