/**
 * Клиент локального WebSocket-моста. На другом конце — расширение на
 * music.youtube.com, которое шлёт название, артиста, обложку и позицию.
 *
 * Мост локальный (127.0.0.1), поэтому ws:// здесь допустим: трафик не выходит
 * за пределы машины.
 */

import type { NowPlayingTrack } from './now-playing.ts';

export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8787';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** Если расширение молчит дольше — считаем, что вкладка YT Music закрыта. */
const STALE_AFTER_MS = 12000;

export type BridgeStatus = 'disabled' | 'connecting' | 'connected' | 'error';

interface BridgeMessage {
  type: 'now-playing' | 'stopped' | 'hello';
  title?: string;
  artist?: string;
  coverUrl?: string | null;
  positionMs?: number;
  durationMs?: number;
  isPlaying?: boolean;
}

export class YouTubeMusicBridge {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private staleTimer: number | null = null;
  private status: BridgeStatus = 'disabled';
  private enabled = false;
  private listeners: Array<(track: NowPlayingTrack | null) => void> = [];

  constructor(private url: string = DEFAULT_BRIDGE_URL) {}

  get state(): BridgeStatus {
    return this.status;
  }

  onTrack(listener: (track: NowPlayingTrack | null) => void): void {
    this.listeners.push(listener);
  }

  start(url = this.url): void {
    this.url = url;
    this.enabled = true;
    this.connect();
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.status = 'disabled';
    this.emit(null);
  }

  private connect(): void {
    if (!this.enabled) return;
    this.status = 'connecting';

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.status = 'error';
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.status = 'connected';
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify({ type: 'hello', role: 'visualizer' }));
    });

    socket.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });

    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      this.status = this.enabled ? 'error' : 'disabled';
      this.emit(null);
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      this.status = 'error';
    });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw) as BridgeMessage;
    } catch {
      return;
    }
    if (message.type === 'hello') return;
    if (message.type === 'stopped' || !message.title) {
      this.emit(null);
      return;
    }

    this.emit({
      title: message.title,
      artist: message.artist ?? '',
      coverUrl: message.coverUrl ?? null,
      progressMs: message.positionMs ?? 0,
      durationMs: message.durationMs ?? 0,
      isPlaying: message.isPlaying ?? true,
      source: 'youtube-music',
      receivedAt: performance.now(),
    });
    this.armStaleTimer();
  }

  /** Расширение шлёт обновления регулярно; молчание означает «нечего играть». */
  private armStaleTimer(): void {
    if (this.staleTimer !== null) window.clearTimeout(this.staleTimer);
    this.staleTimer = window.setTimeout(() => this.emit(null), STALE_AFTER_MS);
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.staleTimer !== null) window.clearTimeout(this.staleTimer);
    this.reconnectTimer = null;
    this.staleTimer = null;
  }

  private emit(track: NowPlayingTrack | null): void {
    for (const listener of this.listeners) listener(track);
  }
}
