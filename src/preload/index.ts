import { contextBridge, ipcRenderer } from 'electron';
import { CH, type SoundVisionApi } from '../shared/ipc';
import type { HelperStatus, NowPlayingState } from '../shared/now-playing';

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: SoundVisionApi = {
  getInfo: () => ipcRenderer.invoke(CH.info),
  getSnapshot: () => ipcRenderer.invoke(CH.snapshot),
  getGpu: () => ipcRenderer.invoke(CH.gpu),
  saveReport: (json, exit) => ipcRenderer.invoke(CH.saveReport, json, exit),
  revealReport: (path) => ipcRenderer.invoke(CH.revealReport, path),
  nextDisplay: () => ipcRenderer.invoke(CH.nextDisplay),
  setPanelVisible: (visible) => ipcRenderer.invoke(CH.setPanel, visible),
  startNativeAudio: () => ipcRenderer.invoke(CH.nativeAudioStart),
  stopNativeAudio: () => ipcRenderer.invoke(CH.nativeAudioStop),
  onPcm: (callback) => subscribe<ArrayBuffer>(CH.pcm, callback),
  onNowPlaying: (callback) => subscribe<NowPlayingState>(CH.nowPlaying, callback),
  onHelperStatus: (callback) => subscribe<HelperStatus>(CH.helperStatus, callback),
};

contextBridge.exposeInMainWorld('sv', api);
