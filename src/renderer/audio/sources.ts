/**
 * Источники звука за одним интерфейсом.
 *
 * Шоу слушает системный вывод. Как его получить, зависит от системы, поэтому
 * стратегии идут по очереди, пока одна не даст звуковую дорожку:
 *
 *   native-tap      помощник снимает системный звук сам и присылает поток
 *                   (macOS, Core Audio). Электрон этого не умеет — только
 *                   Windows — поэтому на Mac это основной путь.
 *   loopback        Electron отдаёт звук всего компьютера. Работает на Windows.
 *   virtual-device  виртуальное устройство (BlackHole и подобные) как вход.
 *   test-tone       тестовый сигнал для проверки цепочки, не музыка.
 *
 * Каждая попытка записывается: итог идёт в отчёт этапа 0, чтобы по нему было
 * видно, какая стратегия сработала на какой системе и почему другие нет.
 */

import { pickVirtualDevice } from './devices';
import pcmWorkletUrl from './pcm-feed.worklet.ts?worker&url';
import { createTestToneStream } from './test-tone';

export type StrategyId = 'native-tap' | 'loopback' | 'virtual-device' | 'test-tone';

export interface Attempt {
  strategy: StrategyId;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface OpenedAudio {
  stream: MediaStream;
  strategy: StrategyId;
  /** Подпись для панели. */
  label: string;
  /** Это тестовый сигнал, а не звук системы. */
  synthetic: boolean;
  /** Освободить всё, что открыла стратегия. */
  release: () => void;
}

export interface OpenOutcome {
  opened: OpenedAudio | null;
  attempts: Attempt[];
}

/** Звуку нужна чистая обработка: всё, что «улучшает голос», портит музыку. */
const RAW_AUDIO: MediaTrackConstraints = {
  echoCancellation: false, noiseSuppression: false, autoGainControl: false,
};

export interface OrderOptions {
  testTone: boolean;
  platform: string;
  /** Заглушка помощника: проверка цепочки без настоящего Mac. */
  fakeHelper: boolean;
}

/**
 * Порядок стратегий. На macOS loopback Electron не работает вовсе, поэтому его
 * там не пробуем: он только добавил бы ошибку в отчёт и мигание запроса прав.
 */
export function strategyOrder(options: OrderOptions): StrategyId[] {
  if (options.testTone) return ['test-tone'];
  if (options.platform === 'darwin') return ['native-tap', 'virtual-device'];
  if (options.fakeHelper) return ['native-tap'];
  return ['loopback', 'virtual-device'];
}

export async function openAudio(order: readonly StrategyId[]): Promise<OpenOutcome> {
  const attempts: Attempt[] = [];
  for (const strategy of order) {
    const started = performance.now();
    try {
      const opened = await run(strategy);
      attempts.push({ strategy, ok: true, detail: opened.label, ms: performance.now() - started });
      return { opened, attempts };
    } catch (error) {
      attempts.push({ strategy, ok: false, detail: describe(error), ms: performance.now() - started });
    }
  }
  return { opened: null, attempts };
}

function run(strategy: StrategyId): Promise<OpenedAudio> {
  switch (strategy) {
    case 'native-tap': return openNativeTap();
    case 'loopback': return openLoopback();
    case 'virtual-device': return openVirtualDevice();
    case 'test-tone': return Promise.resolve(openTestTone());
  }
}

async function openLoopback(): Promise<OpenedAudio> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('getDisplayMedia недоступен');
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: RAW_AUDIO });
  // Картинка не нужна — видеодорожка существует только ради разрешения на звук.
  stream.getVideoTracks().forEach((track) => track.stop());
  const audio = stream.getAudioTracks();
  if (audio.length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('запрос прошёл, но звуковой дорожки нет (система не отдаёт loopback)');
  }
  return {
    stream: new MediaStream(audio), strategy: 'loopback', label: 'Системный звук (loopback)', synthetic: false,
    release: () => audio.forEach((track) => track.stop()),
  };
}

async function openNativeTap(): Promise<OpenedAudio> {
  const sv = window.sv;
  const started = await sv.startNativeAudio();
  if (!started.ok) throw new Error(started.error);

  // Блоки PCM → воркер → MediaStream: дальше всё как у любого другого источника.
  const context = new AudioContext({ sampleRate: started.sampleRate, latencyHint: 'interactive' });
  try {
    await context.audioWorklet.addModule(pcmWorkletUrl);
  } catch (error) {
    void context.close();
    void sv.stopNativeAudio();
    throw error;
  }
  const node = new AudioWorkletNode(context, 'pcm-feed', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  const destination = context.createMediaStreamDestination();
  node.connect(destination);
  const stopListening = sv.onPcm((data) => node.port.postMessage(data, [data]));

  return {
    stream: destination.stream, strategy: 'native-tap', label: 'Системный звук (Core Audio, помощник)', synthetic: false,
    release: () => {
      stopListening();
      void sv.stopNativeAudio();
      destination.stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}

async function openVirtualDevice(): Promise<OpenedAudio> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia недоступен');
  // Названия устройств скрыты, пока не выдано разрешение, — получаем его временным потоком.
  const unlock = await navigator.mediaDevices.getUserMedia({ audio: true });
  unlock.getTracks().forEach((track) => track.stop());
  const devices = await navigator.mediaDevices.enumerateDevices();
  const device = pickVirtualDevice(devices);
  if (!device) {
    const inputs = devices.filter((d) => d.kind === 'audioinput').map((d) => d.label || '(без названия)');
    throw new Error(`виртуального устройства нет (входы: ${inputs.join(', ') || 'нет'})`);
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...RAW_AUDIO, deviceId: { exact: device.deviceId }, channelCount: { ideal: 2 } },
  });
  return {
    stream, strategy: 'virtual-device', label: `Устройство: ${device.label}`, synthetic: false,
    release: () => stream.getTracks().forEach((track) => track.stop()),
  };
}

function openTestTone(): OpenedAudio {
  const tone = createTestToneStream();
  return {
    stream: tone.stream, strategy: 'test-tone', label: 'ТЕСТОВЫЙ СИГНАЛ (не музыка)', synthetic: true,
    release: () => { tone.stream.getTracks().forEach((track) => track.stop()); tone.stop(); },
  };
}

function describe(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
