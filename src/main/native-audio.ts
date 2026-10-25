/**
 * Захват системного звука силами помощника (macOS).
 *
 * Electron умеет системный loopback только на Windows, поэтому на Mac звук
 * снимает сам помощник через Core Audio и отдаёт его сюда потоком PCM.
 * Служба запускает помощника в режиме `--audio-tap`, ждёт от него формат,
 * выравнивает поток по кадрам и отдаёт интерфейсу. Упал или сменилось
 * устройство вывода — перезапускает, пока звук нужен.
 */

import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { FrameAligner, parseAudioLine, type AudioFormatMessage } from '../shared/audio-helper';
import type { NativeAudioResult } from '../shared/ipc';
import type { HelperSpec } from './now-playing/helper-path';

export interface NativeAudioOptions {
  spawn?: typeof nodeSpawn;
  /** Сколько ждать формат от помощника при запуске. */
  startTimeoutMs?: number;
  restartBaseMs?: number;
  restartMaxMs?: number;
}

export interface NativeAudioEvents {
  pcm: [ArrayBuffer];
}

type Waiter = (result: NativeAudioResult) => void;

export class NativeAudioService extends EventEmitter<NativeAudioEvents> {
  private child: ChildProcess | null = null;
  private wanted = false;
  private format: AudioFormatMessage | null = null;
  private lastError: string | null = null;
  private waiters: Waiter[] = [];
  private attempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly aligner = new FrameAligner();
  private readonly spawnFn: typeof nodeSpawn;

  constructor(private readonly spec: HelperSpec | null, private readonly reason: string | null,
    private readonly options: NativeAudioOptions = {}) {
    super();
    this.spawnFn = options.spawn ?? nodeSpawn;
  }

  /** Запустить захват и дождаться формата. Повторный вызов безопасен. */
  start(): Promise<NativeAudioResult> {
    if (!this.spec) return Promise.resolve({ ok: false, error: this.reason ?? 'помощник недоступен' });
    this.wanted = true;
    if (this.format && this.child) {
      return Promise.resolve({ ok: true, sampleRate: this.format.sampleRate, channels: this.format.channels });
    }
    return new Promise((resolve) => {
      let done = false;
      const finish: Waiter = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== finish);
        finish({ ok: false, error: this.lastError ?? 'помощник не прислал формат звука за отведённое время' });
      }, this.options.startTimeoutMs ?? 6000);
      this.waiters.push(finish);
      if (!this.child && !this.restartTimer) this.launch();
    });
  }

  stop(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
    this.format = null;
    this.aligner.reset();
    this.settle({ ok: false, error: 'захват остановлен' });
  }

  private settle(result: NativeAudioResult): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(result);
  }

  private launch(): void {
    const spec = this.spec;
    if (!spec || !this.wanted) return;
    let child: ChildProcess;
    try {
      // stdio[3] — труба для PCM.
      child = this.spawnFn(spec.command, [...spec.args, '--audio-tap'], {
        env: { ...process.env, ...spec.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.fail(`не удалось запустить помощника: ${(error as Error).message}`);
      return;
    }
    this.child = child;
    this.aligner.reset();

    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    });

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-1500); });

    const pcm = child.stdio[3];
    pcm?.on('data', (chunk: Buffer) => {
      const whole = this.aligner.push(chunk);
      if (!whole) return;
      // Отдельная копия: буфер трубы Node переиспользует.
      const copy = new ArrayBuffer(whole.byteLength);
      new Uint8Array(copy).set(whole);
      this.emit('pcm', copy);
    });

    child.on('error', (error) => this.fail(`ошибка запуска: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.format = null;
      if (!this.wanted) return;
      const tail = stderr.trim() ? `: ${stderr.trim().split('\n').slice(-2).join(' | ')}` : '';
      // Своё сообщение помощника об ошибке точнее, чем код выхода.
      this.fail(this.lastError ?? `захват завершился (код ${code ?? '—'}${signal ? `, сигнал ${signal}` : ''})${tail}`);
    });
  }

  private handleLine(line: string): void {
    const message = parseAudioLine(line);
    if (!message) return;
    if (message.type === 'format') {
      this.format = message;
      this.lastError = null;
      this.attempt = 0;
      this.settle({ ok: true, sampleRate: message.sampleRate, channels: message.channels });
    } else if (message.type === 'error') {
      this.lastError = message.message;
      // «Не поддерживается» перезапуском не лечится — отвечаем сразу.
      if (message.code === 'unsupported') this.settle({ ok: false, error: message.message });
    }
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.settle({ ok: false, error: reason });
    if (!this.wanted) return;
    const base = this.options.restartBaseMs ?? 1000;
    const max = this.options.restartMaxMs ?? 15_000;
    const delay = Math.min(max, base * 2 ** this.attempt);
    this.attempt++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, delay);
  }
}
