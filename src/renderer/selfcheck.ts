/**
 * Самопроверка этапа 0: собирает факты о машине и складывает в отчёт.
 *
 * Здесь только сбор — оценка (что считать нормой) в `shared/checks.ts`.
 * Проверка ничего не ломает и не меняет: её можно запускать посреди шоу.
 */

import {
  evaluateAudio, evaluateFps, evaluateGpu, evaluateHelper, evaluateTrackData, type GpuProbe,
} from '@shared/checks';
import type { AppInfo, GpuInfo } from '@shared/ipc';
import type { HelperStatus } from '@shared/now-playing';
import type { PlayerObserver } from '@shared/observer';
import type { CheckResult, CheckStatus, Stage0Report } from '@shared/report';
import type { AudioStats } from './audio/pipeline';
import type { Attempt } from './audio/sources';

export interface SelfCheckContext {
  info: AppInfo;
  getGpu(): Promise<GpuInfo>;
  /** Открыть звук, если ещё не открыт; без исключений. */
  ensureAudio(): Promise<void>;
  audioAttempts(): Attempt[];
  audioOpened(): { strategy: string; label: string; synthetic: boolean } | null;
  audioStats(): AudioStats | null;
  helperStatus(): HelperStatus;
  observer: PlayerObserver;
  onProgress(text: string): void;
}

const FPS_WINDOW_MS = 3000;
const AUDIO_WINDOW_MS = 4000;

export async function runSelfCheck(ctx: SelfCheckContext): Promise<Stage0Report> {
  const started = performance.now();
  const checks: CheckResult[] = [];
  const add = (result: CheckResult): void => { checks.push(result); };

  ctx.onProgress('Окружение…');
  add(environmentCheck(ctx.info));
  add(displaysCheck(ctx.info));

  ctx.onProgress('Видеокарта…');
  add(evaluateGpu(await probeGpu(ctx)));

  ctx.onProgress('Частота кадров (3 с)…');
  add(evaluateFps(await probeFps()));

  ctx.onProgress('Захват звука (4 с)…');
  await ctx.ensureAudio();
  add(await probeAudio(ctx));

  ctx.onProgress('Помощник «Сейчас играет»…');
  add(evaluateHelper(ctx.helperStatus()));
  add(evaluateTrackData(ctx.observer.summary()));

  const verdict: Record<string, CheckStatus> = {};
  for (const check of checks) verdict[check.id] = check.status;

  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    app: ctx.info,
    checks,
    verdict,
  };
}

function environmentCheck(info: AppInfo): CheckResult {
  const base = `${info.platform} ${info.arch}, ОС ${info.osRelease}, Electron ${info.electron}, Chromium ${info.chrome}`;
  const perms = info.macPermissions;
  if (perms && (perms.screen !== 'granted' || perms.microphone !== 'granted')) {
    return {
      id: 'environment', title: 'Окружение', status: 'warn',
      summary: `${base}. Права macOS: запись экрана — ${perms.screen}, микрофон — ${perms.microphone}. Без них звук не откроется.`,
      data: { ...info },
    };
  }
  return { id: 'environment', title: 'Окружение', status: 'info', summary: base, data: { ...info } };
}

function displaysCheck(info: AppInfo): CheckResult {
  const lines = info.displays.map((d) =>
    `${d.current ? '▶ ' : ''}${d.label}: ${d.width}×${d.height} @${d.refreshRate || '?'} Гц, масштаб ${d.scaleFactor}${d.primary ? ' (основной)' : ''}`);
  return {
    id: 'displays', title: 'Мониторы', status: 'info',
    summary: `${info.displays.length} шт.: ${lines.join('; ')}`, data: { displays: info.displays },
  };
}

interface GpuAdapter {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  isFallbackAdapter?: boolean;
}

async function probeGpu(ctx: SelfCheckContext): Promise<GpuProbe> {
  let webgpu: GpuProbe['webgpu'] = null;
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        webgpu = {
          vendor: adapter.info?.vendor ?? '', architecture: adapter.info?.architecture ?? '',
          device: adapter.info?.device ?? '', description: adapter.info?.description ?? '',
          fallback: adapter.isFallbackAdapter === true,
        };
      }
    } catch { /* адаптера нет — webgpu остаётся null */ }
  }

  let webgl: GpuProbe['webgl'] = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      webgl = {
        renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
        vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
      };
    }
  } catch { /* WebGL2 недоступен */ }

  let info: GpuInfo | null = null;
  try { info = await ctx.getGpu(); } catch { /* сведений от главного процесса нет */ }
  return { webgpu, webgl, gpu: info };
}

function probeFps(): Promise<{ frames: number; seconds: number; p99Ms: number; hidden: boolean }> {
  return new Promise((resolve) => {
    const times: number[] = [];
    let last = performance.now();
    const begin = last;
    const tick = (now: number): void => {
      times.push(now - last);
      last = now;
      if (now - begin < FPS_WINDOW_MS) {
        requestAnimationFrame(tick);
        return;
      }
      const sorted = [...times].sort((a, b) => a - b);
      const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
      resolve({ frames: times.length, seconds: (now - begin) / 1000, p99Ms: p99, hidden: document.hidden });
    };
    requestAnimationFrame(tick);
  });
}

async function probeAudio(ctx: SelfCheckContext): Promise<CheckResult> {
  let peakMax = 0;
  let last: AudioStats | null = null;
  const end = performance.now() + AUDIO_WINDOW_MS;
  while (performance.now() < end) {
    const stats = ctx.audioStats();
    if (stats) {
      last = stats;
      peakMax = Math.max(peakMax, 10 ** (stats.peakDb / 20));
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return evaluateAudio({
    attempts: ctx.audioAttempts(), opened: ctx.audioOpened(), peakMax, windowMs: AUDIO_WINDOW_MS,
    sampleRate: last?.sampleRate ?? 0, baseLatencyMs: last?.baseLatencyMs ?? 0,
    workletLagMs: last?.workletLagMs ?? 0, workletRateHz: last?.workletRateHz ?? 0,
  });
}
