/**
 * Автоусиление осциллограммы для примитивов, которые рисуют саму волну.
 *
 * Форма волны на экране должна читаться всегда, а не только на громком
 * дропе. Без усиления тихое интро давало размах ±0.15, и осциллограф
 * рисовал крошечную закорючку посреди чёрного кадра — картинка выглядела
 * сломанной. Громкость при этом не теряется: от энергии по-прежнему зависит
 * размер и яркость, усиление лишь приводит саму форму к читаемому масштабу.
 *
 * Пик ловится мгновенно и отпускается за пару секунд, поэтому удар не
 * «проваливает» усиление, а тишина не раздувается в шум: больше чем в шесть
 * раз волна не усиливается.
 */

/** К какому пику приводим форму. */
const TARGET_PEAK = 0.6;
const MAX_GAIN = 6;
const RELEASE_SEC = 2.2;

export class WaveformGain {
  private peak = TARGET_PEAK;

  /** @returns множитель для отсчётов этого кадра. */
  update(waveform: Float32Array, dtSec: number): number {
    let peak = 0;
    for (let i = 0; i < waveform.length; i++) {
      const v = waveform[i] < 0 ? -waveform[i] : waveform[i];
      if (v > peak) peak = v;
    }
    const k = 1 - Math.exp(-Math.max(0, dtSec) / RELEASE_SEC);
    this.peak = peak > this.peak ? peak : this.peak + (peak - this.peak) * k;
    // Не ослабляем громкое — только подтягиваем тихое.
    return Math.min(MAX_GAIN, Math.max(1, TARGET_PEAK / Math.max(1e-4, this.peak)));
  }
}
