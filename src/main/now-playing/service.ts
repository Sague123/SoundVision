/**
 * Служба «Сейчас играет»: запускает помощника, читает его строки, держит
 * актуальное состояние трека и перезапускает помощника, если тот упал.
 */

import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { NowPlayingTracker, emptyState, parseHelperLine } from '../../shared/now-playing-parse';
import type { HelperStatus, NowPlayingState } from '../../shared/now-playing';
import type { HelperSpec } from './helper-path';

export type SpawnFn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsHide: boolean }) => ChildProcessWithoutNullStreams;

export interface ServiceOptions {
  spawn?: SpawnFn;
  now?: () => number;
  /** Первая пауза перед перезапуском; удваивается до потолка. */
  restartBaseMs?: number;
  restartMaxMs?: number;
}

export interface ServiceEvents {
  state: [NowPlayingState];
  status: [HelperStatus];
}

/** Склейка кусков stdout в строки: сообщение может прийти разорванным. */
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    this.rest += chunk;
    const lines = this.rest.split(/\r?\n/);
    this.rest = lines.pop() ?? '';
    // Строка без перевода в конце, но длиннее разумного — мусор, не копим.
    if (this.rest.length > 8 * 1024 * 1024) this.rest = '';
    return lines;
  }
}

export class NowPlayingService extends EventEmitter<ServiceEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly tracker = new NowPlayingTracker();
  private current: NowPlayingState;
  private stopped = true;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly status: HelperStatus = {
    helper: null, running: false, restarts: 0, lastError: null, lastMessageAt: 0, path: null,
  };

  constructor(private readonly spec: HelperSpec | null, unavailableReason: string | null,
    private readonly options: ServiceOptions = {}) {
    super();
    this.spawnFn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.now = options.now ?? Date.now;
    this.current = emptyState(this.now());
    this.status.path = spec ? spec.command : unavailableReason;
    if (!spec) this.status.lastError = unavailableReason;
  }

  getState(): NowPlayingState {
    return this.current;
  }

  getStatus(): HelperStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.spec) {
      this.emit('status', this.getStatus());
      return;
    }
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
    this.status.running = false;
  }

  private launch(): void {
    const spec = this.spec;
    if (!spec || this.stopped) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(spec.command, spec.args, {
        env: { ...process.env, ...spec.env }, windowsHide: true,
      });
    } catch (error) {
      this.fail(`не удалось запустить помощника: ${(error as Error).message}`);
      return;
    }
    this.child = child;
    this.status.running = true;
    this.emit('status', this.getStatus());

    const splitter = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) this.handleLine(line);
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });

    child.on('error', (error) => this.fail(`ошибка запуска: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.status.running = false;
      // Помощник упал или закрылся сам: трек больше неизвестен.
      this.apply({ type: 'stopped' });
      if (this.stopped) return;
      const reason = `помощник завершился (код ${code ?? '—'}${signal ? `, сигнал ${signal}` : ''})`;
      this.fail(stderr.trim() ? `${reason}: ${stderr.trim().split('\n').slice(-2).join(' | ')}` : reason);
    });
  }

  private handleLine(line: string): void {
    const message = parseHelperLine(line);
    if (!message) return;
    this.status.lastMessageAt = this.now();
    if (message.type === 'hello') {
      this.status.helper = message.helper;
      this.attempt = 0; // представился — значит запустился нормально
      this.emit('status', this.getStatus());
      return;
    }
    if (message.type === 'error') {
      this.status.lastError = message.message;
      this.emit('status', this.getStatus());
      return;
    }
    this.apply(message);
  }

  private apply(message: Parameters<NowPlayingTracker['apply']>[0]): void {
    const next = this.tracker.apply(message, this.now());
    if (next === this.current) return;
    this.current = next;
    this.emit('state', next);
  }

  private fail(reason: string): void {
    this.status.lastError = reason;
    this.status.running = false;
    this.emit('status', this.getStatus());
    if (this.stopped) return;
    const base = this.options.restartBaseMs ?? 1000;
    const max = this.options.restartMaxMs ?? 15_000;
    const delay = Math.min(max, base * 2 ** this.attempt);
    this.attempt++;
    this.status.restarts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, delay);
  }
}
