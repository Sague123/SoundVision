import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRAME_BYTES, FrameAligner, parseAudioLine } from '../src/shared/audio-helper';
import { NativeAudioService } from '../src/main/native-audio';
import { strategyOrder } from '../src/renderer/audio/sources';

const FAKE = resolve('helpers/fake/now-playing.mjs');
const spec = (env: Record<string, string> = {}) => ({ command: process.execPath, args: [FAKE], env, label: 'fake' });

describe('parseAudioLine', () => {
  it('формат, ошибка, hello', () => {
    expect(parseAudioLine('{"type":"audio-format","sampleRate":48000,"channels":2}'))
      .toEqual({ type: 'format', sampleRate: 48000, channels: 2 });
    expect(parseAudioLine('{"type":"error","message":"нет доступа","code":"blocked"}'))
      .toEqual({ type: 'error', message: 'нет доступа', code: 'blocked' });
    expect(parseAudioLine('{"type":"hello","helper":"macos-audio-tap"}')).toEqual({ type: 'hello', helper: 'macos-audio-tap' });
  });
  it('не верит мусору и невозможной частоте', () => {
    for (const line of ['', 'Fatal error', '{oops', '{"type":"audio-format","sampleRate":5}', '{"type":"audio-format","sampleRate":"x"}', '[]']) {
      expect(parseAudioLine(line)).toBeNull();
    }
  });
});

describe('FrameAligner', () => {
  it('отдаёт только целые кадры, остаток ждёт следующего куска', () => {
    const a = new FrameAligner();
    const first = a.push(new Uint8Array(12));
    expect(first?.length).toBe(FRAME_BYTES);
    const second = a.push(new Uint8Array(12));
    expect(second?.length).toBe(16); // 4 остатка + 12 = 16
    expect(a.push(new Uint8Array(3))).toBeNull();
  });
  it('байты не теряются и не меняются местами', () => {
    const a = new FrameAligner();
    const source = Uint8Array.from({ length: 100 }, (_, i) => i);
    const parts: number[] = [];
    for (let i = 0; i < source.length; i += 7) {
      const out = a.push(source.slice(i, i + 7));
      if (out) parts.push(...out);
    }
    expect(parts).toEqual([...source.slice(0, parts.length)]);
    expect(parts.length % FRAME_BYTES).toBe(0);
  });
});

describe('strategyOrder', () => {
  const base = { testTone: false, fakeHelper: false };
  it('на macOS — свой захват, loopback Electron не пробуем', () => {
    expect(strategyOrder({ ...base, platform: 'darwin' })).toEqual(['native-tap', 'virtual-device']);
  });
  it('на Windows — loopback', () => {
    expect(strategyOrder({ ...base, platform: 'win32' })).toEqual(['loopback', 'virtual-device']);
  });
  it('тестовый сигнал заменяет всё', () => {
    expect(strategyOrder({ ...base, testTone: true, platform: 'darwin' })).toEqual(['test-tone']);
  });
});

describe('NativeAudioService с заглушкой', () => {
  it('отдаёт формат и ровные кадры PCM', async () => {
    const service = new NativeAudioService(spec(), null);
    const sizes: number[] = [];
    service.on('pcm', (data) => sizes.push(data.byteLength));
    const result = await service.start();
    expect(result).toEqual({ ok: true, sampleRate: 48000, channels: 2 });
    await new Promise((r) => setTimeout(r, 400));
    service.stop();
    expect(sizes.length).toBeGreaterThan(10);
    expect(sizes.every((s) => s % FRAME_BYTES === 0)).toBe(true);
  });

  it('повторный start не плодит процессов', async () => {
    const service = new NativeAudioService(spec(), null);
    const [a, b] = await Promise.all([service.start(), service.start()]);
    expect(a.ok && b.ok).toBe(true);
    service.stop();
  });

  it('перезапускает помощника, пока звук нужен', async () => {
    const service = new NativeAudioService(spec({ FAKE_EXIT_AFTER_MS: '300' }), null, { restartBaseMs: 30, restartMaxMs: 60 });
    let chunksAfterRestart = 0;
    let exits = 0;
    service.on('pcm', () => { chunksAfterRestart++; });
    await service.start();
    await new Promise((r) => setTimeout(r, 1500));
    exits = chunksAfterRestart;
    service.stop();
    // За 1.5 с при выходе каждые 0.3 с без перезапусков было бы ~30 блоков; с ними — заметно больше.
    expect(exits).toBeGreaterThan(60);
  });

  it('без помощника отвечает причиной', async () => {
    const service = new NativeAudioService(null, 'помощник не собран');
    expect(await service.start()).toEqual({ ok: false, error: 'помощник не собран' });
  });

  it('помощник, который не отвечает, не вешает запуск', async () => {
    const hang = { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], env: {}, label: 'x' };
    const service = new NativeAudioService(hang, null, { startTimeoutMs: 300 });
    const result = await service.start();
    service.stop();
    expect(result.ok).toBe(false);
  });
});
