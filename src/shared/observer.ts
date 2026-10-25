/**
 * Что «Сейчас играет» реально отдаёт от каждого плеера.
 *
 * Главный риск этапа 0 — не знаем заранее, у каких плееров система отдаёт
 * название, обложку и позицию. Наблюдатель копит это за время работы, чтобы
 * отчёт говорил по фактам: Spotify отдал позицию, Chrome нет.
 */

import type { NowPlayingState } from './now-playing';

export type PlayerKind = 'spotify' | 'browser' | 'apple-music' | 'other';

export interface AppObservation {
  app: string;
  kind: PlayerKind;
  tracks: number;
  withCover: number;
  /** Большая сторона самой крупной обложки, пиксели; 0 — обложек не было. */
  maxCoverSide: number;
  withDuration: number;
  /** `advances` — позиция идёт вместе со временем; `frozen` — стоит, хотя играет. */
  position: 'advances' | 'frozen' | 'unknown';
  /** Самый большой возраст системного снимка позиции, мс: как редко плеер её обновляет. */
  positionStaleMs: number;
  example: string;
}

export function classifyApp(app: string): PlayerKind {
  if (/spotify/i.test(app)) return 'spotify';
  if (/chrome|chromium|msedge|edge|brave|firefox|opera|vivaldi|yandex/i.test(app)) return 'browser';
  if (/apple\.music|com\.apple\.music|itunes|^music$/i.test(app)) return 'apple-music';
  return 'other';
}

interface Entry extends AppObservation {
  lastKey: string;
  anchor: { position: number; at: number } | null;
}

/** Через сколько миллисекунд после первого замера позицию можно оценивать. */
const MIN_WINDOW_MS = 2000;

export class PlayerObserver {
  private readonly entries = new Map<string, Entry>();

  /** @returns ключ трека и приложение, чтобы вызвавший мог досчитать размер обложки. */
  observe(state: NowPlayingState): { app: string; key: string } | null {
    if (state.status === 'stopped' || !state.title) return null;
    const app = state.app || '(приложение неизвестно)';
    const key = `${state.artist}|${state.title}|${Math.round(state.durationMs / 2000)}`;
    let entry = this.entries.get(app);
    if (!entry) {
      entry = {
        app, kind: classifyApp(app), tracks: 0, withCover: 0, maxCoverSide: 0, withDuration: 0,
        position: 'unknown', positionStaleMs: 0, example: '', lastKey: '', anchor: null,
      };
      this.entries.set(app, entry);
    }

    if (entry.lastKey !== key) {
      entry.lastKey = key;
      entry.tracks++;
      if (state.coverUrl) entry.withCover++;
      if (state.durationMs > 0) entry.withDuration++;
      entry.example = `${state.artist} — ${state.title}`;
      entry.anchor = { position: state.positionMs, at: state.receivedAt };
    } else if (state.coverUrl && entry.withCover === 0) {
      // Обложка может прийти позже названия.
      entry.withCover = 1;
    }

    if (state.status === 'playing') entry.positionStaleMs = Math.max(entry.positionStaleMs, state.positionAgeMs);

    if (state.status === 'playing' && entry.anchor && entry.position === 'unknown') {
      const wall = state.receivedAt - entry.anchor.at;
      if (wall >= MIN_WINDOW_MS) {
        const delta = state.positionMs - entry.anchor.position;
        entry.position = delta >= wall * 0.5 ? 'advances' : 'frozen';
      }
    }
    return { app, key };
  }

  noteCoverSize(app: string, width: number, height: number): void {
    const entry = this.entries.get(app);
    if (entry) entry.maxCoverSide = Math.max(entry.maxCoverSide, width, height);
  }

  summary(): AppObservation[] {
    return [...this.entries.values()].map(({ lastKey: _k, anchor: _a, ...rest }) => ({ ...rest }));
  }
}
