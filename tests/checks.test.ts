import { describe, expect, it } from 'vitest';
import {
  evaluateAudio, evaluateFps, evaluateGpu, evaluateHelper, evaluateTrackData, type AudioProbe,
} from '../src/shared/checks';
import type { AppObservation } from '../src/shared/observer';
import type { HelperStatus } from '../src/shared/now-playing';

const webgpu = { vendor: 'nvidia', architecture: 'ampere', device: '', description: '', fallback: false };
const webgl = { renderer: 'ANGLE (NVIDIA GeForce RTX 3060 Laptop GPU)', vendor: 'Google' };

describe('evaluateGpu', () => {
  it('WebGPU на железе — pass', () => {
    expect(evaluateGpu({ webgpu, webgl, gpu: null }).status).toBe('pass');
  });
  it('только WebGL2 — warn', () => {
    expect(evaluateGpu({ webgpu: null, webgl, gpu: null }).status).toBe('warn');
  });
  it('программный рендер — warn с пометкой', () => {
    const r = evaluateGpu({ webgpu: null, webgl: { renderer: 'ANGLE (Google, Vulkan, SwiftShader)', vendor: '' }, gpu: null });
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/Программный/);
    expect(evaluateGpu({ webgpu: { ...webgpu, fallback: true }, webgl, gpu: null }).status).toBe('warn');
  });
  it('ничего нет — fail', () => {
    expect(evaluateGpu({ webgpu: null, webgl: null, gpu: null }).status).toBe('fail');
  });
});

describe('evaluateFps', () => {
  it('пороги 55 и 30', () => {
    expect(evaluateFps({ frames: 180, seconds: 3, p99Ms: 17, hidden: false }).status).toBe('pass');
    expect(evaluateFps({ frames: 120, seconds: 3, p99Ms: 25, hidden: false }).status).toBe('warn');
    expect(evaluateFps({ frames: 30, seconds: 3, p99Ms: 90, hidden: false }).status).toBe('fail');
  });
  it('скрытое окно — не оценивает', () => {
    expect(evaluateFps({ frames: 3, seconds: 3, p99Ms: 900, hidden: true }).status).toBe('info');
  });
});

const audio = (patch: Partial<AudioProbe> = {}): AudioProbe => ({
  attempts: [{ strategy: 'loopback', ok: true, detail: '', ms: 5 }],
  opened: { strategy: 'loopback', label: 'Системный звук (loopback)', synthetic: false },
  peakMax: 0.4, windowMs: 4000, sampleRate: 48000, baseLatencyMs: 10, workletLagMs: 3, workletRateHz: 100, ...patch,
});

describe('evaluateAudio', () => {
  it('звук идёт — pass', () => expect(evaluateAudio(audio()).status).toBe('pass'));
  it('поток есть, но тишина — warn, не fail', () => {
    expect(evaluateAudio(audio({ peakMax: 0 })).status).toBe('warn');
  });
  it('тестовый сигнал никогда не выдаётся за проверку захвата', () => {
    const r = evaluateAudio(audio({ opened: { strategy: 'test-tone', label: 'x', synthetic: true } }));
    expect(r.status).toBe('info');
    expect(r.summary).toMatch(/НЕ проверен/);
  });
  it('нет потока — fail и перечень попыток', () => {
    const r = evaluateAudio(audio({
      opened: null,
      attempts: [{ strategy: 'loopback', ok: false, detail: 'нет дорожки', ms: 1 }, { strategy: 'virtual-device', ok: false, detail: 'нет BlackHole', ms: 1 }],
    }));
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/нет дорожки.*нет BlackHole/);
  });
});

const helper = (patch: Partial<HelperStatus> = {}): HelperStatus => ({
  helper: 'windows-smtc', running: true, restarts: 0, lastError: null, lastMessageAt: 1, path: 'x', ...patch,
});

describe('evaluateHelper', () => {
  it('работает — pass', () => expect(evaluateHelper(helper()).status).toBe('pass'));
  it('не собран — fail с причиной', () => {
    const r = evaluateHelper(helper({ helper: null, running: false, lastError: 'помощник не собран: x' }));
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/не собран/);
  });
  it('запущен, но молчит — warn; частые перезапуски — warn', () => {
    expect(evaluateHelper(helper({ helper: null })).status).toBe('warn');
    expect(evaluateHelper(helper({ restarts: 5 })).status).toBe('warn');
  });
});

const obs = (patch: Partial<AppObservation>): AppObservation => ({
  app: 'Spotify', kind: 'spotify', tracks: 1, withCover: 1, maxCoverSide: 640, withDuration: 1,
  position: 'advances', positionStaleMs: 0, example: 'A — T', ...patch,
});

describe('evaluateTrackData', () => {
  it('ничего не играло — fail с подсказкой', () => {
    const r = evaluateTrackData([]);
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/Spotify/);
  });
  it('оба плеера полные — pass', () => {
    expect(evaluateTrackData([obs({}), obs({ app: 'Chrome', kind: 'browser' })]).status).toBe('pass');
  });
  it('нет одного из плееров — warn и называет какого', () => {
    const r = evaluateTrackData([obs({})]);
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/YouTube Music в Chrome/);
  });
  it('мелкая обложка или стоящая позиция — неполные данные', () => {
    const r = evaluateTrackData([obs({ maxCoverSide: 64 }), obs({ app: 'Chrome', kind: 'browser', position: 'frozen' })]);
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/неполные данные: Spotify, Chrome/);
  });
});
