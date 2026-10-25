/**
 * Точка входа интерфейса (этап 0): собирает панель, звук и «Сейчас играет»
 * и умеет проверить себя. Картинки шоу здесь ещё нет — она начинается с
 * этапа 2, когда будет на чём её проверять.
 */

import './style.css';
import { currentPosition, emptyState } from '@shared/now-playing-parse';
import type { HelperStatus, NowPlayingState } from '@shared/now-playing';
import { PlayerObserver } from '@shared/observer';
import type { AppInfo, DisplayInfo } from '@shared/ipc';
import type { CheckResult } from '@shared/report';
import { AudioPipeline } from './audio/pipeline';
import { openAudio, strategyOrder, type Attempt, type OpenedAudio } from './audio/sources';
import { runSelfCheck } from './selfcheck';
import { DebugPanel } from './ui/panel';

const sv = window.sv;

let info: AppInfo;
let panel: DebugPanel;
let nowPlaying: NowPlayingState = emptyState(Date.now());
let helperStatus: HelperStatus = { helper: null, running: false, restarts: 0, lastError: null, lastMessageAt: 0, path: null };
let displays: DisplayInfo[] = [];

const observer = new PlayerObserver();

// ─── Звук ───────────────────────────────────────────────────────────────

let opened: OpenedAudio | null = null;
let pipeline: AudioPipeline | null = null;
let attempts: Attempt[] = [];
let audioError: string | null = 'Звук ещё не запрашивался';
let opening: Promise<void> | null = null;
let ready: Promise<void>;
let resolveReady: () => void;
ready = new Promise((resolve) => { resolveReady = resolve; });

/**
 * Открыть звук, если он ещё не открыт. Идемпотентно: главный процесс дёргает
 * это с жестом пользователя сразу после загрузки и потом раз в несколько
 * секунд, пока звук не заработает, — getDisplayMedia без жеста может отказать.
 */
async function ensureAudio(): Promise<void> {
  await ready;
  if (pipeline || opening) {
    await opening;
    return;
  }
  opening = (async () => {
    const outcome = await openAudio(strategyOrder(info.cli.audio === 'test'));
    attempts = outcome.attempts;
    if (!outcome.opened) {
      audioError = `Звук не получен: ${attempts.map((a) => `${a.strategy} — ${a.detail}`).join('; ')}`;
      return;
    }
    try {
      pipeline = await AudioPipeline.create(outcome.opened.stream);
      opened = outcome.opened;
      audioError = null;
    } catch (error) {
      outcome.opened.release();
      audioError = `Конвейер не поднялся: ${(error as Error).message}`;
      return;
    }
    // Источник кончился (отключили устройство, остановили шеринг) — начнём заново.
    outcome.opened.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      pipeline?.close();
      opened?.release();
      pipeline = null;
      opened = null;
      audioError = 'Источник звука пропал, пробуем снова…';
    });
  })().finally(() => { opening = null; });
  await opening;
}

(window as unknown as { __svEnsureAudio: () => Promise<void> }).__svEnsureAudio = ensureAudio;

// ─── Самопроверка ───────────────────────────────────────────────────────

const check = { running: false, progress: '', results: [] as CheckResult[], reportPath: null as string | null };

async function runCheck(exitAfter: boolean): Promise<void> {
  if (check.running) return;
  check.running = true;
  check.results = [];
  check.reportPath = null;
  try {
    const report = await runSelfCheck({
      info, getGpu: () => sv.getGpu(), ensureAudio,
      audioAttempts: () => attempts,
      audioOpened: () => (opened ? { strategy: opened.strategy, label: opened.label, synthetic: opened.synthetic } : null),
      audioStats: () => pipeline?.stats() ?? null,
      helperStatus: () => helperStatus, observer,
      onProgress: (text) => { check.progress = text; },
    });
    check.results = report.checks;
    check.reportPath = await sv.saveReport(JSON.stringify(report, null, 2), exitAfter);
  } catch (error) {
    check.results = [{ id: 'selfcheck', title: 'Самопроверка', status: 'fail', summary: `Проверка упала: ${(error as Error).message}` }];
    if (exitAfter) await sv.saveReport(JSON.stringify({ schema: 1, error: String(error) }), true);
  } finally {
    check.running = false;
  }
}

// ─── Кадры ──────────────────────────────────────────────────────────────

const frameTimes: number[] = [];
let lastFrame = performance.now();

function loop(now: number): void {
  requestAnimationFrame(loop);
  frameTimes.push(now - lastFrame);
  lastFrame = now;
  if (frameTimes.length > 120) frameTimes.shift();

  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  panel.update({
    fps: { fps: avg > 0 ? 1000 / avg : 0, avgMs: avg, worstMs: Math.max(...frameTimes) },
    audio: { label: opened?.label ?? '—', synthetic: opened?.synthetic ?? false, error: audioError, stats: pipeline?.stats() ?? null },
    track: { state: nowPlaying, positionMs: currentPosition(nowPlaying, Date.now()), status: helperStatus },
    displays,
    check,
  });
}

// ─── Запуск ─────────────────────────────────────────────────────────────

/** Размер обложки нужен отчёту: мелкая обложка для шоу бесполезна. */
function measureCover(state: NowPlayingState, app: string): void {
  if (!state.coverUrl) return;
  const image = new Image();
  image.onload = () => observer.noteCoverSize(app, image.naturalWidth, image.naturalHeight);
  image.src = state.coverUrl;
}

let lastCoverUrl = '';
function onNowPlaying(state: NowPlayingState): void {
  nowPlaying = state;
  const seen = observer.observe(state);
  if (seen && state.coverUrl && state.coverUrl !== lastCoverUrl) {
    lastCoverUrl = state.coverUrl;
    measureCover(state, seen.app);
  }
}

async function boot(): Promise<void> {
  info = await sv.getInfo();
  displays = info.displays;
  panel = new DebugPanel(info, {
    onRunCheck: () => void runCheck(false),
    onNextDisplay: () => void sv.nextDisplay().then((list) => { displays = list; }),
    onRevealReport: (path) => void sv.revealReport(path),
  });
  panel.setVisible(info.showPanel);
  document.body.append(panel.root);

  const snapshot = await sv.getSnapshot();
  helperStatus = snapshot.status;
  onNowPlaying(snapshot.state);
  sv.onNowPlaying(onNowPlaying);
  sv.onHelperStatus((status) => { helperStatus = status; });
  resolveReady();

  window.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.key === 'd' || event.key === 'D' || event.key === 'в' || event.key === 'В') {
      void sv.setPanelVisible(panel.toggle());
    } else if (event.key === 'k' || event.key === 'K' || event.key === 'л' || event.key === 'Л') {
      void runCheck(false);
    }
  });

  // Курсор прячется сам: на телевизоре он только мешает.
  let hideTimer = 0;
  window.addEventListener('mousemove', () => {
    document.body.classList.add('cursor');
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => document.body.classList.remove('cursor'), 2500);
  });

  requestAnimationFrame(loop);

  if (info.cli.selfcheckExit) {
    // Даём звуку и помощнику время представиться и сыграть хоть что-то.
    await new Promise((r) => setTimeout(r, 6000));
    await runCheck(true);
  }
}

void boot();
