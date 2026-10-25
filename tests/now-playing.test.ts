import { describe, expect, it } from 'vitest';
import {
  NowPlayingTracker, ageCorrectedPosition, currentPosition, parseHelperLine,
} from '@shared/now-playing-parse';
import type { TrackMessage } from '@shared/now-playing';

const track = (patch: Partial<TrackMessage> = {}): TrackMessage => ({
  type: 'track', artist: 'A', title: 'T', album: '', app: 'Spotify', durationMs: 200_000,
  positionMs: 10_000, positionAt: 1_000_000, isPlaying: true, cover: null, coverMime: null, ...patch,
});

describe('parseHelperLine', () => {
  it('читает трек', () => {
    const m = parseHelperLine(JSON.stringify(track({ cover: 'AAAA', coverMime: 'image/jpeg' })));
    expect(m).toMatchObject({ type: 'track', artist: 'A', title: 'T', cover: 'AAAA', coverMime: 'image/jpeg' });
  });

  it('переживает BOM и пробелы вокруг', () => {
    expect(parseHelperLine('﻿  {"type":"stopped"}  ')).toEqual({ type: 'stopped' });
  });

  it('не падает на мусоре и чужих строках', () => {
    for (const line of ['', 'Unhandled exception', '{не json', '[1,2]', '{"type":"unknown"}', 'null']) {
      expect(parseHelperLine(line)).toBeNull();
    }
  });

  it('трек без названия — это «ничего не играет»', () => {
    expect(parseHelperLine('{"type":"track","artist":"A","title":""}')).toEqual({ type: 'stopped' });
  });

  it('чинит неверные числа вместо падения', () => {
    const m = parseHelperLine('{"type":"track","title":"T","durationMs":-5,"positionMs":"x","isPlaying":1}');
    expect(m).toMatchObject({ durationMs: 0, positionMs: 0, isPlaying: false });
  });

  it('разбирает ошибку с кодом', () => {
    expect(parseHelperLine('{"type":"error","message":"нет доступа","code":"blocked"}'))
      .toEqual({ type: 'error', message: 'нет доступа', code: 'blocked' });
    expect(parseHelperLine('{"type":"error","message":"x","code":"странный"}')).toMatchObject({ code: undefined });
  });
});

describe('ageCorrectedPosition', () => {
  it('добавляет возраст снимка, пока играет', () => {
    expect(ageCorrectedPosition(track(), 1_000_500)).toBe(10_500);
  });
  it('на паузе позиция стоит', () => {
    expect(ageCorrectedPosition(track({ isPlaying: false }), 1_000_500)).toBe(10_000);
  });
  it('мусорный возраст отбрасывается', () => {
    expect(ageCorrectedPosition(track(), 999_000)).toBe(10_000);
    expect(ageCorrectedPosition(track(), 1_000_000 + 60_000)).toBe(10_000);
  });
  it('не выходит за длительность', () => {
    expect(ageCorrectedPosition(track({ positionMs: 199_900 }), 1_000_500)).toBe(200_000);
  });
});

describe('NowPlayingTracker', () => {
  it('помнит обложку, пока трек тот же, и сбрасывает на новом', () => {
    const t = new NowPlayingTracker();
    const first = t.apply(track({ cover: 'IMG', coverMime: 'image/png' }), 1_000_000);
    expect(first.coverUrl).toBe('data:image/png;base64,IMG');
    expect(t.apply(track({ positionAt: 1_001_000 }), 1_001_000).coverUrl).toBe('data:image/png;base64,IMG');
    expect(t.apply(track({ title: 'Другой' }), 1_002_000).coverUrl).toBeNull();
  });

  it('другая версия трека (иная длительность) — другой трек', () => {
    const t = new NowPlayingTracker();
    t.apply(track({ cover: 'IMG', coverMime: 'image/png' }), 1_000_000);
    expect(t.apply(track({ durationMs: 260_000 }), 1_000_100).coverUrl).toBeNull();
  });

  it('stopped очищает всё', () => {
    const t = new NowPlayingTracker();
    t.apply(track({ cover: 'IMG', coverMime: 'image/png' }), 1_000_000);
    const s = t.apply({ type: 'stopped' }, 1_000_100);
    expect(s).toMatchObject({ status: 'stopped', title: '', coverUrl: null });
  });

  it('hello и error состояние не трогают', () => {
    const t = new NowPlayingTracker();
    const before = t.apply(track(), 1_000_000);
    expect(t.apply({ type: 'hello', helper: 'x', version: '1' }, 1_000_050)).toBe(before);
    expect(t.apply({ type: 'error', message: 'e' }, 1_000_060)).toBe(before);
  });
});

describe('currentPosition', () => {
  const state = new NowPlayingTracker().apply(track({ positionAt: 0 }), 5_000);
  it('идёт вместе с часами', () => expect(currentPosition(state, 6_000)).toBe(11_000));
  it('на паузе стоит', () => {
    expect(currentPosition({ ...state, status: 'paused' }, 9_000)).toBe(10_000);
  });
  it('без известной длительности не обрезается', () => {
    expect(currentPosition({ ...state, durationMs: 0 }, 5_000 + 400_000)).toBe(410_000);
  });
});
