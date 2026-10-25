/**
 * Правила оценки самопроверки этапа 0. Чистые функции: на вход — то, что
 * собрал интерфейс, на выход — вердикт со словами для человека. Вынесены,
 * чтобы пороги проверялись тестами, а не только глазами на живой машине.
 */

import type { GpuInfo } from './ipc';
import type { AppObservation } from './observer';
import type { HelperStatus } from './now-playing';
import type { CheckResult } from './report';

// ─── Видеокарта ─────────────────────────────────────────────────────────

export interface GpuProbe {
  webgpu: { vendor: string; architecture: string; device: string; description: string; fallback: boolean } | null;
  webgl: { renderer: string; vendor: string } | null;
  gpu: GpuInfo | null;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;

export function evaluateGpu(probe: GpuProbe): CheckResult {
  const names = [
    probe.webgpu ? `WebGPU: ${probe.webgpu.vendor} ${probe.webgpu.architecture || probe.webgpu.device}`.trim() : null,
    probe.webgl ? `WebGL2: ${probe.webgl.renderer}` : null,
    ...(probe.gpu?.devices.filter((d) => d.active).map((d) => `драйвер: ${d.deviceString} ${d.driverVersion}`.trim()) ?? []),
  ].filter(Boolean).join(' · ');
  const data = { ...probe };

  if (!probe.webgpu && !probe.webgl) {
    return { id: 'gpu', title: 'Видеокарта', status: 'fail', summary: 'Нет ни WebGPU, ни WebGL2: рисовать нечем.', data };
  }
  const software = (probe.webgl && SOFTWARE.test(probe.webgl.renderer)) || probe.webgpu?.fallback === true;
  if (software) {
    return { id: 'gpu', title: 'Видеокарта', status: 'warn',
      summary: `Программный рендер, не видеокарта (${names}). 60 кадров в 1080p на нём не получить.`, data };
  }
  if (!probe.webgpu) {
    return { id: 'gpu', title: 'Видеокарта', status: 'warn',
      summary: `WebGPU недоступен, остаётся WebGL2 (${names}). План предусматривает откат, но хуже.`, data };
  }
  return { id: 'gpu', title: 'Видеокарта', status: 'pass', summary: names, data };
}

// ─── Частота кадров ─────────────────────────────────────────────────────

export interface FpsProbe {
  frames: number;
  seconds: number;
  /** 99-й процентиль времени кадра, мс. */
  p99Ms: number;
  hidden: boolean;
}

export function evaluateFps(probe: FpsProbe): CheckResult {
  const fps = probe.seconds > 0 ? probe.frames / probe.seconds : 0;
  const data = { ...probe, fps };
  const line = `${fps.toFixed(0)} к/с, худший процентиль кадра ${probe.p99Ms.toFixed(1)} мс`;
  if (probe.hidden) {
    return { id: 'fps', title: 'Частота кадров', status: 'info', summary: `Окно скрыто, замер не показателен (${line}).`, data };
  }
  // Пустая страница — это потолок: если она не держит 60, то шоу не удержит тем более.
  if (fps >= 55) return { id: 'fps', title: 'Частота кадров', status: 'pass', summary: `${line} (пустая страница; шоу будет тяжелее).`, data };
  if (fps >= 30) return { id: 'fps', title: 'Частота кадров', status: 'warn', summary: `${line}. Даже пустая страница не держит 60.`, data };
  return { id: 'fps', title: 'Частота кадров', status: 'fail', summary: `${line}. Слишком медленно.`, data };
}

// ─── Захват звука ───────────────────────────────────────────────────────

export interface AudioProbe {
  attempts: Array<{ strategy: string; ok: boolean; detail: string; ms: number }>;
  opened: { strategy: string; label: string; synthetic: boolean } | null;
  /** Самый громкий пик за окно наблюдения, 0..1. */
  peakMax: number;
  windowMs: number;
  sampleRate: number;
  baseLatencyMs: number;
  workletLagMs: number;
  workletRateHz: number;
}

export const SILENCE_THRESHOLD = 1e-3;

export function evaluateAudio(probe: AudioProbe): CheckResult {
  const data = { ...probe };
  const tried = probe.attempts.map((a) => `${a.strategy}: ${a.ok ? 'да' : a.detail}`).join('; ');
  if (!probe.opened) {
    return { id: 'audio', title: 'Захват системного звука', status: 'fail',
      summary: `Звук не получен. Попытки — ${tried || 'не было'}`, data };
  }
  if (probe.opened.synthetic) {
    return { id: 'audio', title: 'Захват системного звука', status: 'info',
      summary: 'Работает тестовый сигнал: цепочка «поток → воркер → панель» цела, а захват системного звука НЕ проверен.', data };
  }
  if (probe.peakMax < SILENCE_THRESHOLD) {
    return { id: 'audio', title: 'Захват системного звука', status: 'warn',
      summary: `Поток открыт (${probe.opened.label}), но за ${(probe.windowMs / 1000).toFixed(0)} с тишина. Включите музыку и повторите проверку (K).`, data };
  }
  return { id: 'audio', title: 'Захват системного звука', status: 'pass',
    summary: `${probe.opened.label}: звук идёт, ${probe.sampleRate} Гц, воркер ${probe.workletRateHz.toFixed(0)} сообщений/с.`, data };
}

// ─── Помощник «Сейчас играет» ───────────────────────────────────────────

export function evaluateHelper(status: HelperStatus): CheckResult {
  const data = { ...status };
  if (!status.running && status.helper === null) {
    return { id: 'helper', title: 'Помощник «Сейчас играет»', status: 'fail',
      summary: status.lastError ?? 'Помощник не запущен.', data };
  }
  if (status.helper === null) {
    return { id: 'helper', title: 'Помощник «Сейчас играет»', status: 'warn',
      summary: 'Процесс запущен, но не представился (нет сообщения hello).', data };
  }
  const restarts = status.restarts > 0 ? `, перезапусков: ${status.restarts}` : '';
  const problem = status.lastError ? ` Последнее сообщение об ошибке: ${status.lastError}` : '';
  return { id: 'helper', title: 'Помощник «Сейчас играет»', status: status.restarts > 2 ? 'warn' : 'pass',
    summary: `Работает: ${status.helper}${restarts}.${problem}`, data };
}

// ─── Что отдают плееры ──────────────────────────────────────────────────

export function isComplete(o: AppObservation): boolean {
  return o.withCover > 0 && o.withDuration > 0 && o.position === 'advances' && o.maxCoverSide >= 300;
}

function describeObservation(o: AppObservation): string {
  const bits = [
    `треков ${o.tracks}`,
    o.withCover > 0 ? `обложка ${o.maxCoverSide ? `${o.maxCoverSide}px` : 'есть'}` : 'обложки нет',
    o.withDuration > 0 ? 'длительность есть' : 'длительности нет',
    o.position === 'advances' ? 'позиция идёт' : o.position === 'frozen' ? 'позиция стоит' : 'позиция не проверена',
    o.positionStaleMs > 0 ? `снимок позиции стареет до ${(o.positionStaleMs / 1000).toFixed(1)} с` : null,
  ].filter(Boolean);
  return `${o.app} [${o.kind}]: ${bits.join(', ')}`;
}

export function evaluateTrackData(observations: readonly AppObservation[]): CheckResult {
  const data = { observations };
  if (observations.length === 0) {
    return { id: 'track-data', title: 'Название, обложка, позиция', status: 'fail',
      summary: 'Пока ничего не играло. Включите музыку в Spotify, затем в YouTube Music (Chrome) и повторите проверку (K).', data };
  }
  const spotify = observations.find((o) => o.kind === 'spotify');
  const browser = observations.find((o) => o.kind === 'browser');
  const lines = observations.map(describeObservation).join(' | ');
  const missing = [!spotify && 'Spotify', !browser && 'YouTube Music в Chrome'].filter(Boolean);
  const weak = observations.filter((o) => !isComplete(o));

  if (missing.length === 0 && weak.length === 0) {
    return { id: 'track-data', title: 'Название, обложка, позиция', status: 'pass', summary: lines, data };
  }
  const notes = [
    missing.length ? `не проверено: ${missing.join(', ')}` : null,
    weak.length ? `неполные данные: ${weak.map((o) => o.app).join(', ')}` : null,
  ].filter(Boolean).join('; ');
  return { id: 'track-data', title: 'Название, обложка, позиция', status: 'warn', summary: `${lines}. ${notes}.`, data };
}
