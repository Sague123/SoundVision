/**
 * Измеритель уровня в аудио-потоке.
 *
 * Работает в аудио-потоке браузера: на каждый блок в 128 отсчётов считает
 * сумму квадратов и пик и раз в ~10 мс отправляет итог интерфейсу вместе со
 * временем контекста. Интерфейс по разнице времён видит, насколько
 * опаздывает путь «аудио-поток → страница».
 *
 * Полноценный анализ (полосы, кик, снейр) — этап 1; здесь только то, чем
 * проверяется, что звук идёт и с какой задержкой.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare const currentTime: number;
declare const currentFrame: number;

/** Сколько отсчётов копить до отправки: ~10 мс при 48 кГц. */
const REPORT_FRAMES = 480;

class LevelMeter extends AudioWorkletProcessor {
  private sumSquares = 0;
  private peak = 0;
  private frames = 0;

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const length = channels[0].length;
      for (let i = 0; i < length; i++) {
        // Моно-свёртка: для уровня достаточно среднего каналов.
        let sample = 0;
        for (let c = 0; c < channels.length; c++) sample += channels[c][i];
        sample /= channels.length;
        this.sumSquares += sample * sample;
        const abs = sample < 0 ? -sample : sample;
        if (abs > this.peak) this.peak = abs;
      }
      this.frames += length;
    } else {
      // Нет входа — это тишина, а не пауза в данных.
      this.frames += 128;
    }

    if (this.frames >= REPORT_FRAMES) {
      this.port.postMessage({
        rms: Math.sqrt(this.sumSquares / this.frames),
        peak: this.peak,
        time: currentTime,
        frame: currentFrame,
      });
      this.sumSquares = 0;
      this.peak = 0;
      this.frames = 0;
    }
    return true;
  }
}

registerProcessor('level-meter', LevelMeter);
