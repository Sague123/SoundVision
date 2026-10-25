/** Каналы связи интерфейса с главным процессом и то, что отдаёт preload. */

import type { CliOptions } from './cli';
import type { HelperStatus, NowPlayingState } from './now-playing';

export const CH = {
  info: 'sv:info',
  nowPlaying: 'sv:now-playing',
  helperStatus: 'sv:helper-status',
  snapshot: 'sv:snapshot',
  gpu: 'sv:gpu',
  saveReport: 'sv:save-report',
  nextDisplay: 'sv:next-display',
  setPanel: 'sv:set-panel',
  revealReport: 'sv:reveal-report',
  nativeAudioStart: 'sv:native-audio-start',
  nativeAudioStop: 'sv:native-audio-stop',
  pcm: 'sv:pcm',
} as const;

/** Итог запуска захвата звука силами помощника. */
export type NativeAudioResult =
  | { ok: true; sampleRate: number; channels: number }
  | { ok: false; error: string };

export interface DisplayInfo {
  id: number;
  label: string;
  width: number;
  height: number;
  scaleFactor: number;
  /** Частота обновления, Гц; 0 — система не сказала. */
  refreshRate: number;
  primary: boolean;
  current: boolean;
}

/** Права macOS, без которых захват не заработает. На других системах — `null`. */
export interface MacPermissions {
  screen: string;
  microphone: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  osRelease: string;
  electron: string;
  chrome: string;
  packaged: boolean;
  userData: string;
  cli: CliOptions;
  displays: DisplayInfo[];
  showPanel: boolean;
  macPermissions: MacPermissions | null;
}

/** Сведения о видеокарте от главного процесса (`app.getGPUInfo('basic')`). */
export interface GpuInfo {
  devices: Array<{
    vendorId: number; deviceId: number; active: boolean;
    deviceString: string; driverVendor: string; driverVersion: string;
  }>;
  featureStatus: Record<string, string>;
  /** Почему сведений нет: например, GPU отключён из-за падений. */
  error?: string;
}

export interface Snapshot {
  state: NowPlayingState;
  status: HelperStatus;
}

export interface SoundVisionApi {
  getInfo(): Promise<AppInfo>;
  getSnapshot(): Promise<Snapshot>;
  getGpu(): Promise<GpuInfo>;
  /** Сохранить отчёт; `exit` — закрыть приложение после записи. */
  saveReport(json: string, exit: boolean): Promise<string>;
  revealReport(path: string): Promise<void>;
  nextDisplay(): Promise<DisplayInfo[]>;
  setPanelVisible(visible: boolean): Promise<void>;
  /** Захват системного звука помощником (macOS). */
  startNativeAudio(): Promise<NativeAudioResult>;
  stopNativeAudio(): Promise<void>;
  /** Блоки PCM: float32, стерео, кадры подряд L R L R. */
  onPcm(callback: (data: ArrayBuffer) => void): () => void;
  onNowPlaying(callback: (state: NowPlayingState) => void): () => void;
  onHelperStatus(callback: (status: HelperStatus) => void): () => void;
}
