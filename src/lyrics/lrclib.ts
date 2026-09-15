/**
 * Синхронный текст с lrclib.net — бесплатно и без API-ключа.
 * Не нашли — просто не показываем текст, это штатная ситуация.
 *
 * Тексты песен защищены авторским правом; этот код рассчитан на личное
 * некоммерческое использование дома.
 */

const API_BASE = 'https://lrclib.net/api';

export interface LyricWord {
  timeMs: number;
  text: string;
}

export interface LyricLine {
  timeMs: number;
  text: string;
  /** Потайминг по словам, если он был в LRC (enhanced LRC). */
  words: LyricWord[] | null;
}

export interface Lyrics {
  lines: LyricLine[];
  synced: boolean;
  /** Есть ли хоть у одной строки word-level тайминги — от этого зависит караоке. */
  hasWordTiming: boolean;
}

interface LrclibResponse {
  syncedLyrics: string | null;
  plainLyrics: string | null;
}

/**
 * @param durationMs — длительность трека; lrclib использует её для отсева
 *   чужих версий с тем же названием. 0 — искать без неё.
 */
export async function fetchLyrics(
  artist: string,
  title: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  if (!artist && !title) return null;

  const exact = await requestGet(artist, title, durationMs, signal);
  if (exact) return exact;
  return requestSearch(artist, title, signal);
}

async function requestGet(
  artist: string,
  title: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<Lyrics | null> {
  const params = new URLSearchParams({ artist_name: artist, track_name: title });
  if (durationMs > 0) params.set('duration', String(Math.round(durationMs / 1000)));

  const response = await safeFetch(`${API_BASE}/get?${params.toString()}`, signal);
  if (!response?.ok) return null;
  return toLyrics((await response.json()) as LrclibResponse);
}

/** Запасной путь: точное совпадение не найдено — берём первый осмысленный результат поиска. */
async function requestSearch(artist: string, title: string, signal?: AbortSignal): Promise<Lyrics | null> {
  const params = new URLSearchParams({ artist_name: artist, track_name: title });
  const response = await safeFetch(`${API_BASE}/search?${params.toString()}`, signal);
  if (!response?.ok) return null;

  const results = (await response.json()) as LrclibResponse[];
  if (!Array.isArray(results)) return null;
  for (const result of results) {
    const lyrics = toLyrics(result);
    if (lyrics?.synced) return lyrics; // синхронный текст всегда лучше простого
  }
  return results.length > 0 ? toLyrics(results[0]) : null;
}

async function safeFetch(url: string, signal?: AbortSignal): Promise<Response | null> {
  try {
    return await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    console.warn('[lyrics] запрос не удался:', err);
    return null;
  }
}

function toLyrics(payload: LrclibResponse): Lyrics | null {
  if (payload.syncedLyrics) {
    const lines = parseLrc(payload.syncedLyrics);
    if (lines.length > 0) {
      return { lines, synced: true, hasWordTiming: lines.some((line) => line.words !== null) };
    }
  }
  if (payload.plainLyrics) {
    const lines = payload.plainLyrics
      .split('\n')
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ timeMs: 0, text, words: null }));
    if (lines.length > 0) return { lines, synced: false, hasWordTiming: false };
  }
  return null;
}

const LINE_TIME = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TIME = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g;

/** Разбор LRC, включая enhanced-формат со временем каждого слова. */
export function parseLrc(source: string): LyricLine[] {
  const lines: LyricLine[] = [];

  for (const raw of source.split('\n')) {
    LINE_TIME.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = LINE_TIME.exec(raw)) !== null) stamps.push(toMs(match));
    if (stamps.length === 0) continue;

    const body = raw.replace(LINE_TIME, '').trim();
    if (!body) continue;

    const words = parseWords(body);
    const text = body.replace(WORD_TIME, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    // Одна строка может иметь несколько таймкодов (повторяющийся припев).
    for (const timeMs of stamps) {
      lines.push({ timeMs, text, words: words ? shiftWords(words, timeMs) : null });
    }
  }

  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

function parseWords(body: string): LyricWord[] | null {
  WORD_TIME.lastIndex = 0;
  if (!WORD_TIME.test(body)) return null;

  WORD_TIME.lastIndex = 0;
  const words: LyricWord[] = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let lastTime = -1;

  while ((match = WORD_TIME.exec(body)) !== null) {
    if (lastTime >= 0) {
      const text = body.slice(lastIndex, match.index).trim();
      if (text) words.push({ timeMs: lastTime, text });
    }
    lastTime = toMs(match);
    lastIndex = match.index + match[0].length;
  }
  if (lastTime >= 0) {
    const text = body.slice(lastIndex).trim();
    if (text) words.push({ timeMs: lastTime, text });
  }
  return words.length > 0 ? words : null;
}

/**
 * Слова в enhanced LRC размечены абсолютным временем, но одна и та же строка
 * может повторяться с другим таймкодом — сдвигаем относительно первого слова.
 */
function shiftWords(words: LyricWord[], lineTimeMs: number): LyricWord[] {
  const base = words[0].timeMs;
  if (Math.abs(base - lineTimeMs) < 5) return words;
  const delta = lineTimeMs - base;
  return words.map((word) => ({ ...word, timeMs: word.timeMs + delta }));
}

function toMs(match: RegExpExecArray): number {
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ?? '0';
  // «.5» это 500 мс, «.50» — тоже 500, «.500» — тоже: дополняем до миллисекунд.
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
  return minutes * 60000 + seconds * 1000 + millis;
}
