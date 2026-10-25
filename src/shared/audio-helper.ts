/**
 * Сообщения помощника в режиме захвата звука и выравнивание PCM-потока.
 *
 * В этом режиме помощник печатает JSON в stdout (как обычно), а сам звук
 * отдаёт «сырым» потоком в дескриптор 3: float32, два канала подряд (L R L R …).
 */

export interface AudioFormatMessage {
  type: 'format';
  sampleRate: number;
  channels: number;
}

export type AudioHelperMessage =
  | AudioFormatMessage
  | { type: 'hello'; helper: string }
  | { type: 'error'; message: string; code: string };

export function parseAudioLine(line: string): AudioHelperMessage | null {
  const text = line.replace(/^﻿/, '').trim();
  if (!text.startsWith('{')) return null;
  let raw: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    raw = value as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.type === 'hello') return { type: 'hello', helper: typeof raw.helper === 'string' ? raw.helper : '' };
  if (raw.type === 'error') {
    return {
      type: 'error', message: typeof raw.message === 'string' ? raw.message : '',
      code: typeof raw.code === 'string' ? raw.code : 'failed',
    };
  }
  if (raw.type === 'audio-format') {
    const sampleRate = Number(raw.sampleRate);
    const channels = Number(raw.channels);
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384_000) return null;
    return { type: 'format', sampleRate, channels: Number.isFinite(channels) && channels > 0 ? channels : 2 };
  }
  return null;
}

/** Размер одного кадра: два канала float32. */
export const FRAME_BYTES = 8;

/**
 * Труба отдаёт куски произвольной длины, а получателю нужны целые кадры: иначе
 * левый и правый каналы поменяются местами на всё остальное время. Лишние
 * байты ждут следующего куска.
 */
export class FrameAligner {
  private rest = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array | null {
    let data = chunk;
    if (this.rest.length > 0) {
      data = new Uint8Array(this.rest.length + chunk.length);
      data.set(this.rest, 0);
      data.set(chunk, this.rest.length);
    }
    const whole = data.length - (data.length % FRAME_BYTES);
    this.rest = data.slice(whole);
    return whole > 0 ? data.slice(0, whole) : null;
  }

  reset(): void {
    this.rest = new Uint8Array(0);
  }
}
