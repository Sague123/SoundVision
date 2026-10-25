/**
 * Источник звука из потока PCM, который присылает помощник.
 *
 * Блоки приходят через IPC неровно, а аудио-поток требует ровно 128 отсчётов
 * каждые ~2.7 мс. Между ними — кольцевой буфер. Он держит небольшой запас
 * против рывков и не даёт отставанию расти: если накопилось больше
 * MAX_BUFFER_S, лишнее выбрасывается, потому что для светомузыки звук из
 * прошлого хуже короткого пропуска.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

const MAX_BUFFER_S = 0.12;
/** До какого запаса обрезаем при переполнении. */
const KEEP_BUFFER_S = 0.03;

class PcmFeed extends AudioWorkletProcessor {
  private readonly capacity = Math.ceil(sampleRate * 0.5);
  private readonly left = new Float32Array(this.capacity);
  private readonly right = new Float32Array(this.capacity);
  private write = 0;
  private read = 0;
  private buffered = 0;
  /** Пока запас не накопился, играем тишину: иначе первый же рывок даёт щелчок. */
  private primed = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<ArrayBuffer>) => this.push(new Float32Array(event.data));
  }

  private push(interleaved: Float32Array): void {
    const frames = Math.floor(interleaved.length / 2);
    for (let i = 0; i < frames; i++) {
      this.left[this.write] = interleaved[i * 2];
      this.right[this.write] = interleaved[i * 2 + 1];
      this.write = (this.write + 1) % this.capacity;
    }
    this.buffered = Math.min(this.capacity, this.buffered + frames);

    const max = Math.floor(sampleRate * MAX_BUFFER_S);
    if (this.buffered > max) {
      const keep = Math.floor(sampleRate * KEEP_BUFFER_S);
      this.read = (this.write - keep + this.capacity) % this.capacity;
      this.buffered = keep;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const length = out[0].length;
    if (!this.primed && this.buffered >= Math.floor(sampleRate * 0.01)) this.primed = true;

    for (let i = 0; i < length; i++) {
      if (this.primed && this.buffered > 0) {
        out[0][i] = this.left[this.read];
        if (out.length > 1) out[1][i] = this.right[this.read];
        this.read = (this.read + 1) % this.capacity;
        this.buffered--;
      } else {
        out[0][i] = 0;
        if (out.length > 1) out[1][i] = 0;
        if (this.buffered === 0) this.primed = false;
      }
    }
    return true;
  }
}

registerProcessor('pcm-feed', PcmFeed);

// Файл — модуль, чтобы объявления выше не пересекались с другим воркером.
export {};
