/**
 * Семантические аудио-признаки для режиссёра.
 *
 * Сырые бины спектра визуальным модулям не отдаются: у каждого трека своя
 * громкость и своя частотная картина, и привязка «размер частицы ← бин 12»
 * на одном треке молчит, а на другом выжигает кадр. Здесь всё приводится к
 * смысловым величинам 0..1 с адаптивной нормализацией: «бас сейчас сильный
 * для этого трека», а не «бас громче 0.3 в абсолютных единицах».
 *
 * Считается на аудио-частоте (каждый кадр анализа, 30-100 раз в секунду) и
 * не выделяет памяти в цикле: все буферы заведены один раз.
 */

import type { MoodVector } from '../audio/mood-vector.ts';

export interface AudioFeatures {
  /** Громкость по среднеквадратичному, нормированная к треку. */
  rms: number;
  /** Пиковый уровень сигнала. */
  peak: number;
  /** Полосы: 20-150, 150-500, 500-2000, 2000-6000, 6000-16000 Гц. */
  bass: number;
  lowMid: number;
  mid: number;
  highMid: number;
  treble: number;
  /** Центр масс спектра по логарифмической шкале. */
  spectralCentroid: number;
  spectralFlux: number;
  /** Сила атаки: мгновенный подъём и быстрый спад, ~150 мс. */
  transientStrength: number;
  zeroCrossingRate: number;
  estimatedBPM: number;
  beatConfidence: number;
  beatPhase: number;
  energy: number;
  /** Разброс громкости за последние секунды: 0 — ровно, 1 — очень рвано. */
  dynamicRange: number;
  /** 1 — тишина, 0 — звучит. Плавный, без щелчка на пороге. */
  silenceLevel: number;
  /** Ширина стерео: 0 — моно, 1 — широкая сцена. */
  stereoWidth: number;
  /**
   * Похоже ли на голос: доля энергии в голосовой полосе при тональном, а не
   * шумовом спектре. Эвристика, а не распознавание — ей хватает, чтобы
   * отличить куплет с вокалом от инструментального дропа.
   */
  vocalLikelihood: number;
  /** Плотность ударов: сколько атак в секунду, нормировано. */
  rhythmicDensity: number;
  /** Куда идёт энергия: -1 падает, +1 растёт (несколько секунд). */
  energyTrend: number;
  /** Резкий скачок энергии прямо сейчас, 0..1. */
  energyJump: number;
  timeMs: number;
}

export const FEATURE_KEYS = [
  'rms', 'peak', 'bass', 'lowMid', 'mid', 'highMid', 'treble', 'spectralCentroid',
  'spectralFlux', 'transientStrength', 'zeroCrossingRate', 'beatConfidence', 'beatPhase',
  'energy', 'dynamicRange', 'silenceLevel', 'stereoWidth', 'vocalLikelihood',
  'rhythmicDensity', 'energyTrend', 'energyJump',
] as const;

/** Признаки, к которым можно привязать параметр эффекта. */
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function emptyFeatures(): AudioFeatures {
  return {
    rms: 0, peak: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
    spectralCentroid: 0.4, spectralFlux: 0, transientStrength: 0, zeroCrossingRate: 0,
    estimatedBPM: 120, beatConfidence: 0, beatPhase: 0, energy: 0, dynamicRange: 0,
    silenceLevel: 1, stereoWidth: 0, vocalLikelihood: 0, rhythmicDensity: 0,
    energyTrend: 0, energyJump: 0, timeMs: 0,
  };
}

/** Коэффициент экспоненциального сглаживания, не зависящий от частоты кадров. */
export function follow(dtSec: number, tauSec: number): number {
  return tauSec <= 0 ? 1 : 1 - Math.exp(-dtSec / tauSec);
}

/**
 * Адаптивный диапазон: медленно забываемые минимум и максимум.
 *
 * Максимум сразу поднимается до нового пика и сползает вниз за `tau`
 * секунд, минимум — зеркально. Нормируем внутри этого окна, но не уже
 * `minSpan`: иначе на ровном сигнале шум раздувался бы до 0..1.
 */
export class RangeTracker {
  private lo = Number.POSITIVE_INFINITY;
  private hi = Number.NEGATIVE_INFINITY;

  constructor(private readonly tauSec: number, private readonly minSpan: number) {}

  normalize(value: number, dtSec: number): number {
    if (!Number.isFinite(value)) return 0;
    if (!Number.isFinite(this.lo)) {
      this.lo = value;
      this.hi = value + this.minSpan;
    }
    const k = follow(dtSec, this.tauSec);
    this.hi = value > this.hi ? value : this.hi + (value - this.hi) * k;
    this.lo = value < this.lo ? value : this.lo + (value - this.lo) * k;
    const span = Math.max(this.minSpan, this.hi - this.lo);
    const floor = this.hi - span;
    return Math.min(1, Math.max(0, (value - floor) / span));
  }
}

const BANDS_HZ: ReadonlyArray<readonly [number, number]> = [
  [20, 150], [150, 500], [500, 2000], [2000, 6000], [6000, 16000],
];
/** Голосовая полоса — там живут форманты. */
const VOICE_HZ: readonly [number, number] = [300, 3400];

/** Окно разброса громкости: ~4 секунды на 60 Гц. */
const DYN_SAMPLES = 240;
const ONSET_SLOTS = 64;

export class AudioFeatureEngine {
  private readonly out = emptyFeatures();
  private binHz = 0;
  private readonly bandBins: Array<[number, number]> = BANDS_HZ.map(() => [0, 0]);
  private voiceBins: [number, number] = [0, 0];
  private totalBins = 0;

  private readonly bandRange = BANDS_HZ.map(() => new RangeTracker(9, 12));
  private readonly bandSmooth = new Float32Array(BANDS_HZ.length);
  private readonly rmsRange = new RangeTracker(10, 14);
  private readonly peakRange = new RangeTracker(10, 14);
  private readonly zcrRange = new RangeTracker(12, 0.02);

  private readonly dynRing = new Float32Array(DYN_SAMPLES);
  private readonly dynScratch = new Float32Array(DYN_SAMPLES);
  private dynCount = 0;
  private dynIndex = 0;
  private dynTick = 0;

  private readonly onsetTimes = new Float64Array(ONSET_SLOTS);
  private onsetIndex = 0;

  private transient = 0;
  private energyFast = 0;
  private energySlow = 0;
  private energyInstant = 0;
  private energyBase = 0;
  private vocal = 0;
  private readonly voiceBand = new ModulationMeter();
  private readonly bassBand = new ModulationMeter();
  private readonly voiceShare = new RangeTracker(12, 0.08);
  private width = 0;
  private primed = false;

  update(mood: MoodVector): AudioFeatures {
    const out = this.out;
    const dt = Math.min(0.1, Math.max(0.001, mood.deltaMs / 1000));
    if (mood.binHz !== this.binHz || mood.spectrum.length !== this.totalBins) {
      this.layoutBands(mood.binHz, mood.spectrum.length);
    }

    // --- уровень по времени ---
    const wave = mood.waveform;
    let sumSq = 0;
    let peak = 0;
    let crossings = 0;
    let prev = wave[0] ?? 0;
    for (let i = 0; i < wave.length; i++) {
      const v = wave[i];
      sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if ((v >= 0) !== (prev >= 0)) crossings++;
      prev = v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, wave.length));
    const rmsDb = 20 * Math.log10(rms + 1e-7);
    const peakDb = 20 * Math.log10(peak + 1e-7);
    out.rms = this.rmsRange.normalize(rmsDb, dt);
    out.peak = this.peakRange.normalize(peakDb, dt);
    out.zeroCrossingRate = this.zcrRange.normalize(crossings / Math.max(1, wave.length), dt);
    // Тишина — плавная рампа от -45 до -60 дБ, без щелчка на пороге.
    out.silenceLevel = mood.silent ? 1 : clamp01((-45 - rmsDb) / 15);

    // --- полосы ---
    const spectrum = mood.spectrum;
    let total = 0;
    let weighted = 0;
    for (let i = 1; i < spectrum.length; i++) {
      const m = spectrum[i];
      total += m;
      weighted += m * i;
    }
    for (let b = 0; b < BANDS_HZ.length; b++) {
      const [from, to] = this.bandBins[b];
      let e = 0;
      for (let i = from; i < to; i++) e += spectrum[i] * spectrum[i];
      const db = 10 * Math.log10(e / Math.max(1, to - from) + 1e-12);
      const norm = this.bandRange[b].normalize(db, dt);
      // Атака быстрее спада: удар должен читаться сразу, а гаснуть плавно.
      const tau = norm > this.bandSmooth[b] ? 0.03 : 0.18;
      this.bandSmooth[b] += (norm - this.bandSmooth[b]) * follow(dt, tau);
    }
    out.bass = this.bandSmooth[0];
    out.lowMid = this.bandSmooth[1];
    out.mid = this.bandSmooth[2];
    out.highMid = this.bandSmooth[3];
    out.treble = this.bandSmooth[4];

    // Центр масс по логарифму частоты: 100 Гц → 0, 8 кГц → 1.
    const centroidHz = total > 0 ? (weighted / total) * this.binHz : 0;
    out.spectralCentroid = clamp01(Math.log2(Math.max(100, centroidHz) / 100) / Math.log2(80));
    out.spectralFlux = clamp01(mood.flux);

    // --- атаки ---
    const hit = mood.onset ? Math.max(0.35, mood.onsetStrength) : 0;
    this.transient = hit > this.transient
      ? hit
      : this.transient * (1 - follow(dt, 0.15));
    out.transientStrength = clamp01(Math.max(this.transient, mood.flux * 0.35));
    if (mood.onset) {
      this.onsetTimes[this.onsetIndex] = mood.timeMs;
      this.onsetIndex = (this.onsetIndex + 1) % ONSET_SLOTS;
    }
    let recent = 0;
    for (let i = 0; i < ONSET_SLOTS; i++) {
      const t = this.onsetTimes[i];
      if (t > 0 && mood.timeMs - t < 4000) recent++;
    }
    // 8 атак в секунду — это уже сплошная дробь.
    out.rhythmicDensity = clamp01(recent / 4 / 8);

    // --- темп ---
    out.estimatedBPM = mood.bpm;
    out.beatConfidence = clamp01(mood.beatConfidence);
    out.beatPhase = mood.beatPhase;

    // --- энергия и её тренд ---
    out.energy = clamp01(mood.energy);
    if (!this.primed) {
      this.energyFast = this.energySlow = this.energyInstant = this.energyBase = out.energy;
      this.primed = true;
    }
    /*
     * Тренд — разность быстрого и медленного среднего. Окна короткие: с
     * медленным в пять секунд тренд после выхода на плато ещё долго считал
     * энергию растущей, и дроп секунд семь читался как «нарастание».
     */
    this.energyFast += (out.energy - this.energyFast) * follow(dt, 0.6);
    this.energySlow += (out.energy - this.energySlow) * follow(dt, 2.5);
    out.energyTrend = Math.max(-1, Math.min(1, (this.energyFast - this.energySlow) * 5));
    /*
     * Скачок — событие, а не состояние. База догоняет за 0.6 с: на ступеньке
     * скачок вспыхивает и гаснет, а не держится несколько секунд, заставляя
     * удар срабатывать снова и снова на одном и том же переходе.
     */
    this.energyInstant += (out.energy - this.energyInstant) * follow(dt, 0.05);
    this.energyBase += (out.energy - this.energyBase) * follow(dt, 0.6);
    out.energyJump = clamp01((this.energyInstant - this.energyBase) * 4);

    // --- разброс громкости за ~4 секунды ---
    this.dynRing[this.dynIndex] = rmsDb;
    this.dynIndex = (this.dynIndex + 1) % DYN_SAMPLES;
    this.dynCount = Math.min(DYN_SAMPLES, this.dynCount + 1);
    // Разброс меняется медленно — пересчёт раз в шесть кадров, ~10 Гц.
    this.dynTick = (this.dynTick + 1) % 6;
    if (this.dynCount === DYN_SAMPLES && this.dynTick === 0) {
      // Копия в заранее заведённый буфер и сортировка на месте: ни одного
      // нового объекта, даже подмассива, в аудио-цикле.
      this.dynScratch.set(this.dynRing);
      this.dynScratch.sort();
      const spread = this.dynScratch[Math.floor(DYN_SAMPLES * 0.95)]
        - this.dynScratch[Math.floor(DYN_SAMPLES * 0.1)];
      out.dynamicRange = clamp01(spread / 30);
    }

    // --- стерео ---
    out.stereoWidth = this.measureWidth(mood, dt);

    // --- голос ---
    out.vocalLikelihood = this.measureVocal(spectrum, total, dt);

    out.timeMs = mood.timeMs;
    return out;
  }

  private layoutBands(binHz: number, bins: number): void {
    this.binHz = binHz;
    this.totalBins = bins;
    const toBin = (hz: number): number => Math.min(bins, Math.max(1, Math.round(hz / binHz)));
    for (let b = 0; b < BANDS_HZ.length; b++) {
      const from = toBin(BANDS_HZ[b][0]);
      this.bandBins[b] = [from, Math.max(from + 1, toBin(BANDS_HZ[b][1]))];
    }
    this.voiceBins = [toBin(VOICE_HZ[0]), toBin(VOICE_HZ[1])];
  }

  /** Отношение боковой составляющей к средней: 0 — моно, 1 — широко. */
  private measureWidth(mood: MoodVector, dt: number): number {
    if (!mood.stereo) {
      this.width += (0 - this.width) * follow(dt, 0.5);
      return this.width;
    }
    const l = mood.waveform;
    const r = mood.waveformRight;
    let side = 0;
    let mid = 0;
    const n = Math.min(l.length, r.length);
    for (let i = 0; i < n; i++) {
      const s = (l[i] - r[i]) * 0.5;
      const m = (l[i] + r[i]) * 0.5;
      side += s * s;
      mid += m * m;
    }
    const target = clamp01(Math.sqrt(side / (mid + 1e-9)));
    this.width += (target - this.width) * follow(dt, 0.5);
    return this.width;
  }

  /**
   * Голос по слоговой модуляции.
   *
   * Первая версия искала тональный спектр в полосе формант, и это не
   * работало: в плотном миксе эта полоса тональна и без голоса — там же
   * гитары, клавиши, пэды. Надёжнее то, как голос меняется во времени:
   * слоги дают колебания уровня 2-8 раз в секунду. Ударные тоже колеблют
   * эту полосу, но синхронно с басом, поэтому засчитывается только та
   * модуляция голосовой полосы, которой нет в басу.
   */
  private measureVocal(spectrum: Float32Array, total: number, dt: number): number {
    const voiceDb = bandDb(spectrum, this.voiceBins[0], this.voiceBins[1]);
    const bassDb = bandDb(spectrum, this.bandBins[0][0], this.bandBins[0][1]);

    const voiceMod = this.voiceBand.update(voiceDb, dt);
    const bassMod = this.bassBand.update(bassDb, dt);

    // Доля полосы формант в общей энергии — голос обычно выходит вперёд.
    let voiceSum = 0;
    for (let i = this.voiceBins[0]; i < this.voiceBins[1]; i++) voiceSum += spectrum[i];
    const share = this.voiceShare.normalize(total > 0 ? voiceSum / total : 0, dt);

    /*
     * Вычитаем басовую модуляцию лишь частично. Полное вычитание съедало и
     * сам голос: бочка колеблет бас на ~1 дБ под любым куплетом, и от 1.8 дБ
     * слоговой модуляции оставалось 0.3. На синтетике голосовая полоса
     * колеблется на 1.8 дБ в куплете и на 0.1-0.26 дБ в остальных частях.
     * Порог подобран по синтетике — на живых треках его ещё калибровать.
     */
    const syllabic = clamp01((voiceMod - bassMod * 0.35) / 1.5);
    const target = syllabic * (0.4 + share * 0.6);
    this.vocal += (target - this.vocal) * follow(dt, 0.8);
    return this.vocal;
  }
}

/** Средний уровень полосы в децибелах. */
function bandDb(spectrum: Float32Array, from: number, to: number): number {
  let e = 0;
  for (let i = from; i < to; i++) e += spectrum[i] * spectrum[i];
  return 10 * Math.log10(e / Math.max(1, to - from) + 1e-12);
}

/**
 * Глубина модуляции уровня в полосе 2-8 Гц: разность двух средних выделяет
 * именно эту полосу частот огибающей, модуль и сглаживание дают её размах.
 */
class ModulationMeter {
  private fast = 0;
  private slow = 0;
  private depth = 0;
  private primed = false;

  update(db: number, dt: number): number {
    if (!this.primed) {
      this.fast = this.slow = db;
      this.primed = true;
    }
    this.fast += (db - this.fast) * follow(dt, 0.03);
    this.slow += (db - this.slow) * follow(dt, 0.2);
    this.depth += (Math.abs(this.fast - this.slow) - this.depth) * follow(dt, 0.6);
    return this.depth;
  }
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
