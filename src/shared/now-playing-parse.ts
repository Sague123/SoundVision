/**
 * Разбор строк помощника «Сейчас играет». Чистые функции — без Electron и
 * без процессов, поэтому проверяются обычными тестами.
 */

import type { HelperMessage, NowPlayingState, TrackMessage } from './now-playing';

const MAX_LINE = 4 * 1024 * 1024;

/**
 * Одна строка NDJSON → сообщение или `null`, если строка не наша.
 * Помощники иногда печатают в stdout служебный текст (BOM, логи рантайма) —
 * это не должно ронять приложение.
 */
export function parseHelperLine(line: string): HelperMessage | null {
  if (line.length === 0 || line.length > MAX_LINE) return null;
  const text = line.replace(/^﻿/, '').trim();
  if (!text.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  switch (raw.type) {
    case 'hello':
      return { type: 'hello', helper: str(raw.helper), version: str(raw.version) };
    case 'stopped':
      return { type: 'stopped' };
    case 'error': {
      const code = raw.code === 'blocked' || raw.code === 'unsupported' || raw.code === 'failed' ? raw.code : undefined;
      return { type: 'error', message: str(raw.message), code };
    }
    case 'track': {
      const title = str(raw.title);
      // Трек без названия — это «ничего не играет», а не трек.
      if (!title) return { type: 'stopped' };
      return {
        type: 'track',
        artist: str(raw.artist),
        title,
        album: str(raw.album),
        app: str(raw.app),
        durationMs: num(raw.durationMs),
        positionMs: num(raw.positionMs),
        positionAt: num(raw.positionAt),
        positionAgeMs: num(raw.positionAgeMs),
        isPlaying: raw.isPlaying === true,
        cover: typeof raw.cover === 'string' && raw.cover.length > 0 ? raw.cover : null,
        coverMime: typeof raw.coverMime === 'string' && raw.coverMime ? raw.coverMime : null,
      };
    }
    default:
      return null;
  }
}

/**
 * Склейка потока сообщений в состояние. Помнит обложку между сообщениями:
 * помощник присылает её только на смене трека.
 */
export class NowPlayingTracker {
  private cover: string | null = null;
  private key = '';
  private state: NowPlayingState = emptyState(0);

  /** @param now `Date.now()` главного процесса. */
  apply(message: HelperMessage, now: number): NowPlayingState {
    if (message.type === 'stopped') {
      this.key = '';
      this.cover = null;
      this.state = emptyState(now);
      return this.state;
    }
    if (message.type !== 'track') return this.state;

    const key = trackKey(message);
    if (key !== this.key) {
      this.key = key;
      this.cover = null;
    }
    if (message.cover) this.cover = `data:${message.coverMime ?? 'image/png'};base64,${message.cover}`;

    this.state = {
      status: message.isPlaying ? 'playing' : 'paused',
      artist: message.artist,
      title: message.title,
      album: message.album,
      app: message.app,
      durationMs: message.durationMs,
      positionMs: ageCorrectedPosition(message, now),
      receivedAt: now,
      positionAgeMs: message.positionAgeMs ?? 0,
      coverUrl: this.cover,
    };
    return this.state;
  }
}

export function emptyState(now: number): NowPlayingState {
  return {
    status: 'stopped', artist: '', title: '', album: '', app: '',
    durationMs: 0, positionMs: 0, receivedAt: now, positionAgeMs: 0, coverUrl: null,
  };
}

/** Позиция «сейчас» с интерполяцией между сообщениями; на паузе стоит. */
export function currentPosition(state: NowPlayingState, now: number): number {
  if (state.status !== 'playing') return state.positionMs;
  const position = state.positionMs + Math.max(0, now - state.receivedAt);
  return state.durationMs > 0 ? Math.min(position, state.durationMs) : position;
}

/**
 * Позиция из сообщения помощника в часах главного процесса.
 *
 * Помощник присылает позицию на момент `positionAt` по своим часам. Часы
 * одной машины общие, поэтому разница `now - positionAt` — это настоящий
 * возраст снимка; он добавляется, пока трек играет. Слишком большой или
 * отрицательный возраст отбрасывается: у системных API он бывает мусорным.
 */
export function ageCorrectedPosition(message: TrackMessage, now: number): number {
  if (!message.isPlaying || message.positionAt <= 0) return message.positionMs;
  const age = now - message.positionAt;
  if (age < 0 || age > 30_000) return message.positionMs;
  const position = message.positionMs + age;
  return message.durationMs > 0 ? Math.min(position, message.durationMs) : position;
}

function trackKey(message: TrackMessage): string {
  return `${message.artist}|${message.title}|${Math.round(message.durationMs / 2000)}`.toLowerCase();
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
