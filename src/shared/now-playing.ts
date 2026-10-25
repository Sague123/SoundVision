/**
 * Формат сообщений помощника «Сейчас играет».
 *
 * Помощник — отдельная программа: C# на Windows, Swift на macOS. Он печатает
 * в stdout по одному JSON на строку (NDJSON). Формат у обеих систем один и
 * тот же, поэтому остальное приложение не знает, на какой оно ОС.
 *
 * Обложка идёт только в сообщении о смене трека (`cover`), дальше её помнит
 * главный процесс: это десятки килобайт, раз в секунду их гонять незачем.
 */

/** Приложение, чьё воспроизведение читаем, — для отладки и отчёта. */
export type PlayerApp = string;

export interface HelloMessage {
  type: 'hello';
  /** Кто говорит: `windows-smtc`, `macos-mediaremote`, `macos-applescript`, `fake`. */
  helper: string;
  version: string;
}

export interface TrackMessage {
  type: 'track';
  artist: string;
  title: string;
  album: string;
  /** Идентификатор приложения-источника: Spotify, Chrome, Music… */
  app: PlayerApp;
  /** 0 — длительность неизвестна. */
  durationMs: number;
  /** Позиция на момент `positionAt`. */
  positionMs: number;
  /** Время снимка позиции, мс от эпохи Unix, по часам помощника. */
  positionAt: number;
  /**
   * Насколько устарела позиция, которую отдала система, на момент `positionAt`.
   * Помощник уже доплюсовал этот возраст к `positionMs`; поле нужно отчёту:
   * если плеер обновляет позицию раз в десять секунд, точность синхронизации
   * с кэшем трека (этап 5) будет другой, чем если раз в секунду.
   */
  positionAgeMs?: number;
  isPlaying: boolean;
  /**
   * Обложка base64 без префикса. Только в первом сообщении после смены
   * трека; дальше `null` — получатель использует запомненную.
   */
  cover: string | null;
  coverMime: string | null;
}

export interface StoppedMessage {
  type: 'stopped';
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  /** Что именно не получилось, чтобы отчёт мог сказать «блокирует система». */
  code?: 'blocked' | 'unsupported' | 'failed';
}

export type HelperMessage = HelloMessage | TrackMessage | StoppedMessage | ErrorMessage;

/** Трек в том виде, в каком его видит интерфейс. */
export interface NowPlayingState {
  status: 'playing' | 'paused' | 'stopped';
  artist: string;
  title: string;
  album: string;
  app: PlayerApp;
  durationMs: number;
  /** Позиция на момент `receivedAt`. */
  positionMs: number;
  /** `Date.now()` главного процесса в момент получения — база для интерполяции. */
  receivedAt: number;
  /** Возраст позиции, которую отдала система, на момент снимка, мс. */
  positionAgeMs: number;
  /** Обложка как data: URL или `null`. */
  coverUrl: string | null;
}

export interface HelperStatus {
  /** Имя помощника из `hello`, если он уже представился. */
  helper: string | null;
  running: boolean;
  /** Сколько раз помощник перезапускался. */
  restarts: number;
  lastError: string | null;
  /** Когда пришло последнее сообщение, `Date.now()`; 0 — не приходило. */
  lastMessageAt: number;
  /** Путь к помощнику или причина, по которой его нет. */
  path: string | null;
}
