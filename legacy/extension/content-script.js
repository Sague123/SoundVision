/**
 * Content script для music.youtube.com.
 *
 * Данные берём в два приёма:
 *  1. navigator.mediaSession.metadata — то, что сам плеер отдаёт системе.
 *     Устойчиво к редизайнам вёрстки, поэтому это основной источник.
 *  2. DOM-селекторы плеера — запасной вариант, если mediaSession пуст.
 * Позиция и длительность всегда берутся из <video>: это надёжнее прогресс-бара.
 *
 * Хрупкое место проекта: селекторы ниже могут отвалиться после редизайна
 * music.youtube.com. Если обложка/название пропали — чинить нужно здесь.
 */

const POLL_INTERVAL_MS = 1000;
const PLAYER_BAR = 'ytmusic-player-bar';

let lastPayload = '';

function readFromMediaSession() {
  const metadata = navigator.mediaSession && navigator.mediaSession.metadata;
  if (!metadata || !metadata.title) return null;
  const artwork = (metadata.artwork || [])
    .slice()
    .sort((a, b) => sizeOf(b.sizes) - sizeOf(a.sizes))[0];
  return {
    title: metadata.title,
    artist: metadata.artist || '',
    coverUrl: artwork ? artwork.src : null,
  };
}

function sizeOf(sizes) {
  if (!sizes) return 0;
  const match = /(\d+)x(\d+)/.exec(sizes);
  return match ? Number(match[1]) : 0;
}

function readFromDom() {
  const bar = document.querySelector(PLAYER_BAR);
  if (!bar) return null;
  const title = bar.querySelector('.title')?.textContent?.trim();
  if (!title) return null;

  // Byline — это «Артист • Альбом • Год», нам нужна только первая часть.
  const byline = bar.querySelector('.byline')?.textContent?.trim() ?? '';
  const image = bar.querySelector('img.image');
  return {
    title,
    artist: byline.split('•')[0].trim(),
    coverUrl: image ? upgradeThumbnail(image.src) : null,
  };
}

/** В плеер-баре обложка крошечная; у Google-миниатюр размер зашит в URL. */
function upgradeThumbnail(url) {
  if (!url) return null;
  return url.replace(/=w\d+-h\d+/, '=w544-h544');
}

function collect() {
  const video = document.querySelector('video');
  const meta = readFromMediaSession() ?? readFromDom();
  if (!meta || !video) return { type: 'stopped' };

  return {
    type: 'now-playing',
    title: meta.title,
    artist: meta.artist,
    coverUrl: meta.coverUrl,
    positionMs: Math.round((video.currentTime || 0) * 1000),
    durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
    isPlaying: !video.paused && !video.ended,
  };
}

function tick() {
  let payload;
  try {
    payload = collect();
  } catch (err) {
    console.warn('[SoundVision] не удалось прочитать плеер:', err);
    return;
  }

  // Позиция меняется каждую секунду, поэтому сравниваем без неё:
  // фоновый скрипт всё равно шлёт обновления по таймеру.
  const signature = JSON.stringify({ ...payload, positionMs: 0 });
  const changed = signature !== lastPayload;
  lastPayload = signature;

  chrome.runtime.sendMessage({ kind: 'soundvision:update', payload, changed }).catch(() => {
    // Service worker мог заснуть — следующий тик разбудит его снова.
  });
}

setInterval(tick, POLL_INTERVAL_MS);
tick();

/* --- Звук плеера без захвата экрана -------------------------------------
 *
 * Плеер music.youtube.com играет через <video>. Подключаемся к нему через
 * WebAudio: createMediaElementSource пропускает звук через наш граф, анализ
 * идёт прямо здесь, а в колонки звук уходит тем же путём (source →
 * destination). Визуализатору уходят готовые кадры: спектр и форма волны
 * обоих каналов. Окна выбора источника нет вовсе.
 *
 * Осторожность одна: после createMediaElementSource звук плеера идёт только
 * через наш AudioContext. Пока тот не запущен (браузер не даёт стартовать
 * звуку без клика по странице), подключаться нельзя — плеер онемеет.
 * Поэтому ждём, пока контекст реально заработает, и только потом
 * перехватываем элемент.
 *
 * Формат кадра описан в src/audio/bridge-audio.ts — он обязан совпадать.
 */

const FFT_SIZE = 2048;
const AUDIO_MAGIC = 0x31415653;
const HEADER_BYTES = 16;
/** ~60 кадров в секунду: у звучащей вкладки таймеры не троттлятся. */
const AUDIO_INTERVAL_MS = 16;

const tap = {
  context: null,
  element: null,
  analyserLeft: null,
  analyserRight: null,
  analyserMix: null,
  spectrum: new Uint8Array(FFT_SIZE / 2),
  left: new Float32Array(FFT_SIZE),
  right: new Float32Array(FFT_SIZE),
  frame: new ArrayBuffer(HEADER_BYTES + FFT_SIZE / 2 + FFT_SIZE * 4),
  seq: 0,
  port: null,
  failed: false,
};

function makeAnalyser(context) {
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -10;
  return analyser;
}

function ensureContext() {
  if (!tap.context) {
    try {
      tap.context = new AudioContext({ latencyHint: 'interactive' });
    } catch (err) {
      console.warn('[SoundVision] AudioContext недоступен:', err);
      tap.failed = true;
      return false;
    }
  }
  if (tap.context.state !== 'running') {
    // Без жеста пользователя resume может не сработать — тогда ждём клика.
    tap.context.resume().catch(() => {});
    return false;
  }
  return true;
}

function attach(video) {
  if (tap.element === video || tap.failed) return;
  if (!ensureContext()) return;
  try {
    const context = tap.context;
    const source = context.createMediaElementSource(video);
    // Звук в колонки — первым делом: без этого плеер замолчит.
    source.connect(context.destination);
    tap.analyserMix = makeAnalyser(context);
    tap.analyserLeft = makeAnalyser(context);
    tap.analyserRight = makeAnalyser(context);
    source.connect(tap.analyserMix);
    const splitter = context.createChannelSplitter(2);
    source.connect(splitter);
    splitter.connect(tap.analyserLeft, 0);
    splitter.connect(tap.analyserRight, 1);
    tap.element = video;
    console.info('[SoundVision] звук плеера подключён');
  } catch (err) {
    // Элемент уже кем-то перехвачен или браузер против — метаданные всё
    // равно идут, звук тогда брать захватом экрана.
    console.warn('[SoundVision] не удалось подключиться к звуку плеера:', err);
    tap.failed = true;
  }
}

function audioPort() {
  if (tap.port) return tap.port;
  try {
    tap.port = chrome.runtime.connect({ name: 'soundvision-audio' });
    tap.port.onDisconnect.addListener(() => {
      tap.port = null;
    });
  } catch {
    // Расширение перезагрузили — этот скрипт осиротел, ждать нечего.
    tap.port = null;
  }
  return tap.port;
}

function encodeFrame() {
  const buffer = tap.frame;
  const view = new DataView(buffer);
  view.setUint32(0, AUDIO_MAGIC, true);
  view.setUint32(4, tap.context.sampleRate, true);
  view.setUint16(8, FFT_SIZE, true);
  view.setUint8(10, 1);
  view.setUint8(11, 0);
  view.setUint32(12, tap.seq++ >>> 0, true);
  new Uint8Array(buffer, HEADER_BYTES, FFT_SIZE / 2).set(tap.spectrum);
  const samples = new Int16Array(buffer, HEADER_BYTES + FFT_SIZE / 2, FFT_SIZE * 2);
  for (let i = 0; i < FFT_SIZE; i++) {
    const l = Math.max(-1, Math.min(1, tap.left[i]));
    const r = Math.max(-1, Math.min(1, tap.right[i]));
    samples[i] = Math.round(l * 32767);
    samples[FFT_SIZE + i] = Math.round(r * 32767);
  }
  // Сообщения расширения — это JSON: двоичное идёт строкой base64.
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function audioTick() {
  const video = document.querySelector('video');
  if (!video) return;
  if (tap.element !== video) attach(video);
  if (tap.element !== video || !tap.analyserMix) return;
  // На паузе кадры не шлём: визуализатор сам поймёт тишину по их отсутствию.
  if (video.paused || video.ended) return;

  tap.analyserMix.getByteFrequencyData(tap.spectrum);
  tap.analyserLeft.getFloatTimeDomainData(tap.left);
  tap.analyserRight.getFloatTimeDomainData(tap.right);
  const port = audioPort();
  if (!port) return;
  try {
    port.postMessage({ kind: 'soundvision:audio', data: encodeFrame() });
  } catch {
    tap.port = null;
  }
}

// Первый клик по странице разрешает браузеру запустить звук — сразу
// пробуем подключиться, не дожидаясь следующего тика.
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, () => {
    if (tap.context && tap.context.state !== 'running') tap.context.resume().catch(() => {});
  }, { capture: true, passive: true });
}

setInterval(audioTick, AUDIO_INTERVAL_MS);
