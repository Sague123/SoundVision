/**
 * Связь с оболочкой-exe (Electron). В браузере её нет — тогда `null`, и
 * приложение работает как раньше.
 *
 * Оболочка даёт две вещи: системный звук без окна выбора (на обычный
 * getDisplayMedia она отвечает loopback-звуком всего компьютера) и
 * «Сейчас играет» Windows — название, артиста, обложку и позицию любого
 * плеера. Сюда приходит только второе; звук берётся штатным захватом.
 */

import type { NowPlayingTrack } from './cover/now-playing.ts';

export interface NativeTrackMessage {
  type: 'now-playing' | 'stopped';
  title?: string;
  artist?: string;
  coverUrl?: string | null;
  positionMs?: number;
  durationMs?: number;
  isPlaying?: boolean;
  /** Какое приложение играет — для отладки. */
  app?: string;
}

export interface SoundVisionNative {
  platform: string;
  onNowPlaying(callback: (message: NativeTrackMessage) => void): () => void;
}

export function nativeShell(): SoundVisionNative | null {
  return (window as unknown as { soundvisionNative?: SoundVisionNative }).soundvisionNative ?? null;
}

export function nativeTrack(message: NativeTrackMessage): NowPlayingTrack | null {
  if (message.type !== 'now-playing' || !message.title) return null;
  return {
    title: message.title,
    artist: message.artist ?? '',
    coverUrl: message.coverUrl ?? null,
    progressMs: message.positionMs ?? 0,
    durationMs: message.durationMs ?? 0,
    isPlaying: message.isPlaying ?? true,
    source: 'system',
    receivedAt: performance.now(),
  };
}
