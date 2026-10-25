/**
 * Отладочная панель этапа 0: FPS, звук, трек, мониторы, итоги самопроверки.
 * Сделана без фреймворка — это инструмент, а не продукт.
 */

import type { AppInfo, DisplayInfo } from '@shared/ipc';
import type { HelperStatus, NowPlayingState } from '@shared/now-playing';
import type { CheckResult, CheckStatus } from '@shared/report';
import type { AudioStats } from '../audio/pipeline';

export interface PanelData {
  fps: { fps: number; avgMs: number; worstMs: number };
  audio: { label: string; synthetic: boolean; error: string | null; stats: AudioStats | null };
  track: { state: NowPlayingState; positionMs: number; status: HelperStatus };
  displays: DisplayInfo[];
  check: { running: boolean; progress: string; results: CheckResult[]; reportPath: string | null };
}

export interface PanelHandlers {
  onRunCheck(): void;
  onNextDisplay(): void;
  onRevealReport(path: string): void;
}

const MARK: Record<CheckStatus, string> = { pass: '●', warn: '▲', fail: '✕', info: '○' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(label: string): { root: HTMLElement; value: HTMLElement } {
  const root = el('div', 'row');
  root.append(el('span', 'label', label));
  const value = el('span', 'value');
  root.append(value);
  return { root, value };
}

function meter(): { root: HTMLElement; fill: HTMLElement } {
  const root = el('span', 'meter');
  const fill = el('i');
  root.append(fill);
  return { root, fill };
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export class DebugPanel {
  readonly root = el('aside', 'panel');
  private visible = true;

  private readonly fps = row('Кадры');
  private readonly audioSource = row('Источник');
  private readonly audioLevel = row('Уровень');
  private readonly audioLatency = row('Задержки');
  private readonly rmsMeter = meter();
  private readonly bandMeters = [meter(), meter(), meter()];
  private readonly silence = el('span', 'flag');

  private readonly trackHead = row('Трек');
  private readonly trackApp = row('Плеер');
  private readonly trackTime = row('Время');
  private readonly trackHelper = row('Помощник');
  private readonly cover = el('img', 'cover');
  private readonly coverInfo = el('div', 'cover-info');
  private readonly progressBar = meter();

  private readonly displaysBox = el('div', 'displays');
  private readonly checkBox = el('div', 'checks');
  private readonly checkStatus = el('div', 'check-status');
  private coverUrl = '';

  constructor(info: AppInfo, private readonly handlers: PanelHandlers) {
    this.root.append(el('h1', undefined, `SoundVision ${info.version} · этап 0`));
    this.root.append(el('p', 'hint', 'D — панель · K — самопроверка · F2 — другой монитор · F11 — полный экран · F12 — инструменты'));

    this.root.append(el('h2', undefined, 'Звук'));
    this.root.append(this.audioSource.root, this.audioLevel.root);
    const meters = el('div', 'meters');
    meters.append(this.rmsMeter.root);
    for (const m of this.bandMeters) meters.append(m.root);
    meters.append(this.silence);
    this.root.append(meters, el('p', 'hint', 'уровень · низ 20–150 Гц · середина · верх 2–12 кГц'), this.audioLatency.root);

    this.root.append(el('h2', undefined, 'Что играет'));
    const trackBox = el('div', 'track');
    const text = el('div', 'track-text');
    text.append(this.trackHead.root, this.trackApp.root, this.trackTime.root, this.progressBar.root);
    trackBox.append(this.cover, text);
    this.root.append(trackBox, this.coverInfo, this.trackHelper.root);

    this.root.append(el('h2', undefined, 'Кадры и мониторы'));
    this.root.append(this.fps.root, this.displaysBox);
    const next = el('button', undefined, 'Перенести на следующий монитор (F2)');
    next.addEventListener('click', () => handlers.onNextDisplay());
    this.root.append(next);

    this.root.append(el('h2', undefined, 'Самопроверка'));
    const run = el('button', undefined, 'Запустить проверку (K)');
    run.addEventListener('click', () => handlers.onRunCheck());
    this.root.append(run, this.checkStatus, this.checkBox);

    this.cover.addEventListener('load', () => {
      this.coverInfo.textContent = `Обложка: ${this.cover.naturalWidth}×${this.cover.naturalHeight} px`;
    });
    this.cover.addEventListener('error', () => { this.coverInfo.textContent = 'Обложка не загрузилась'; });
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.root.classList.toggle('hidden', !this.visible);
    return this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.classList.toggle('hidden', !visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(data: PanelData): void {
    if (!this.visible) return;
    const { fps } = data;
    this.fps.value.textContent = `${fps.fps.toFixed(0)} к/с · кадр ${fps.avgMs.toFixed(1)} мс · худший ${fps.worstMs.toFixed(1)} мс`;

    const a = data.audio;
    this.audioSource.value.textContent = a.error ?? a.label;
    this.audioSource.value.classList.toggle('warn', a.synthetic || a.error !== null);
    const s = a.stats;
    if (s) {
      this.audioLevel.value.textContent = `RMS ${s.rmsDb.toFixed(0)} дБ · пик ${s.peakDb.toFixed(0)} дБ · ${s.sampleRate} Гц, ${s.channels} кан.`;
      this.rmsMeter.fill.style.width = `${Math.max(0, Math.min(1, (s.rmsDb + 70) / 70)) * 100}%`;
      this.bandMeters.forEach((m, i) => { m.fill.style.width = `${s.bands[i] * 100}%`; });
      this.silence.textContent = s.silentMs > 500 ? `тишина ${(s.silentMs / 1000).toFixed(0)} с` : '';
      this.audioLatency.value.textContent =
        `контекст ${s.baseLatencyMs.toFixed(0)} + вывод ${s.outputLatencyMs.toFixed(0)} мс · воркер→страница ${s.workletLagMs.toFixed(1)} мс, ` +
        `${s.workletRateHz.toFixed(0)}/с, макс. пауза ${s.workletMaxGapMs.toFixed(0)} мс`;
    } else {
      this.audioLevel.value.textContent = '—';
      this.audioLatency.value.textContent = 'Задержку захвата (удар → экран) этим не измерить: нужен щелчок и камера, этап 1.';
    }

    const { state, positionMs, status } = data.track;
    if (state.status === 'stopped') {
      this.trackHead.value.textContent = 'ничего не играет';
      this.trackApp.value.textContent = '—';
      this.trackTime.value.textContent = '—';
      this.progressBar.fill.style.width = '0%';
    } else {
      this.trackHead.value.textContent = `${state.artist || '(артист неизвестен)'} — ${state.title}`;
      this.trackApp.value.textContent = `${state.app || '?'} · ${state.status === 'playing' ? 'играет' : 'пауза'}${state.album ? ` · ${state.album}` : ''}`;
      this.trackTime.value.textContent = state.durationMs > 0
        ? `${clock(positionMs)} / ${clock(state.durationMs)}` : `${clock(positionMs)} (длительность неизвестна)`;
      this.progressBar.fill.style.width = state.durationMs > 0 ? `${Math.min(1, positionMs / state.durationMs) * 100}%` : '0%';
    }
    const url = state.coverUrl ?? '';
    if (url !== this.coverUrl) {
      this.coverUrl = url;
      if (url) this.cover.src = url; else this.cover.removeAttribute('src');
      this.cover.classList.toggle('empty', !url);
      this.coverInfo.textContent = url ? 'Обложка…' : 'Обложки нет';
    }
    this.trackHelper.value.textContent = status.running
      ? `${status.helper ?? 'запущен, молчит'}${status.restarts ? ` · перезапусков ${status.restarts}` : ''}${status.lastError ? ` · ${status.lastError}` : ''}`
      : (status.lastError ?? 'не запущен');
    this.trackHelper.value.classList.toggle('warn', !status.running || status.helper === null);

    this.renderDisplays(data.displays);
    this.renderChecks(data.check);
  }

  private displaysKey = '';

  private renderDisplays(displays: DisplayInfo[]): void {
    const key = JSON.stringify(displays);
    if (key === this.displaysKey) return;
    this.displaysKey = key;
    this.displaysBox.replaceChildren(...displays.map((d) =>
      el('div', d.current ? 'display current' : 'display',
        `${d.current ? '▶ ' : ''}${d.label}: ${d.width}×${d.height} @${d.refreshRate || '?'} Гц ×${d.scaleFactor}${d.primary ? ' · основной' : ''}`)));
  }

  private checksKey = '';

  private renderChecks(check: PanelData['check']): void {
    this.checkStatus.textContent = check.running ? check.progress : (check.reportPath ? `Отчёт: ${check.reportPath}` : '');
    const key = JSON.stringify([check.results, check.running, check.reportPath]);
    if (key === this.checksKey) return;
    this.checksKey = key;
    this.checkBox.replaceChildren(...check.results.map((r) => {
      const item = el('div', `check ${r.status}`);
      item.append(el('b', undefined, `${MARK[r.status]} ${r.title}`), el('span', undefined, r.summary));
      return item;
    }));
    if (check.reportPath) {
      const reveal = el('button', undefined, 'Показать файл отчёта');
      const path = check.reportPath;
      reveal.addEventListener('click', () => this.handlers.onRevealReport(path));
      this.checkBox.append(reveal);
    }
  }
}
