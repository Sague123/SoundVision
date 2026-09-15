/**
 * Точка сборки: захват звука → mood vector → рендер, плюс источники обложки
 * и текста песни. Вся логика живёт в модулях, здесь только проводка.
 */

import './style.css';

import { captureSystemAudio, CaptureError, type AudioCapture } from './audio/capture.ts';
import { idleMood, MoodEngine, type MoodConfig, type MoodVector } from './audio/mood-vector.ts';
import { CoverArtLoader } from './cover/cover-art.ts';
import { NowPlaying, type NowPlayingTrack } from './cover/now-playing.ts';
import { SpotifyClient } from './cover/spotify.ts';
import { YouTubeMusicBridge } from './cover/youtube-music-bridge.ts';
import { fetchLyrics } from './lyrics/lrclib.ts';
import { SyncEngine } from './lyrics/sync-engine.ts';
import { Compositor, type CompositorStats } from './render/compositor.ts';
import { SUBSTANCE_LABELS } from './render/scene.ts';
import type { Settings } from './settings.ts';
import { DebugOverlay } from './ui/debug-overlay.ts';
import { LyricsOverlay } from './ui/lyrics-overlay.ts';
import { NowPlayingCard } from './ui/now-playing-card.ts';
import { loadSettings, saveSettings } from './ui/profiles.ts';
import { SettingsPanel } from './ui/settings-panel.ts';
import { StartScreen } from './ui/start-screen.ts';

const CURSOR_IDLE_MS = 2500;
const STATUS_INTERVAL_MS = 500;

class App {
  private readonly settings: Settings = loadSettings();
  private readonly canvas = document.createElement('canvas');
  private readonly compositor: Compositor;
  private readonly nowPlaying = new NowPlaying();
  private readonly coverLoader = new CoverArtLoader();
  private readonly spotify = new SpotifyClient();
  private readonly bridge = new YouTubeMusicBridge();
  private readonly syncEngine = new SyncEngine();
  private readonly lyricsOverlay = new LyricsOverlay();
  private readonly card = new NowPlayingCard();
  private readonly debugOverlay = new DebugOverlay();
  private readonly panel: SettingsPanel;
  private readonly startScreen: StartScreen;

  private capture: AudioCapture | null = null;
  private moodEngine: MoodEngine | null = null;
  private frameHandle = 0;
  private lastStatusMs = 0;
  private lyricsStatus = 'нет трека';
  private lyricsAbort: AbortController | null = null;
  private cursorTimer = 0;
  private wakeLock: WakeLockSentinel | null = null;

  constructor(private readonly root: HTMLElement) {
    this.canvas.className = 'stage';
    this.compositor = new Compositor(this.canvas);

    this.panel = new SettingsPanel(this.settings, {
      onChange: () => this.persist(),
      onReshuffle: () => this.compositor.reshuffle(),
      onSpotifyConnect: () => void this.connectSpotify(),
      onSpotifyDisconnect: () => {
        this.spotify.disconnect();
        this.settings.sources.spotify = false;
        this.persist();
        this.panel.refresh();
      },
      onReplace: (next) => {
        // Копируем поля в существующий объект: на него уже ссылаются модули.
        Object.assign(this.settings, structuredClone(next));
        this.persist();
        this.panel.refresh();
        this.applySources();
      },
    });

    this.startScreen = new StartScreen({ onStart: () => this.start() });

    this.root.append(
      this.canvas,
      this.lyricsOverlay.element,
      this.card.element,
      this.debugOverlay.element,
      this.panel.element,
      this.startScreen.element,
    );

    this.wireSources();
    this.wireInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  async init(): Promise<void> {
    // Возврат с экрана согласия Spotify: в URL лежит ?code=...
    const exchanged = await this.spotify.handleRedirect();
    if (exchanged) {
      this.settings.sources.spotify = true;
      this.persist();
      this.panel.refresh();
    }
    this.applySources();
    this.applyUiSettings();
    // До захвата звука рисуем на нейтральном mood vector — экран не пустой.
    this.renderIdleFrame();
  }

  private async start(): Promise<void> {
    try {
      this.capture = await captureSystemAudio();
    } catch (err) {
      if (err instanceof CaptureError) throw new Error(err.message);
      throw err;
    }

    this.moodEngine = new MoodEngine(this.capture);
    this.capture.onEnded(() => this.stop());
    this.startScreen.hide();
    void this.requestWakeLock();

    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.capture?.close();
    this.capture = null;
    this.moodEngine = null;
    void this.wakeLock?.release();
    this.wakeLock = null;
    this.startScreen.show();
    this.startScreen.showError('Захват экрана остановлен. Запустите визуализацию заново.');
  }

  private readonly frame = (timestamp: number): void => {
    this.frameHandle = requestAnimationFrame(this.frame);
    const engine = this.moodEngine;
    if (!engine) return;

    const mood = engine.update(timestamp, this.settings.audio as MoodConfig);
    this.renderFrame(mood);
  };

  private renderIdleFrame(): void {
    this.renderFrame(idleMood(performance.now()));
  }

  private renderFrame(mood: MoodVector): void {
    const stats = this.compositor.render(mood, this.settings, this.coverLoader.art);

    const track = this.nowPlaying.current();
    this.card.update(track, this.settings.cover.showCard);
    this.lyricsOverlay.update(
      this.syncEngine.locate(track?.progressMs ?? 0),
      this.settings,
      stats.palette,
    );

    this.debugOverlay.update(mood, stats);

    if (mood.timeMs - this.lastStatusMs > STATUS_INTERVAL_MS) {
      this.lastStatusMs = mood.timeMs;
      if (this.panel.isOpen) this.updateStatus(mood, stats);
    }
  }

  private updateStatus(mood: MoodVector, stats: CompositorStats): void {
    const spotifyState = this.spotify.state;
    const { substance } = stats.scene;
    this.panel.setStatus({
      fps: stats.fps,
      bpm: mood.bpm,
      key: `${mood.key.tonic} ${mood.key.mode === 'major' ? 'мажор' : 'минор'}`,
      section: mood.section,
      source: this.nowPlaying.activeSource ?? 'нет',
      spotify: spotifyState.error ?? spotifyState.status,
      bridge: this.bridge.state,
      lyrics: this.lyricsStatus,
      primitives: stats.activePrimitives.join(', '),
      seed: stats.seedLabel,
      substance: `${SUBSTANCE_LABELS[substance.nearest]} ${substance.axis.toFixed(2)}`,
      harmony: stats.harmonyName,
    });
  }

  private wireSources(): void {
    this.spotify.onTrack((track) => this.nowPlaying.update('spotify', track));
    this.bridge.onTrack((track) => this.nowPlaying.update('youtube-music', track));

    this.nowPlaying.onChange((track, changed) => {
      void this.coverLoader.load(track?.coverUrl ?? null);
      if (!changed) return;
      this.compositor.setTrack(track?.artist ?? null, track?.title ?? null);
      void this.loadLyrics(track);
    });
  }

  private async loadLyrics(track: NowPlayingTrack | null): Promise<void> {
    this.lyricsAbort?.abort();
    this.syncEngine.setLyrics(null);

    if (!track || !this.settings.lyrics.enabled) {
      this.lyricsStatus = track ? 'выключен' : 'нет трека';
      return;
    }

    const controller = new AbortController();
    this.lyricsAbort = controller;
    this.lyricsStatus = 'ищем…';

    const lyrics = await fetchLyrics(track.artist, track.title, track.durationMs, controller.signal);
    if (controller.signal.aborted) return;

    this.syncEngine.setLyrics(lyrics);
    if (!lyrics) this.lyricsStatus = 'не найден';
    else if (!lyrics.synced) this.lyricsStatus = 'без синхронизации';
    else this.lyricsStatus = lyrics.hasWordTiming ? 'караоке' : 'построчно';
  }

  /** Включение/выключение источников по настройкам — идемпотентно. */
  private applySources(): void {
    if (this.settings.sources.spotify && this.spotify.connected) this.spotify.start();
    else this.spotify.stop();

    if (this.settings.sources.bridge) this.bridge.start(this.settings.sources.bridgeUrl);
    else this.bridge.stop();
  }

  private async connectSpotify(): Promise<void> {
    const clientId = window.prompt('Spotify Client ID', this.spotify.clientId);
    if (clientId === null) return;
    this.spotify.clientId = clientId;
    try {
      await this.spotify.authorize();
    } catch (err) {
      window.alert((err as Error).message);
    }
  }

  private persist(): void {
    saveSettings(this.settings);
    this.applySources();
    this.applyUiSettings();
  }

  /**
   * Настройки, которые видны сразу и не ждут следующего кадра рендера.
   * До запуска захвата кадров нет вовсе, а переключатель должен работать.
   */
  private applyUiSettings(): void {
    this.debugOverlay.setVisible(this.settings.debug);
  }

  private wireInput(): void {
    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      switch (event.key.toLowerCase()) {
        case 's':
          this.panel.toggleOpen();
          break;
        case 'f':
          void this.toggleFullscreen();
          break;
        case 'r':
          this.compositor.reshuffle();
          break;
        case 'd':
          this.settings.debug = !this.settings.debug;
          this.persist();
          this.panel.refresh();
          break;
        case 'escape':
          this.panel.close();
          break;
        default:
          break;
      }
    });

    // На телевизоре курсор посреди картинки выглядит как дефект — прячем его.
    window.addEventListener('mousemove', () => {
      document.body.classList.remove('idle');
      window.clearTimeout(this.cursorTimer);
      this.cursorTimer = window.setTimeout(() => document.body.classList.add('idle'), CURSOR_IDLE_MS);
    });

    // Wake lock снимается при сворачивании вкладки — возвращаем его обратно.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.capture) void this.requestWakeLock();
    });
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) {
      console.warn('[app] полноэкранный режим недоступен:', err);
    }
  }

  /** Экран не должен гаснуть посреди вечера. */
  private async requestWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.warn('[app] wake lock недоступен:', err);
    }
  }

  private resize(): void {
    this.compositor.resize(window.innerWidth, window.innerHeight);
    if (!this.capture) this.renderIdleFrame();
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');
void new App(root).init();
