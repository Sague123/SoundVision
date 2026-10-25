/**
 * Звук из вкладки YouTube Music без захвата экрана.
 *
 * Расширение подключается к плееру music.youtube.com через WebAudio, считает
 * там спектр и форму волны и шлёт готовые кадры через локальный мост. Здесь
 * кадры отдаются анализу через тот же интерфейс, что у `AnalyserNode`: для
 * анализа нет разницы, откуда звук. AudioContext на этой стороне не нужен
 * вовсе — поэтому визуализация стартует сама, без клика и без окна выбора.
 *
 * Формат кадра (little-endian), его же пишет `extension/content-script.js`:
 *
 *   0  u32  магия 0x31415653 («SVA1»)
 *   4  u32  частота дискретизации
 *   8  u16  размер FFT (2048)
 *  10  u8   флаги: бит 0 — стерео
 *  11  u8   резерв
 *  12  u32  номер кадра
 *  16  u8[fft/2]  спектр в байтах: 0..255 ↔ −100..−10 дБ, как getByteFrequencyData
 *  ..  i16[fft]   левый канал
 *  ..  i16[fft]   правый канал
 */

import { FFT_SIZE, type AnalyserLike, type AudioInput } from './capture.ts';

export const BRIDGE_AUDIO_MAGIC = 0x31415653;
const HEADER_BYTES = 16;
const MIN_DB = -100;
const MAX_DB = -10;
/** Дольше без кадров — звука нет: вкладку закрыли или плеер на паузе. */
const STALE_AFTER_MS = 1500;

export function bridgeFrameBytes(fftSize = FFT_SIZE): number {
  return HEADER_BYTES + fftSize / 2 + fftSize * 2 * 2;
}

/**
 * Собрать кадр. На стороне визуализатора нужен только для проверок и
 * смоук-стенда; расширение собирает тот же формат у себя.
 */
export function encodeBridgeFrame(
  spectrumBytes: Uint8Array,
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  stereo: boolean,
  seq: number,
): ArrayBuffer {
  const fft = left.length;
  const buffer = new ArrayBuffer(bridgeFrameBytes(fft));
  const view = new DataView(buffer);
  view.setUint32(0, BRIDGE_AUDIO_MAGIC, true);
  view.setUint32(4, sampleRate, true);
  view.setUint16(8, fft, true);
  view.setUint8(10, stereo ? 1 : 0);
  view.setUint32(12, seq >>> 0, true);
  new Uint8Array(buffer, HEADER_BYTES, fft / 2).set(spectrumBytes.subarray(0, fft / 2));
  const samples = new Int16Array(buffer, HEADER_BYTES + fft / 2, fft * 2);
  for (let i = 0; i < fft; i++) {
    samples[i] = toInt16(left[i]);
    samples[fft + i] = toInt16(right[i]);
  }
  return buffer;
}

function toInt16(value: number): number {
  const v = value > 1 ? 1 : value < -1 ? -1 : value;
  return Math.round(v * 32767);
}

export class BridgeAudioInput implements AudioInput {
  readonly kind = 'bridge' as const;
  sampleRate = 48000;
  stereo = true;
  readonly analyser: AnalyserLike;
  readonly left: AnalyserLike;
  readonly right: AnalyserLike;

  private readonly spectrum = new Uint8Array(FFT_SIZE / 2);
  private readonly leftSamples = new Float32Array(FFT_SIZE);
  private readonly rightSamples = new Float32Array(FFT_SIZE);
  private lastFrameAt = -Infinity;
  private frames = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.analyser = this.view('mix');
    this.left = this.view('left');
    this.right = this.view('right');
  }

  /** Есть ли свежий звук. */
  get live(): boolean {
    return this.clock() - this.lastFrameAt < STALE_AFTER_MS;
  }

  /** Сколько кадров принято — для отладки. */
  get received(): number {
    return this.frames;
  }

  /** @returns false, если кадр не наш или битый. */
  push(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < HEADER_BYTES) return false;
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== BRIDGE_AUDIO_MAGIC) return false;
    const fft = view.getUint16(8, true);
    // Анализ настроен на один размер FFT; другой размер — другая версия
    // расширения, такие кадры не смешиваем.
    if (fft !== FFT_SIZE || buffer.byteLength < bridgeFrameBytes(fft)) return false;

    this.sampleRate = view.getUint32(4, true) || this.sampleRate;
    this.stereo = (view.getUint8(10) & 1) === 1;
    this.spectrum.set(new Uint8Array(buffer, HEADER_BYTES, fft / 2));
    const samples = new Int16Array(buffer, HEADER_BYTES + fft / 2, fft * 2);
    for (let i = 0; i < fft; i++) {
      this.leftSamples[i] = samples[i] / 32767;
      this.rightSamples[i] = samples[fft + i] / 32767;
    }
    this.lastFrameAt = this.clock();
    this.frames++;
    return true;
  }

  onEnded(_cb: () => void): void {
    // Источник не кончается: без кадров он отдаёт тишину и ждёт следующих.
  }

  close(): void {
    this.lastFrameAt = -Infinity;
  }

  private view(channel: 'mix' | 'left' | 'right'): AnalyserLike {
    const self = this;
    return {
      fftSize: FFT_SIZE,
      frequencyBinCount: FFT_SIZE / 2,
      getFloatFrequencyData(out: Float32Array<ArrayBuffer>): void {
        const live = self.live;
        const n = Math.min(out.length, self.spectrum.length);
        for (let i = 0; i < n; i++) {
          out[i] = live ? MIN_DB + (self.spectrum[i] / 255) * (MAX_DB - MIN_DB) : MIN_DB;
        }
      },
      getFloatTimeDomainData(out: Float32Array<ArrayBuffer>): void {
        const n = Math.min(out.length, FFT_SIZE);
        if (!self.live) {
          out.fill(0, 0, n);
          return;
        }
        const l = self.leftSamples;
        const r = self.rightSamples;
        for (let i = 0; i < n; i++) {
          out[i] = channel === 'left' ? l[i] : channel === 'right' ? r[i] : (l[i] + r[i]) * 0.5;
        }
      },
    };
  }
}
