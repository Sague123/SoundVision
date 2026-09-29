/**
 * Мост между главным процессом и визуализатором: только «что играет».
 * Звук идёт обычным getDisplayMedia — главный процесс отвечает на него
 * системным loopback без окна выбора.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soundvisionNative', {
  platform: process.platform,
  onNowPlaying(callback) {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('now-playing', listener);
    ipcRenderer.invoke('now-playing:last').then((message) => {
      if (message) callback(message);
    });
    return () => ipcRenderer.removeListener('now-playing', listener);
  },
});
