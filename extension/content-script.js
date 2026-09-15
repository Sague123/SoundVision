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
