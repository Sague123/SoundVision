/**
 * SoundVision для Windows: одно окно на весь экран, без браузера, моста и
 * расширения.
 *
 *  - Звук: системный loopback. Запрос getDisplayMedia из визуализатора
 *    обрабатывается здесь без окна выбора — отдаётся звук всего компьютера,
 *    что бы ни играло: браузер, Spotify, любой плеер.
 *  - Что играет: «Сейчас играет» Windows (SMTC) через PowerShell — название,
 *    артист, обложка и позиция. Отдаётся визуализатору через preload.
 *  - Страница грузится по своему протоколу app://, а не file:// — у неё
 *    постоянный origin, поэтому настройки и память режиссёра переживают
 *    перезапуск.
 */

const { app, BrowserWindow, desktopCapturer, ipcMain, net, powerSaveBlocker, protocol, session } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');

// Звуку и WebAudio не нужен клик: это телевизор, кликать некому.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const DIST = path.join(__dirname, '..', 'dist');
let win = null;
let nowPlaying = null;
let lastTrack = null;
let lastCoverKey = '';
let lastCover = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: !process.argv.includes('--windowed'),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'SoundVision',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.loadURL('app://soundvision/index.html');

  // Старт захвата — сразу после загрузки, «с жестом пользователя»: браузер
  // требует жест для getDisplayMedia, а на телевизоре его давать некому.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript('window.__soundvisionAutoStart && window.__soundvisionAutoStart()', true)
      .catch(() => {});
    if (lastTrack) win.webContents.send('now-playing', lastTrack);
  });

  // F11 и Esc — полноэкранный режим; F12 — инструменты разработчика.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false);
    } else if (input.key === 'F12') {
      win.webContents.toggleDevTools();
    }
  });
}

/** Системный звук без окна выбора: экран нужен только как «носитель» звука. */
function setupLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length === 0) {
        callback({});
        return;
      }
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  }, { useSystemPicker: false });
}

/** Файлы dist/ по протоколу app://soundvision/… */
function setupProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let file = decodeURIComponent(url.pathname);
    if (file === '/' || file === '') file = '/index.html';
    const resolved = path.normalize(path.join(DIST, file));
    if (!resolved.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

/** «Сейчас играет» Windows: PowerShell печатает строку JSON в секунду. */
function startNowPlaying() {
  if (process.platform !== 'win32') return;
  const script = path.join(__dirname, 'now-playing.ps1').replace('app.asar', 'app.asar.unpacked');
  nowPlaying = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true });
  const lines = readline.createInterface({ input: nowPlaying.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      // PowerShell в UTF-8 может начать вывод с BOM — JSON с ним не разберётся.
      message = JSON.parse(line.replace(/^﻿/, ''));
    } catch {
      return;
    }
    if (message.type === 'error') {
      console.warn('[now-playing]', message.message);
      return;
    }
    if (message.type === 'now-playing') {
      // Обложка приходит только на смене трека — дальше подставляем запомненную.
      if (message.key !== lastCoverKey) {
        lastCoverKey = message.key;
        lastCover = message.coverUrl || null;
      } else if (message.coverUrl) {
        lastCover = message.coverUrl;
      }
      message.coverUrl = lastCover;
    }
    lastTrack = message;
    if (win && !win.isDestroyed()) win.webContents.send('now-playing', message);
  });
  nowPlaying.stderr.on('data', (data) => console.warn('[now-playing]', data.toString()));
  // Упал — перезапускаем через несколько секунд: без него нет ни обложки, ни текста.
  nowPlaying.on('exit', () => {
    nowPlaying = null;
    if (!app.isQuitting) setTimeout(startNowPlaying, 3000);
  });
}

ipcMain.handle('now-playing:last', () => lastTrack);

app.whenReady().then(() => {
  setupProtocol();
  setupLoopback();
  powerSaveBlocker.start('prevent-display-sleep');
  createWindow();
  startNowPlaying();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  nowPlaying?.kill();
});

app.on('window-all-closed', () => app.quit());
