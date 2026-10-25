/**
 * Главный процесс SoundVision.
 *
 * Делает то, что интерфейсу недоступно или должно быть одинаковым везде:
 * окно на нужном мониторе, системный звук, помощник «Сейчас играет», файлы.
 * Всё, что зависит от системы, живёт здесь или в помощниках; интерфейс
 * видит только `window.sv`.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, release } from 'node:os';
import { extname, join, normalize } from 'node:path';
import {
  BrowserWindow, app, desktopCapturer, ipcMain, powerSaveBlocker, protocol, screen, session, shell,
  systemPreferences,
} from 'electron';
import { parseCli } from '../shared/cli';
import { CH, type AppInfo, type DisplayInfo, type GpuInfo } from '../shared/ipc';
import { loadConfig, saveConfig, type AppConfig } from './config';
import { nextDisplay, pickDisplay } from './display';
import { resolveHelper } from './now-playing/helper-path';
import { NowPlayingService } from './now-playing/service';

const cli = parseCli(process.argv.slice(1));
const APP_SCHEME = 'app';
const APP_URL = `${APP_SCHEME}://soundvision/index.html`;

// Телевизор: кликать некому, звук и WebAudio стартуют без жеста.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win: BrowserWindow | null = null;
let config: AppConfig;
let service: NowPlayingService;
let currentDisplayId = 0;
let hardExitTimer: ReturnType<typeof setTimeout> | null = null;

const configFile = (): string => join(app.getPath('userData'), 'config.json');
const rendererDir = (): string => join(__dirname, '..', 'renderer');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => service?.stop());
}

async function start(): Promise<void> {
  config = loadConfig(configFile());
  registerAppProtocol();
  registerSession();
  registerIpc();

  const helper = resolveHelper({
    platform: process.platform, packaged: app.isPackaged, resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(), fake: cli.fakeHelper, execPath: process.execPath, exists: existsSync,
  });
  service = new NowPlayingService(helper.spec ?? null, helper.reason ?? null);
  service.on('state', (state) => win?.webContents.send(CH.nowPlaying, state));
  service.on('status', (status) => win?.webContents.send(CH.helperStatus, status));
  service.start();

  // Экран не гаснет, пока идёт шоу.
  powerSaveBlocker.start('prevent-display-sleep');
  createWindow();

  // Запуск без интерфейса не должен зависать, если самопроверка не дошла до конца.
  if (cli.selfcheckExit) hardExitTimer = setTimeout(() => app.exit(2), 120_000);
}

// ─── Окно ───────────────────────────────────────────────────────────────

function chooseDisplay(): Electron.Display {
  return pickDisplay(screen.getAllDisplays(), {
    cliIndex: cli.display, savedId: config.displayId, primaryId: screen.getPrimaryDisplay().id,
  });
}

function createWindow(): void {
  const display = chooseDisplay();
  currentDisplayId = display.id;
  const { x, y, width, height } = display.bounds;

  win = new BrowserWindow({
    x, y, width: cli.windowed ? Math.round(width * 0.8) : width, height: cli.windowed ? Math.round(height * 0.8) : height,
    show: false, backgroundColor: '#000000', autoHideMenuBar: true, title: 'SoundVision',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      // Шоу идёт на втором мониторе: окно не должно «засыпать» без фокуса.
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    if (!win) return;
    win.show();
    if (!cli.windowed) setFullScreen(true);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] рендер упал:', details.reason);
    if (details.reason !== 'clean-exit') win?.webContents.reload();
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { setFullScreen(!isFullScreen()); event.preventDefault(); }
    else if (input.key === 'Escape' && isFullScreen()) { setFullScreen(false); event.preventDefault(); }
    else if (input.key === 'F2') { moveToNextDisplay(); event.preventDefault(); }
    else if (input.key === 'F12') { win?.webContents.toggleDevTools(); event.preventDefault(); }
  });
  win.on('closed', () => { win = null; });

  startAudioWithGesture(win);
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  void win.loadURL(devUrl ?? APP_URL);
}

// На macOS обычный полный экран уводит окно в отдельное пространство с
// анимацией и мешает второму монитору; «простой» режим ведёт себя как на Windows.
function isFullScreen(): boolean {
  if (!win) return false;
  return process.platform === 'darwin' ? win.isSimpleFullScreen() : win.isFullScreen();
}

function setFullScreen(on: boolean): void {
  if (!win) return;
  if (process.platform === 'darwin') win.setSimpleFullScreen(on);
  else win.setFullScreen(on);
}

function moveToNextDisplay(): DisplayInfo[] {
  if (!win) return displayList();
  const target = nextDisplay(screen.getAllDisplays(), currentDisplayId);
  const wasFull = isFullScreen();
  if (wasFull) setFullScreen(false);
  win.setBounds(target.bounds);
  currentDisplayId = target.id;
  config = { ...config, displayId: target.id };
  saveConfig(configFile(), config);
  // Полный экран возвращаем после того, как окно переехало, иначе система
  // разворачивает его на старом мониторе.
  if (wasFull) setTimeout(() => setFullScreen(true), 250);
  return displayList();
}

function displayList(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, index) => ({
    id: d.id,
    label: d.label || `Монитор ${index + 1}`,
    width: d.size.width,
    height: d.size.height,
    scaleFactor: d.scaleFactor,
    refreshRate: d.displayFrequency || 0,
    primary: d.id === primary,
    current: d.id === currentDisplayId,
  }));
}

// ─── Протокол и права ───────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json',
};

/**
 * Страница открывается по своему адресу `app://`, а не как файл: у неё
 * постоянный origin, а модули и аудио-воркеры грузятся как с обычного сервера.
 * Читаем через `fs`, а не `net.fetch`: так работает и внутри asar.
 */
function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path === '') path = '/index.html';
    const root = rendererDir();
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(new Uint8Array(body), { headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function isOurOrigin(origin: string): boolean {
  return origin.startsWith(`${APP_SCHEME}://`) || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
}

function registerSession(): void {
  const ses = session.defaultSession;

  // Права — только своей странице и только тем, что нужны: звук, захват, полный экран.
  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'speaker-selection']);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && isOurOrigin(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && isOurOrigin(origin));

  /*
   * Системный звук без окна выбора. getDisplayMedia требует видео, поэтому
   * отдаём первый экран — интерфейс сразу останавливает видеодорожку и берёт
   * только звук. На Windows `loopback` — звук всего компьютера. Электрон 44
   * документирует его как «только Windows»: на macOS запрос может вернуться без
   * звуковой дорожки — это и проверяет самопроверка, а интерфейс тогда берёт
   * виртуальное устройство.
   */
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (sources.length === 0) callback({});
        else callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => callback({}));
  }, { useSystemPicker: false });
}

// ─── IPC ────────────────────────────────────────────────────────────────

function macPermissions(): AppInfo['macPermissions'] {
  if (process.platform !== 'darwin') return null;
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
  };
}

function appInfo(): AppInfo {
  return {
    version: app.getVersion(), platform: process.platform, arch: arch(), osRelease: release(),
    electron: process.versions.electron, chrome: process.versions.chrome, packaged: app.isPackaged,
    userData: app.getPath('userData'), cli, displays: displayList(), showPanel: config.showPanel,
    macPermissions: macPermissions(),
  };
}

async function gpuInfo(): Promise<GpuInfo> {
  try {
    const basic = (await app.getGPUInfo('basic')) as { gpuDevice?: Array<Record<string, unknown>> };
    return {
      devices: (basic.gpuDevice ?? []).map((d) => ({
        vendorId: Number(d.vendorId ?? 0), deviceId: Number(d.deviceId ?? 0), active: d.active === true,
        deviceString: String(d.deviceString ?? ''), driverVendor: String(d.driverVendor ?? ''),
        driverVersion: String(d.driverVersion ?? ''),
      })),
      featureStatus: app.getGPUFeatureStatus() as unknown as Record<string, string>,
    };
  } catch (error) {
    // Chromium отключает GPU после частых падений драйвера — это тоже факт для отчёта.
    return { devices: [], featureStatus: {}, error: (error as Error).message };
  }
}

function registerIpc(): void {
  ipcMain.handle(CH.info, () => appInfo());
  ipcMain.handle(CH.snapshot, () => ({ state: service.getState(), status: service.getStatus() }));
  ipcMain.handle(CH.gpu, () => gpuInfo());
  ipcMain.handle(CH.nextDisplay, () => moveToNextDisplay());
  ipcMain.handle(CH.setPanel, (_event, visible: boolean) => {
    config = { ...config, showPanel: visible === true };
    saveConfig(configFile(), config);
  });

  ipcMain.handle(CH.saveReport, async (_event, json: string, exit: boolean) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = cli.reportPath ?? join(app.getPath('userData'), 'reports', `stage0-${process.platform}-${stamp}.json`);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, json, 'utf8');
    if (exit) {
      if (hardExitTimer) clearTimeout(hardExitTimer);
      setTimeout(() => app.exit(0), 100);
    }
    return file;
  });
  ipcMain.handle(CH.revealReport, (_event, path: string) => {
    if (typeof path === 'string' && path.startsWith(app.getPath('userData'))) shell.showItemInFolder(path);
  });
}

/**
 * getDisplayMedia просит жест пользователя, а на телевизоре его давать
 * некому. Главный процесс выполняет запуск звука «как будто по клику» —
 * сразу после загрузки и потом каждые несколько секунд, пока звук не пойдёт.
 */
export function startAudioWithGesture(window: BrowserWindow): void {
  const kick = (): void => {
    if (window.isDestroyed()) return;
    window.webContents
      .executeJavaScript('window.__svEnsureAudio && window.__svEnsureAudio()', true)
      .catch(() => { /* страница ещё грузится — повторим */ });
  };
  window.webContents.on('did-finish-load', kick);
  const timer = setInterval(kick, 5000);
  window.on('closed', () => clearInterval(timer));
}
