/**
 * Системный звук на Windows: getDisplayMedia с выбором "Весь экран" отдаёт
 * аудиопоток всего устройства. Видео-трек нам не нужен — глушим сразу после
 * получения разрешения.
 */

export class CaptureError extends Error {
  constructor(message: string, readonly kind: 'denied' | 'no-audio' | 'unsupported' | 'failed') {
    super(message);
    this.name = 'CaptureError';
  }
}

/**
 * То, что анализу нужно от анализатора. Настоящий `AnalyserNode` подходит
 * как есть; звук из расширения YouTube Music приходит готовыми кадрами и
 * отдаётся через тот же интерфейс — анализ не знает, откуда звук.
 */
export type AnalyserLike = Pick<
  AnalyserNode, 'fftSize' | 'frequencyBinCount' | 'getFloatFrequencyData' | 'getFloatTimeDomainData'
>;

/** Любой источник звука для визуализации. */
export interface AudioInput {
  kind: 'system' | 'microphone' | 'bridge';
  sampleRate: number;
  analyser: AnalyserLike;
  /**
   * Анализаторы отдельных каналов. Нужны осциллографу в режиме XY: фигуры
   * Лиссажу рисуются из левого и правого каналов как из X и Y.
   * При моно-источнике оба указывают на один и тот же анализатор.
   */
  left: AnalyserLike;
  right: AnalyserLike;
  /** Действительно ли источник стерео. */
  stereo: boolean;
  /** Вызывается, когда источник кончился (например, остановлен шеринг экрана). */
  onEnded(cb: () => void): void;
  close(): void;
}

/** Захват через браузер: экран со звуком или микрофон. */
export interface AudioCapture extends AudioInput {
  kind: 'system' | 'microphone';
  stream: MediaStream;
  context: AudioContext;
  analyser: AnalyserNode;
  left: AnalyserNode;
  right: AnalyserNode;
  source: MediaStreamAudioSourceNode;
}

export const FFT_SIZE = 2048;

/** Все анализаторы настраиваются одинаково: сглаживаем мы сами, по фичам. */
function makeAnalyser(context: AudioContext): AnalyserNode {
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -10;
  return analyser;
}

export async function captureSystemAudio(): Promise<AudioCapture> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new CaptureError(
      'Браузер не поддерживает захват экрана со звуком. Нужен Chrome или Edge на Windows.',
      'unsupported',
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        // Всё, что «улучшает голос», портит музыку.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      // Подсказка браузеру открыть выбор экрана, а не вкладки.
      // @ts-expect-error — нестандартные поля Chrome, TS их не знает
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError') {
      throw new CaptureError('Доступ к захвату экрана отклонён.', 'denied');
    }
    throw new CaptureError(`Не удалось запустить захват: ${(err as Error).message}`, 'failed');
  }

  // Картинка не нужна — только разрешение на аудио, которое к ней прилагается.
  for (const track of stream.getVideoTracks()) track.stop();

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CaptureError(
      'В потоке нет звука. Выберите «Весь экран» и включите галочку «Также предоставить доступ к системному аудио».',
      'no-audio',
    );
  }

  return buildCapture(stream, audioTracks[0], 'system');
}

/**
 * Микрофон или линейный вход — «живой режим».
 *
 * Для концерта, диджейского пульта через звуковую карту или просто колонок в
 * комнате. Всё, что «улучшает голос», выключено: шумодав и автогейн режут
 * именно музыку — бочку принимают за шум, а громкость подтягивают так, что
 * дроп и тихий куплет становятся одинаковыми.
 */
export async function captureMicrophone(): Promise<AudioCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError('Браузер не даёт доступа к микрофону.', 'unsupported');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError') throw new CaptureError('Доступ к микрофону отклонён.', 'denied');
    if (name === 'NotFoundError') throw new CaptureError('Микрофон или линейный вход не найден.', 'no-audio');
    throw new CaptureError(`Не удалось открыть микрофон: ${(err as Error).message}`, 'failed');
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CaptureError('В потоке микрофона нет звука.', 'no-audio');
  }
  return buildCapture(stream, track, 'microphone');
}

/** Граф анализа одинаков для любого источника — различается только поток. */
async function buildCapture(
  stream: MediaStream,
  audioTrack: MediaStreamTrack,
  kind: AudioCapture['kind'],
): Promise<AudioCapture> {
  const context = new AudioContext({ latencyHint: 'interactive' });
  if (context.state === 'suspended') await context.resume();

  const source = context.createMediaStreamSource(stream);
  const analyser = makeAnalyser(context);
  source.connect(analyser);
  // Analyser никуда не выводим — звук не дублируем в колонки.

  // Каналы разводим отдельно: для фигур Лиссажу нужны именно две независимые
  // оси. Если источник моно, сплиттер отдаст один и тот же сигнал в оба
  // выхода — тогда XY выродится в диагональ, и примитив это учитывает.
  const stereo = (source.channelCount ?? 2) > 1;
  let left = analyser;
  let right = analyser;
  if (stereo) {
    const splitter = context.createChannelSplitter(2);
    source.connect(splitter);
    left = makeAnalyser(context);
    right = makeAnalyser(context);
    splitter.connect(left, 0);
    splitter.connect(right, 1);
  }

  const endedCallbacks: Array<() => void> = [];
  audioTrack.addEventListener('ended', () => endedCallbacks.forEach((cb) => cb()));

  return {
    kind,
    sampleRate: context.sampleRate,
    stream,
    context,
    analyser,
    left,
    right,
    stereo,
    source,
    onEnded(cb) {
      endedCallbacks.push(cb);
    },
    close() {
      stream.getTracks().forEach((t) => t.stop());
      source.disconnect();
      void context.close();
    },
  };
}
