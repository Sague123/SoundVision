/**
 * Уровни полос спектра для столбцов — общие для прямого и радиального
 * эквалайзера.
 *
 * Спектр сворачивается в полосы по логарифму частоты от 35 Гц до 16 кГц.
 * Уровень — в децибелах и складывается из двух частей. Главная — насколько
 * полоса сейчас громче своего же долгого среднего: так столбцы танцуют на
 * любом материале, а не стоят стеной там, где спектр ровный, и не упираются
 * в потолок басом. Вторая, меньшая — форма спектра относительно скользящего
 * максимума: без неё пропадает, где у трека вес. Всё вместе умножается на
 * общую энергию, поэтому дроп выше куплета. Атака мгновенная, спад плавный.
 */

/** Диапазон частот: ниже 35 Гц у динамиков ничего нет, выше 16 кГц — шум. */
const LOW_HZ = 35;
const HIGH_HZ = 16000;
/** Сколько децибел под скользящим максимумом ещё видно. */
const RANGE_DB = 54;
/** Насколько полоса должна превысить своё среднее, чтобы дойти до потолка. */
const SWING_DB = 18;
/** Где стоит полоса, пока она равна своему среднему (0..1). */
const REST_LEVEL = 0.3;
/** Доля абсолютной формы спектра в уровне. */
const SHAPE_SHARE = 0.25;

export class SpectrumBands {
  /** Уровни полос, 0..1. Длина — максимум полос; заполнены первые `bars`. */
  readonly values: Float32Array;
  /** Скользящий максимум уровня, дБ. */
  private topDb = -30;
  /** Долгое среднее каждой полосы, дБ; NaN — ещё не набрано. */
  private readonly averageDb: Float32Array;

  constructor(maxBars: number) {
    this.values = new Float32Array(maxBars);
    this.averageDb = new Float32Array(maxBars).fill(Number.NaN);
  }

  reset(): void {
    this.values.fill(0);
    this.averageDb.fill(Number.NaN);
    this.topDb = -30;
  }

  /**
   * Свернуть спектр кадра в `bars` полос. Там, где полоса уже одного бина
   * (низ спектра), значение интерполируется между соседними бинами — иначе
   * несколько полос подряд показывают один и тот же бин и стоят ступенькой.
   */
  update(spectrum: Float32Array, binHz: number, count: number, dt: number, energy: number): void {
    if (spectrum.length < 2) return;
    const bars = Math.min(count, this.values.length);
    const hz = binHz > 0 ? binHz : 48000 / 2048;
    const last = spectrum.length - 1;
    const ratio = HIGH_HZ / LOW_HZ;
    let frameTop = -120;
    const release = 1 - Math.exp(-dt / 0.14);
    const settle = 1 - Math.exp(-dt / 6);
    const loudness = 0.35 + 0.65 * Math.max(0, Math.min(1, energy));
    for (let i = 0; i < bars; i++) {
      const lowBin = (LOW_HZ * Math.pow(ratio, i / bars)) / hz;
      const highBin = (LOW_HZ * Math.pow(ratio, (i + 1) / bars)) / hz;
      let magnitude: number;
      if (highBin - lowBin < 1) {
        const centre = Math.min(last, (lowBin + highBin) / 2);
        const a = Math.floor(centre);
        const t = centre - a;
        magnitude = spectrum[a] * (1 - t) + spectrum[Math.min(last, a + 1)] * t;
      } else {
        magnitude = 0;
        const end = Math.min(last, Math.ceil(highBin));
        for (let bin = Math.floor(lowBin); bin <= end; bin++) {
          if (spectrum[bin] > magnitude) magnitude = spectrum[bin];
        }
      }
      const db = magnitude > 1e-6 ? 20 * Math.log10(magnitude) : -120;
      if (db > frameTop) frameTop = db;

      // Тишину в среднее не пускаем: после паузы столбцы не должны
      // выстреливать от любого шороха.
      let average = this.averageDb[i];
      if (db > -100) {
        average = Number.isNaN(average) ? db : average + (db - average) * settle;
        this.averageDb[i] = average;
      }
      const swing = Number.isNaN(average) || db <= -100
        ? 0
        : clamp01(REST_LEVEL + ((db - average) / SWING_DB) * (1 - REST_LEVEL));
      const shape = clamp01((db - (this.topDb - RANGE_DB)) / RANGE_DB);
      const level = (swing * (1 - SHAPE_SHARE) + shape * shape * SHAPE_SHARE) * loudness;
      // Атака мгновенная, спад — плавный.
      this.values[i] = level > this.values[i] ? level : this.values[i] + (level - this.values[i]) * release;
    }
    // Максимум догоняет громкое сразу, а тихое — за несколько секунд.
    if (frameTop > -100) {
      const k = frameTop > this.topDb ? 1 - Math.exp(-dt / 0.08) : 1 - Math.exp(-dt / 4);
      this.topDb += (frameTop - this.topDb) * k;
    }
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
