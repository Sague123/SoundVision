/**
 * Позиция в тексте: какая строка звучит сейчас, насколько она прожита и
 * какое слово подсвечивать. Позиция трека интерполируется между опросами
 * источника (см. now-playing.ts), поэтому здесь достаточно чистой арифметики.
 */

import type { Lyrics, LyricLine } from './lrclib.ts';

export interface LyricsPosition {
  line: LyricLine | null;
  lineIndex: number;
  previous: LyricLine | null;
  next: LyricLine | null;
  /** Прогресс внутри текущей строки, 0..1. */
  lineProgress: number;
  /** Индекс текущего слова внутри строки; -1 — слов нет или ещё не начались. */
  wordIndex: number;
  /** Сколько мс прошло с начала строки — по нему делается fade-in. */
  sinceLineMs: number;
}

/** Строка появляется чуть раньше своего таймкода — иначе она всегда опаздывает. */
const LEAD_IN_MS = 120;
/** Если следующей строки нет, считаем, что текущая длится столько. */
const TAIL_MS = 4000;

const EMPTY: LyricsPosition = {
  line: null,
  lineIndex: -1,
  previous: null,
  next: null,
  lineProgress: 0,
  wordIndex: -1,
  sinceLineMs: 0,
};

export class SyncEngine {
  private lyrics: Lyrics | null = null;
  /** Курсор последней найденной строки: почти всегда позиция идёт вперёд. */
  private cursor = 0;
  private offsetMs = 0;

  setLyrics(lyrics: Lyrics | null): void {
    this.lyrics = lyrics;
    this.cursor = 0;
  }

  get current(): Lyrics | null {
    return this.lyrics;
  }

  /** Ручная подстройка, если текст систематически спешит или опаздывает. */
  setOffset(ms: number): void {
    this.offsetMs = ms;
  }

  locate(positionMs: number): LyricsPosition {
    const lyrics = this.lyrics;
    if (!lyrics || lyrics.lines.length === 0 || !lyrics.synced) return EMPTY;

    const time = positionMs + this.offsetMs + LEAD_IN_MS;
    const lines = lyrics.lines;
    const index = this.findLine(lines, time);
    if (index < 0) {
      return { ...EMPTY, next: lines[0] ?? null };
    }

    const line = lines[index];
    const next = lines[index + 1] ?? null;
    const endMs = next ? next.timeMs : line.timeMs + TAIL_MS;
    const span = Math.max(1, endMs - line.timeMs);
    const sinceLineMs = time - line.timeMs;

    return {
      line,
      lineIndex: index,
      previous: lines[index - 1] ?? null,
      next,
      lineProgress: Math.min(1, Math.max(0, sinceLineMs / span)),
      wordIndex: findWord(line, time),
      sinceLineMs,
    };
  }

  /**
   * Линейный поиск от курсора: при обычном воспроизведении это 0-1 шаг.
   * На перемотке курсор сбрасывается и поиск идёт с начала.
   */
  private findLine(lines: LyricLine[], time: number): number {
    if (this.cursor >= lines.length || lines[this.cursor].timeMs > time) this.cursor = 0;

    let index = this.cursor;
    while (index + 1 < lines.length && lines[index + 1].timeMs <= time) index++;
    this.cursor = index;

    return lines[index].timeMs <= time ? index : -1;
  }
}

function findWord(line: LyricLine, time: number): number {
  if (!line.words) return -1;
  let index = -1;
  for (let i = 0; i < line.words.length; i++) {
    if (line.words[i].timeMs <= time) index = i;
    else break;
  }
  return index;
}
