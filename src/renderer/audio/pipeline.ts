/**
 * Аудио-конвейер: поток → контекст → измеритель в воркере + анализатор.
 *
 * Звук никуда не выводится: мы слушаем то, что и так играет в колонках, и не
 * дублируем его.
 */

import workletUrl from './level-meter.worklet.ts?worker&url';

export interface AudioStats {
  state: AudioContextState;
  sampleRate: number;
  channels: number;
  /** Задержка самого контекста, мс. Задержка захвата сюда не входит: её нечем измерить. */
  baseLatencyMs: number;
  outputLatencyMs: number;
  /** Насколько воркер опаздывает относительно страницы, мс. */
  workletLagMs: number;
  workletMaxGapMs: number;
  workletRateHz: number;
  rmsDb: number;
  peakDb: number;
  /** Уровни трёх полос 0..1 (низ, середина, верх) — только для индикаторов. */
  bands: [number, number, number];
  /** Сколько миллисекунд подряд тишина; 0 — звук есть. */
  silentMs: number;
}

const SILENCE_PEAK = 1e-4;
/** Постоянная спада показаний: ~0.4 с до e-кратного падения. */
const HOLD_TAU_MS = 400;
const FFT = 2048;

export class AudioPipeline {
  readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly node: AudioWorkletNode;
  private readonly spectrum = new Float32Array(FFT / 2);
  private readonly channels: number;

  private rms = 0;
  private peak = 0;
  /** Показания для индикаторов: пик держится и плавно падает, а не мигает между ударами. */
  private rmsHold = 0;
  private peakHold = 0;
  private holdAt = performance.now();
  private lagMs = 0;
  private lastMessageAt = 0;
  private maxGapMs = 0;
  private gapWindowStart = 0;
  private gapMax = 0;
  private messagesInWindow = 0;
  private rateHz = 0;
  private lastLoudAt = 0;
  private closed = false;

  private constructor(readonly stream: MediaStream, context: AudioContext, analyser: AnalyserNode, node: AudioWorkletNode) {
    this.context = context;
    this.analyser = analyser;
    this.node = node;
    this.channels = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 2;
    const now = performance.now();
    this.lastLoudAt = now;
    this.gapWindowStart = now;
    node.port.onmessage = (event: MessageEvent<{ rms: number; peak: number; time: number }>) => this.onMessage(event.data);
  }

  static async create(stream: MediaStream): Promise<AudioPipeline> {
    const context = new AudioContext({ latencyHint: 'interactive' });
    if (context.state === 'suspended') await context.resume();
    await context.audioWorklet.addModule(workletUrl);

    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'level-meter', { numberOfInputs: 1, numberOfOutputs: 0 });
    const analyser = context.createAnalyser();
    analyser.fftSize = FFT;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    source.connect(node);
    source.connect(analyser);
    return new AudioPipeline(stream, context, analyser, node);
  }

  private onMessage(data: { rms: number; peak: number; time: number }): void {
    const now = performance.now();
    if (this.lastMessageAt > 0) this.gapMax = Math.max(this.gapMax, now - this.lastMessageAt);
    this.lastMessageAt = now;
    this.messagesInWindow++;
    this.rms = data.rms;
    this.peak = data.peak;
    // Время контекста в момент получения минус время блока — возраст сообщения.
    this.lagMs = Math.max(0, (this.context.currentTime - data.time) * 1000);
    if (data.peak > SILENCE_PEAK) this.lastLoudAt = now;

    if (now - this.gapWindowStart >= 1000) {
      this.rateHz = (this.messagesInWindow * 1000) / (now - this.gapWindowStart);
      this.maxGapMs = this.gapMax;
      this.gapMax = 0;
      this.messagesInWindow = 0;
      this.gapWindowStart = now;
    }
  }

  stats(): AudioStats {
    const now = performance.now();
    const decay = Math.exp(-(now - this.holdAt) / HOLD_TAU_MS);
    this.holdAt = now;
    this.rmsHold = Math.max(this.rms, this.rmsHold * decay);
    this.peakHold = Math.max(this.peak, this.peakHold * decay);
    this.analyser.getFloatFrequencyData(this.spectrum);
    const binHz = this.context.sampleRate / FFT;
    return {
      state: this.context.state,
      sampleRate: this.context.sampleRate,
      channels: this.channels,
      baseLatencyMs: this.context.baseLatency * 1000,
      outputLatencyMs: ('outputLatency' in this.context ? this.context.outputLatency : 0) * 1000,
      workletLagMs: this.lagMs,
      workletMaxGapMs: this.maxGapMs,
      workletRateHz: this.rateHz,
      rmsDb: toDb(this.rmsHold),
      peakDb: toDb(this.peakHold),
      bands: [
        bandLevel(this.spectrum, binHz, 20, 150),
        bandLevel(this.spectrum, binHz, 150, 2000),
        bandLevel(this.spectrum, binHz, 2000, 12000),
      ],
      silentMs: this.peak > SILENCE_PEAK ? 0 : now - this.lastLoudAt,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.node.port.onmessage = null;
    this.stream.getTracks().forEach((track) => track.stop());
    void this.context.close();
  }
}

export function toDb(amplitude: number): number {
  return amplitude > 1e-6 ? 20 * Math.log10(amplitude) : -120;
}

/** Уровень полосы 0..1: среднее по бинам в дБ, −80…−10 дБ растянуты на шкалу. */
export function bandLevel(spectrumDb: Float32Array, binHz: number, fromHz: number, toHz: number): number {
  const from = Math.max(0, Math.floor(fromHz / binHz));
  const to = Math.min(spectrumDb.length - 1, Math.ceil(toHz / binHz));
  let max = -120;
  for (let i = from; i <= to; i++) if (spectrumDb[i] > max) max = spectrumDb[i];
  return Math.min(1, Math.max(0, (max + 80) / 70));
}
