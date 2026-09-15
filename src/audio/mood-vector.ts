/**
 * Mood vector — единственная точка, через которую рендер узнаёт о звуке.
 * Слои и примитивы не знают ни про FFT, ни про analyser: только про эти числа.
 */

import type { AudioCapture } from './capture.ts';
import { BeatTracker } from './beat-tracker.ts';
import { ChromaAnalyzer, type KeyEstimate } from './chroma.ts';
import {
  DEFAULT_FEATURE_CONFIG, FeatureExtractor, SILENT_PROFILE,
  type BandProfile, type FeatureConfig, type Section,
} from './features.ts';

export type { Section, BandProfile } from './features.ts';
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
  /** Сглаженная энергия по полосам: низ / середина / верх. */
  bands: BandProfile;
  /** Частотный профиль текущего удара; нули, если удара нет. */
  onsetProfile: BandProfile;
  chroma: Float32Array;
  /**
   * Сырая осциллограмма и спектр. Нужны примитивам, которые рисуют сам
   * сигнал: узнаваемая волна убеждает сильнее любой абстракции, отдалённо
   * связанной со звуком.
   */
  waveform: Float32Array;
  /** Осциллограмма правого канала; при моно совпадает с левой. */
  waveformRight: Float32Array;
  /** Линейные магнитуды спектра, длина fftSize/2. */
  spectrum: Float32Array;
  stereo: boolean;
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

  private readonly left: AnalyserNode;
  private readonly right: AnalyserNode;
  private readonly stereo: boolean;
  private readonly waveform: Float32Array<ArrayBuffer>;
  private readonly waveformRight: Float32Array<ArrayBuffer>;

  /** Нужен только граф Web Audio — не весь захват; так движок можно гонять на синтетике. */
  constructor(capture: Pick<AudioCapture, 'context' | 'analyser'> & Partial<Pick<AudioCapture, 'left' | 'right' | 'stereo'>>) {
    const sampleRate = capture.context.sampleRate;
    this.features = new FeatureExtractor(capture.analyser, sampleRate);
    this.chroma = new ChromaAnalyzer(sampleRate / capture.analyser.fftSize);
    this.left = capture.left ?? capture.analyser;
    this.right = capture.right ?? capture.analyser;
    this.stereo = capture.stereo ?? false;
    this.waveform = new Float32Array(new ArrayBuffer(capture.analyser.fftSize * 4));
    this.waveformRight = new Float32Array(new ArrayBuffer(capture.analyser.fftSize * 4));
  }

  update(nowMs: number, config: MoodConfig): MoodVector {
    // Первый кадр и возврат из фонового таба не должны давать гигантскую дельту.
    const deltaMs = this.lastFrameMs === 0 ? 16.7 : Math.min(100, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;

    const raw = this.features.analyze(nowMs, config);
    this.left.getFloatTimeDomainData(this.waveform);
    if (this.stereo) this.right.getFloatTimeDomainData(this.waveformRight);
    else this.waveformRight.set(this.waveform);
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
      bands: raw.bands,
      onsetProfile: raw.onsetProfile,
      chroma,
      waveform: this.waveform,
      waveformRight: this.waveformRight,
      spectrum: raw.spectrum,
      stereo: this.stereo,
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
    bands: { ...SILENT_PROFILE },
    onsetProfile: { ...SILENT_PROFILE },
    chroma: new Float32Array(12),
    waveform: new Float32Array(2048),
    waveformRight: new Float32Array(2048),
    spectrum: new Float32Array(1024),
    stereo: false,
    silent: true,
    timeMs,
    deltaMs: 16.7,
  };
}
