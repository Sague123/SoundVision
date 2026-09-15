/**
 * Низкоуровневые фичи спектра и волны: RMS, spectral flux/centroid, ZCR,
 * onset-детектор и тренд энергии (buildup/drop/calm/steady).
 *
 * Все наружные значения нормализованы в 0..1 адаптивно, поэтому картинка
 * одинаково живая и на тихом джазе, и на закомпрессированном техно.
 */

export type Section = 'buildup' | 'drop' | 'calm' | 'steady';

/**
 * Разбиение спектра на три полосы. Границы выбраны по тому, что в них живёт:
 * бочка и бас до 180 Гц, малый барабан и основная гармония до 2.2 кГц,
 * хай-хэты и «воздух» выше.
 */
export const BAND_EDGES_HZ = { lowMid: 180, midHigh: 2200 } as const;

/** Распределение энергии (или силы удара) по трём полосам, каждая 0..1. */
export interface BandProfile {
  low: number;
  mid: number;
  high: number;
}

export const SILENT_PROFILE: BandProfile = { low: 0, mid: 0, high: 0 };

export interface FeatureConfig {
  /** Коэффициент экспоненциального сглаживания, 0 — без инерции, 0.95 — очень вязко. */
  smoothing: number;
  energyGain: number;
  fluxGain: number;
  brightnessGain: number;
  noisinessGain: number;
  /** Во сколько раз flux должен превысить адаптивный порог, чтобы считаться ударом. */
  onsetThreshold: number;
  minOnsetIntervalMs: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  smoothing: 0.72,
  energyGain: 1,
  fluxGain: 1,
  brightnessGain: 1,
  noisinessGain: 1,
  onsetThreshold: 1.45,
  minOnsetIntervalMs: 110,
};

export interface RawFeatures {
  /** Линейные магнитуды спектра, длина fftSize/2. */
  spectrum: Float32Array;
  energy: number;
  brightness: number;
  noisiness: number;
  flux: number;
  onset: boolean;
  /** Насколько сильным был удар относительно порога, 0..1. Ноль вне onset-кадра. */
  onsetStrength: number;
  section: Section;
  /** Позиция энергии внутри окна тренда, -1..1: растёт или падает. */
  energySlope: number;
  /** Сглаженная энергия по полосам — на ней живут постоянные деформации. */
  bands: BandProfile;
  /**
   * Частотный профиль удара: какой полосе он принадлежит. Нули вне кадра
   * с onset'ом. Именно этим бас-бочка отличается от хай-хэта.
   */
  onsetProfile: BandProfile;
  silent: boolean;
}

/**
 * Держит убывающий пик сигнала, чтобы приводить произвольную громкость
 * источника к 0..1 без ручной настройки гейна.
 */
class AdaptiveNormalizer {
  private peak: number;

  constructor(private readonly decay: number, private readonly floor: number) {
    this.peak = floor;
  }

  normalize(value: number): number {
    if (value > this.peak) this.peak = value;
    else this.peak = Math.max(this.floor, this.peak * this.decay);
    return this.peak > 0 ? Math.min(1, value / this.peak) : 0;
  }
}

class Smoother {
  private value = 0;
  private primed = false;

  update(next: number, coefficient: number): number {
    if (!this.primed) {
      this.primed = true;
      this.value = next;
      return this.value;
    }
    const k = Math.min(0.995, Math.max(0, coefficient));
    this.value = this.value * k + next * (1 - k);
    return this.value;
  }

  get current(): number {
    return this.value;
  }
}

const SILENCE_RMS = 0.0015;

export class FeatureExtractor {
  private readonly freqDb: Float32Array<ArrayBuffer>;
  private readonly spectrum: Float32Array;
  private readonly prevSpectrum: Float32Array;
  private readonly timeDomain: Float32Array<ArrayBuffer>;
  private readonly binHz: number;

  private readonly energySm = new Smoother();
  private readonly brightSm = new Smoother();
  private readonly noiseSm = new Smoother();
  private readonly fluxSm = new Smoother();

  private readonly energyNorm = new AdaptiveNormalizer(0.9995, 0.01);
  private readonly fluxNorm = new AdaptiveNormalizer(0.999, 0.02);

  /**
   * У каждой полосы свой нормализатор: хай-хэт по абсолютной магнитуде всегда
   * проигрывает бочке, и без раздельной нормализации профиль удара был бы
   * всегда «низ».
   */
  private readonly bandFluxNorm = [
    new AdaptiveNormalizer(0.999, 0.01),
    new AdaptiveNormalizer(0.999, 0.01),
    new AdaptiveNormalizer(0.999, 0.01),
  ];
  private readonly bandEnergyNorm = [
    new AdaptiveNormalizer(0.9995, 0.005),
    new AdaptiveNormalizer(0.9995, 0.005),
    new AdaptiveNormalizer(0.9995, 0.005),
  ];
  private readonly bandSm = [new Smoother(), new Smoother(), new Smoother()];
  /** Границы полос в индексах бинов — считаются один раз. */
  private readonly lowMidBin: number;
  private readonly midHighBin: number;
  /** Нормализованный flux по полосам в текущем кадре. */
  private readonly bandFlux: BandProfile = { low: 0, mid: 0, high: 0 };

  /** Недавние значения flux — из них считается адаптивный порог onset'а. */
  private readonly fluxHistory: number[] = [];
  private lastOnsetAt = -Infinity;

  /** Кольцевой буфер энергии для окна тренда (~14 секунд при 60 fps). */
  private readonly trendWindow: number[] = [];
  private static readonly TREND_SAMPLES = 14 * 60;
  private section: Section = 'calm';
  private sectionSince = 0;
  private buildupScore = 0;

  constructor(private readonly analyser: AnalyserNode, sampleRate: number) {
    const bins = analyser.frequencyBinCount;
    this.freqDb = new Float32Array(bins);
    this.spectrum = new Float32Array(bins);
    this.prevSpectrum = new Float32Array(bins);
    this.timeDomain = new Float32Array(analyser.fftSize);
    this.binHz = sampleRate / analyser.fftSize;
    this.lowMidBin = Math.min(bins, Math.round(BAND_EDGES_HZ.lowMid / this.binHz));
    this.midHighBin = Math.min(bins, Math.round(BAND_EDGES_HZ.midHigh / this.binHz));
  }

  /** @param nowMs — время кадра, `performance.now()`. */
  analyze(nowMs: number, config: FeatureConfig): RawFeatures {
    this.analyser.getFloatFrequencyData(this.freqDb);
    this.analyser.getFloatTimeDomainData(this.timeDomain);

    const bins = this.spectrum.length;
    this.prevSpectrum.set(this.spectrum);

    let magnitudeSum = 0;
    let weightedSum = 0;
    let flux = 0;
    const rawBandFlux = [0, 0, 0];
    const rawBandEnergy = [0, 0, 0];

    for (let i = 0; i < bins; i++) {
      // dB → линейная магнитуда; -100 dB это наш пол тишины.
      const magnitude = this.freqDb[i] <= -100 ? 0 : Math.pow(10, this.freqDb[i] / 20);
      this.spectrum[i] = magnitude;
      magnitudeSum += magnitude;
      weightedSum += magnitude * i * this.binHz;
      const diff = magnitude - this.prevSpectrum[i];
      if (diff > 0) flux += diff; // half-wave rectification: интересны только нарастания

      const band = i < this.lowMidBin ? 0 : i < this.midHighBin ? 1 : 2;
      rawBandEnergy[band] += magnitude;
      if (diff > 0) rawBandFlux[band] += diff;
    }

    let sumSquares = 0;
    let crossings = 0;
    for (let i = 0; i < this.timeDomain.length; i++) {
      const sample = this.timeDomain[i];
      sumSquares += sample * sample;
      if (i > 0 && (sample >= 0) !== (this.timeDomain[i - 1] >= 0)) crossings++;
    }
    const rms = Math.sqrt(sumSquares / this.timeDomain.length);
    const silent = rms < SILENCE_RMS;

    const centroidHz = magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;
    const nyquist = this.binHz * bins;
    // Слух логарифмический: линейный centroid по Гц почти всегда «тусклый».
    const brightnessRaw = centroidHz > 0 ? Math.log2(1 + centroidHz / 40) / Math.log2(1 + nyquist / 40) : 0;
    const noisinessRaw = crossings / this.timeDomain.length; // 0..0.5 на практике

    const k = config.smoothing;
    const energy = clamp01(this.energySm.update(this.energyNorm.normalize(rms), k) * config.energyGain);
    const brightness = clamp01(this.brightSm.update(brightnessRaw, k) * config.brightnessGain);
    const noisiness = clamp01(this.noiseSm.update(noisinessRaw * 2.6, k) * config.noisinessGain);
    const fluxNormalized = this.fluxNorm.normalize(flux);
    const fluxSmoothed = clamp01(this.fluxSm.update(fluxNormalized, k * 0.6) * config.fluxGain);

    const bands: BandProfile = {
      low: clamp01(this.bandSm[0].update(this.bandEnergyNorm[0].normalize(rawBandEnergy[0]), k)),
      mid: clamp01(this.bandSm[1].update(this.bandEnergyNorm[1].normalize(rawBandEnergy[1]), k)),
      high: clamp01(this.bandSm[2].update(this.bandEnergyNorm[2].normalize(rawBandEnergy[2]), k)),
    };
    this.bandFlux.low = this.bandFluxNorm[0].normalize(rawBandFlux[0]);
    this.bandFlux.mid = this.bandFluxNorm[1].normalize(rawBandFlux[1]);
    this.bandFlux.high = this.bandFluxNorm[2].normalize(rawBandFlux[2]);

    const { onset, onsetStrength } = this.detectOnset(fluxNormalized, nowMs, config, silent);
    const { section, energySlope } = this.updateTrend(energy, nowMs, silent);

    return {
      spectrum: this.spectrum,
      energy,
      brightness,
      noisiness,
      flux: fluxSmoothed,
      onset,
      onsetStrength,
      section,
      energySlope,
      bands,
      // Профиль имеет смысл только в кадре удара: между ударами он шум.
      onsetProfile: onset ? normalizeProfile(this.bandFlux) : SILENT_PROFILE,
      silent,
    };
  }

  /**
   * Порог — медиана недавнего flux, умноженная на настраиваемый коэффициент.
   * Медиана устойчивее среднего: один дроп не задирает порог на секунды вперёд.
   */
  private detectOnset(
    flux: number,
    nowMs: number,
    config: FeatureConfig,
    silent: boolean,
  ): { onset: boolean; onsetStrength: number } {
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > 43) this.fluxHistory.shift(); // ~0.7 c при 60 fps

    if (silent || this.fluxHistory.length < 12) return { onset: false, onsetStrength: 0 };

    const sorted = [...this.fluxHistory].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const threshold = Math.max(0.04, median * config.onsetThreshold);

    if (flux <= threshold) return { onset: false, onsetStrength: 0 };
    if (nowMs - this.lastOnsetAt < config.minOnsetIntervalMs) return { onset: false, onsetStrength: 0 };

    this.lastOnsetAt = nowMs;
    return { onset: true, onsetStrength: clamp01((flux - threshold) / Math.max(0.05, 1 - threshold)) };
  }

  /**
   * Сравнивает «сейчас» (последняя секунда) со «всем окном» (~14 с).
   * Из соотношения и наклона получается макро-секция трека.
   */
  private updateTrend(energy: number, nowMs: number, silent: boolean): { section: Section; energySlope: number } {
    this.trendWindow.push(energy);
    if (this.trendWindow.length > FeatureExtractor.TREND_SAMPLES) this.trendWindow.shift();

    const n = this.trendWindow.length;
    if (n < 120) return { section: this.section, energySlope: 0 };

    const shortSpan = Math.min(60, n);
    const midSpan = Math.min(240, n);
    const shortAvg = average(this.trendWindow, n - shortSpan, n);
    const midAvg = average(this.trendWindow, n - midSpan, n - shortSpan);
    const longAvg = average(this.trendWindow, 0, n);
    const slope = clamp(-1, 1, (shortAvg - midAvg) * 4);

    // Билд-ап копится: несколько секунд подряд растущей энергии, а не один кадр.
    if (slope > 0.06 && shortAvg > longAvg) this.buildupScore = Math.min(1, this.buildupScore + 0.012);
    else this.buildupScore = Math.max(0, this.buildupScore - 0.02);

    let next: Section = 'steady';
    if (silent || shortAvg < longAvg * 0.55) next = 'calm';
    else if (this.buildupScore > 0.45 && slope > 0.09) next = 'drop';
    else if (this.buildupScore > 0.25) next = 'buildup';

    // Гистерезис: секция живёт минимум 1.2 с, иначе набор примитивов дёргается.
    const minHold = next === 'drop' ? 2200 : 1200;
    if (next !== this.section && nowMs - this.sectionSince > minHold) {
      this.section = next;
      this.sectionSince = nowMs;
      if (next === 'drop') this.buildupScore = 0; // дроп «разряжает» накопленный билд-ап
    } else if (this.sectionSince === 0) {
      this.sectionSince = nowMs;
    }

    return { section: this.section, energySlope: slope };
  }
}

function average(values: number[], from: number, to: number): number {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i];
  return sum / (to - from);
}

/** Профиль приводится к максимуму 1: важны пропорции полос, не их громкость. */
function normalizeProfile(profile: BandProfile): BandProfile {
  const peak = Math.max(profile.low, profile.mid, profile.high);
  if (peak <= 1e-6) return SILENT_PROFILE;
  return { low: profile.low / peak, mid: profile.mid / peak, high: profile.high / peak };
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clamp(min: number, max: number, value: number): number {
  return value < min ? min : value > max ? max : value;
}
