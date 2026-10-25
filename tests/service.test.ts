import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LineSplitter, NowPlayingService, type SpawnFn } from '../src/main/now-playing/service';
import { resolveHelper } from '../src/main/now-playing/helper-path';
import type { NowPlayingState } from '../src/shared/now-playing';

const FAKE = resolve('helpers/fake/now-playing.mjs');

function fakeSpec(env: Record<string, string> = {}) {
  return { command: process.execPath, args: [FAKE], env, label: 'fake' };
}

function waitFor<T>(check: () => T | undefined | false, ms = 8000): Promise<T> {
  return new Promise((ok, fail) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = check();
      if (value) { clearInterval(timer); ok(value as T); }
      else if (Date.now() - started > ms) { clearInterval(timer); fail(new Error('не дождались')); }
    }, 25);
  });
}

describe('LineSplitter', () => {
  it('склеивает разорванные сообщения и понимает CRLF', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\r\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.push(':3}\n')).toEqual(['{"c":3}']);
  });
});

describe('NowPlayingService с заглушкой помощника', () => {
  it('получает hello и трек с обложкой', async () => {
    const service = new NowPlayingService(fakeSpec(), null, { spawn: spawn as unknown as SpawnFn });
    const states: NowPlayingState[] = [];
    service.on('state', (s) => states.push(s));
    service.start();
    try {
      const state = await waitFor(() => states.find((s) => s.status === 'playing'));
      expect(state.title).toBe('Первая композиция');
      expect(state.coverUrl).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(service.getStatus()).toMatchObject({ helper: 'fake', running: true });
    } finally {
      service.stop();
    }
  });

  it('перезапускает упавшего помощника', async () => {
    const service = new NowPlayingService(fakeSpec({ FAKE_EXIT_AFTER_MS: '300' }), null, {
      spawn: spawn as unknown as SpawnFn, restartBaseMs: 50, restartMaxMs: 100,
    });
    service.start();
    try {
      await waitFor(() => service.getStatus().restarts >= 2);
      expect(service.getStatus().lastError).toMatch(/завершился \(код 3/);
    } finally {
      service.stop();
    }
  });

  it('после остановки больше не перезапускает', async () => {
    const service = new NowPlayingService(fakeSpec(), null, { spawn: spawn as unknown as SpawnFn });
    service.start();
    await waitFor(() => service.getStatus().running);
    service.stop();
    await new Promise((r) => setTimeout(r, 400));
    expect(service.getStatus()).toMatchObject({ running: false, restarts: 0 });
  });

  it('без помощника сообщает причину, а не падает', () => {
    const service = new NowPlayingService(null, 'помощник не собран: x');
    service.start();
    expect(service.getStatus()).toMatchObject({ running: false, lastError: 'помощник не собран: x' });
  });
});

describe('resolveHelper', () => {
  const base = {
    platform: 'win32' as NodeJS.Platform, packaged: false, resourcesPath: '/res', appPath: '/app',
    fake: false, execPath: '/electron', exists: () => true,
  };
  it('в разработке ищет в helpers-bin', () => {
    expect(resolveHelper(base).spec?.command).toMatch(/helpers-bin[\\/]win[\\/]NowPlaying\.exe$/);
    expect(resolveHelper({ ...base, platform: 'darwin' }).spec?.command).toMatch(/helpers-bin[\\/]mac[\\/]NowPlayingHelper$/);
  });
  it('в сборке — в resources/helpers', () => {
    expect(resolveHelper({ ...base, packaged: true }).spec?.command).toMatch(/res[\\/]helpers[\\/]NowPlaying\.exe$/);
  });
  it('говорит причину, если файла нет или система не поддерживается', () => {
    expect(resolveHelper({ ...base, exists: () => false }).reason).toMatch(/не собран/);
    expect(resolveHelper({ ...base, packaged: true, exists: () => false }).reason).toMatch(/не вошёл в сборку/);
    expect(resolveHelper({ ...base, platform: 'linux' }).reason).toMatch(/не поддерживается/);
  });
  it('заглушка запускается как Node внутри Electron', () => {
    const r = resolveHelper({ ...base, fake: true });
    expect(r.spec).toMatchObject({ command: '/electron', env: { ELECTRON_RUN_AS_NODE: '1' } });
  });
});
