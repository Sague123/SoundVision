/**
 * Chroma-вектор (энергия по 12 полутонам) и определение тональности
 * корреляцией с профилями Krumhansl-Schmuckler.
 */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export type NoteName = (typeof NOTE_NAMES)[number];

export interface KeyEstimate {
  tonic: NoteName;
  mode: 'major' | 'minor';
  /** 0..1, насколько уверенно профиль лёг на chroma. */
  confidence: number;
}

// Krumhansl-Kessler: усреднённые оценки «насколько нота уместна в тональности».
//               C     C#    D     D#    E     F     F#    G     G#    A     A#    B
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Ниже C2 — почти только бас-гул, выше B6 — гармоники, обе зоны портят chroma. */
const MIN_HZ = 65;
const MAX_HZ = 2100;

export class ChromaAnalyzer {
  private readonly chroma = new Float32Array(12);
  /** Медленно накапливаемый профиль: тональность не меняется каждый кадр. */
  private readonly integrated = new Float32Array(12);
  private current: KeyEstimate = { tonic: 'C', mode: 'major', confidence: 0 };
  private candidate: KeyEstimate | null = null;
  private candidateFrames = 0;

  constructor(private readonly binHz: number) {}

  /** @returns нормализованный chroma-вектор текущего кадра (12 значений 0..1). */
  update(spectrum: Float32Array, silent: boolean): Float32Array {
    this.chroma.fill(0);
    if (silent) return this.chroma;

    const firstBin = Math.max(1, Math.floor(MIN_HZ / this.binHz));
    const lastBin = Math.min(spectrum.length - 1, Math.ceil(MAX_HZ / this.binHz));

    for (let i = firstBin; i <= lastBin; i++) {
      const magnitude = spectrum[i];
      if (magnitude <= 0) continue;
      const hz = i * this.binHz;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
      // Энергия, а не амплитуда: иначе шумовой «пол» перевешивает реальные ноты.
      this.chroma[pitchClass] += magnitude * magnitude;
    }

    normalizeInPlace(this.chroma);
    for (let i = 0; i < 12; i++) {
      this.integrated[i] = this.integrated[i] * 0.985 + this.chroma[i] * 0.015;
    }
    return this.chroma;
  }

  /**
   * Тональность из накопленного профиля. Смена фиксируется только если новый
   * кандидат держится ~1.5 секунды — иначе мажор/минор мигает на каждом аккорде.
   */
  estimateKey(): KeyEstimate {
    const profile = Array.from(this.integrated);
    const total = profile.reduce((a, b) => a + b, 0);
    if (total < 1e-6) return this.current;

    let best: KeyEstimate = { tonic: 'C', mode: 'major', confidence: 0 };
    let second = 0;

    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = profile.slice(tonic).concat(profile.slice(0, tonic));
      for (const mode of ['major', 'minor'] as const) {
        const score = pearson(rotated, mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE);
        if (score > best.confidence) {
          second = best.confidence;
          best = { tonic: NOTE_NAMES[tonic], mode, confidence: score };
        } else if (score > second) {
          second = score;
        }
      }
    }

    // Уверенность — это отрыв от второго места: 0.9 против 0.89 не значит ничего.
    const margin = Math.max(0, Math.min(1, (best.confidence - second) * 4));
    const candidate: KeyEstimate = { ...best, confidence: margin };

    if (candidate.tonic === this.current.tonic && candidate.mode === this.current.mode) {
      this.current = candidate;
      this.candidate = null;
      this.candidateFrames = 0;
      return this.current;
    }

    if (this.candidate && this.candidate.tonic === candidate.tonic && this.candidate.mode === candidate.mode) {
      this.candidateFrames++;
    } else {
      this.candidate = candidate;
      this.candidateFrames = 1;
    }

    if (this.candidateFrames > 90) {
      this.current = candidate;
      this.candidate = null;
      this.candidateFrames = 0;
    }
    return this.current;
  }

  get vector(): Float32Array {
    return this.chroma;
  }
}

function normalizeInPlace(values: Float32Array): void {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  if (max <= 0) return;
  for (let i = 0; i < values.length; i++) values[i] /= max;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}
