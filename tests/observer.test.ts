import { describe, expect, it } from 'vitest';
import { PlayerObserver, classifyApp } from '../src/shared/observer';
import type { NowPlayingState } from '../src/shared/now-playing';

const state = (patch: Partial<NowPlayingState> = {}): NowPlayingState => ({
  status: 'playing', artist: 'A', title: 'T', album: '', app: 'Spotify.exe', durationMs: 200_000,
  positionMs: 1_000, receivedAt: 10_000, positionAgeMs: 0, coverUrl: 'data:x', ...patch,
});

describe('classifyApp', () => {
  it('узнаёт плееры по идентификатору приложения', () => {
    expect(classifyApp('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')).toBe('spotify');
    expect(classifyApp('com.spotify.client')).toBe('spotify');
    expect(classifyApp('Chrome')).toBe('browser');
    expect(classifyApp('msedge.exe')).toBe('browser');
    expect(classifyApp('com.apple.Music')).toBe('apple-music');
    expect(classifyApp('foobar2000')).toBe('other');
  });
});

describe('PlayerObserver', () => {
  it('позиция идёт вместе со временем — advances', () => {
    const o = new PlayerObserver();
    o.observe(state());
    o.observe(state({ positionMs: 3_100, receivedAt: 12_100 }));
    expect(o.summary()[0]).toMatchObject({ position: 'advances', tracks: 1, withCover: 1, withDuration: 1 });
  });

  it('позиция стоит, хотя играет — frozen', () => {
    const o = new PlayerObserver();
    o.observe(state());
    o.observe(state({ positionMs: 1_000, receivedAt: 13_000 }));
    expect(o.summary()[0].position).toBe('frozen');
  });

  it('пока мало времени — unknown, на паузе не оцениваем', () => {
    const o = new PlayerObserver();
    o.observe(state());
    o.observe(state({ positionMs: 1_500, receivedAt: 10_500 }));
    expect(o.summary()[0].position).toBe('unknown');
    o.observe(state({ status: 'paused', positionMs: 1_000, receivedAt: 20_000 }));
    expect(o.summary()[0].position).toBe('unknown');
  });

  it('запоминает, насколько стареет снимок позиции', () => {
    const o = new PlayerObserver();
    o.observe(state({ positionAgeMs: 800 }));
    o.observe(state({ positionAgeMs: 4_200, receivedAt: 10_500 }));
    o.observe(state({ positionAgeMs: 100, receivedAt: 11_000 }));
    expect(o.summary()[0].positionStaleMs).toBe(4_200);
  });

  it('считает треки и приложения раздельно; обложка и размер', () => {
    const o = new PlayerObserver();
    o.observe(state());
    o.observe(state({ title: 'Другой', coverUrl: null, app: 'Chrome' }));
    o.noteCoverSize('Spotify.exe', 640, 640);
    const byApp = Object.fromEntries(o.summary().map((s) => [s.app, s]));
    expect(byApp['Spotify.exe']).toMatchObject({ withCover: 1, maxCoverSide: 640 });
    expect(byApp.Chrome).toMatchObject({ withCover: 0, kind: 'browser', example: 'A — Другой' });
  });

  it('остановку и пустое название игнорирует', () => {
    const o = new PlayerObserver();
    expect(o.observe(state({ status: 'stopped' }))).toBeNull();
    expect(o.observe(state({ title: '' }))).toBeNull();
    expect(o.summary()).toEqual([]);
  });
});
