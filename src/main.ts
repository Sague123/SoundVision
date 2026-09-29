/**
 * Точка сборки: захват звука → mood vector → рендер, плюс источники обложки
 * и текста песни. Вся логика живёт в модулях, здесь только проводка.
 */

import './style.css';

import { captureMicrophone, captureSystemAudio, CaptureError, type AudioCapture } from './audio/capture.ts';
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
import { loadFonts } from './ui/fonts.ts';
import { LyricsOverlay } from './ui/lyrics-overlay.ts';
import { NowPlayingCard } from './ui/now-playing-card.ts';
import { loadSettings, saveSettings } from './ui/presets.ts';
import { SettingsPanel } from './ui/settings-panel.ts';
import { StartScreen, type AudioSourceKind } from './ui/start-screen.ts';
import { DirectorRuntime, type DirectorStep } from './director/runtime.ts';
import { DirectorHud } from './ui/director-hud.ts';

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
  /** Режиссёр целиком: признаки, состояние, решения, обучение. */
  private readonly director = new DirectorRuntime();
  private readonly hud: DirectorHud;
  private lastStep: DirectorStep | null = null;
  private lastDetailsMs = 0;
  /** Снимок настроек для неявной обратной связи: что именно поменял зритель. */
  private watched = watchedSnapshot(null);
  private readonly panel: SettingsPanel;
  private readonly startScreen: StartScreen;

  private capture: AudioCapture | null = null;
  private moodEngine: MoodEngine | null = null;
  private frameHandle = 0;
  /** Время последнего отрисованного кадра — по нему работает лимит fps. */
  private lastFrameMs = 0;
  private lastStatusMs = 0;
  private lyricsStatus = 'нет трека';
  private lyricsAbort: AbortController | null = null;
  /** Когда начали отсчёт позиции у ручного трека. */
  private manualStartedAt = 0;
  private manualIdentity = '';
  private cursorTimer = 0;
  /** Какие гарнитуры реально подгрузились и содержат кириллицу. */
  private fontStatus = 'загружаются…';
  private wakeLock: WakeLockSentinel | null = null;

  constructor(private readonly root: HTMLElement) {
    this.canvas.className = 'stage';
    this.compositor = new Compositor(this.canvas);
    this.hud = new DirectorHud(
      (index) => this.director.coach.answer(index, performance.now()),
      () => this.director.coach.rejectAll(performance.now()),
    );
    this.watched = watchedSnapshot(this.settings);

    this.panel = new SettingsPanel(this.settings, {
      onChange: () => {
        this.persist();
        // Только ручной трек: applySources целиком дёргал бы Spotify и мост
        // на каждое движение любого ползунка.
        this.applyManualTrack();
        this.learnFromPanel();
        this.applyUiSettings();
      },
      onReshuffle: () => this.compositor.reshuffle(),
      onSpotifyConnect: () => void this.connectSpotify(),
      onSpotifyDisconnect: () => {
        this.spotify.disconnect();
        this.settings.sources.spotify = false;
        this.persist();
        this.panel.refresh();
      },
      onDirectorReset: () => this.director.model.reset(),
      onDirectorExport: () => this.director.model.export(),
      onReplace: (next) => {
        // Смена пресета — сигнал, что текущая картинка не устроила.
        this.director.presetSwitched();
        // Копируем поля в существующий объект: на него уже ссылаются модули.
        Object.assign(this.settings, structuredClone(next));
        this.watched = watchedSnapshot(this.settings);
        this.persist();
        this.panel.refresh();
        this.applySources();
      },
    });

    this.startScreen = new StartScreen({ onStart: (source) => this.start(source) });

    this.root.append(
      this.canvas,
      this.lyricsOverlay.element,
      this.card.element,
      this.card.progressLine,
      this.debugOverlay.element,
      this.hud.element,
      this.hud.questionElement,
      this.panel.element,
      this.startScreen.element,
    );

    this.wireSources();
    this.wireInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Панель выезжает с анимацией, поэтому одного события resize мало:
    // холст меняет ширину постепенно, и ловить это надо наблюдателем.
    new ResizeObserver(() => this.resize()).observe(this.canvas);
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
    void this.loadFonts();
    // До захвата звука рисуем на нейтральном mood vector — экран не пустой.
    this.renderIdleFrame();
  }

  private async start(source: AudioSourceKind): Promise<void> {
    try {
      this.capture = source === 'microphone' ? await captureMicrophone() : await captureSystemAudio();
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

    // Лимит кадров: пропускаем кадр целиком, а не только рендер, — анализ
    // читает те же данные анализатора и на пропуске ничего не теряет.
    const limit = this.settings.quality.fpsLimit;
    if (limit > 0) {
      // Полкадра допуска: без него частота залипает на половине лимита,
      // потому что монитор почти никогда не попадает в интервал точно.
      const minStep = 1000 / limit - 8;
      if (timestamp - this.lastFrameMs < minStep) return;
    }
    this.lastFrameMs = timestamp;

    const mood = engine.update(timestamp, this.settings.audio as MoodConfig);
    this.renderFrame(mood, true);
  };

  private renderIdleFrame(): void {
    this.renderFrame(idleMood(performance.now()), false);
  }

  /**
   * @param live — кадр живого звука. Режиссёр работает только на нём: на
   *   нейтральном кадре до запуска захвата ему нечего слушать.
   */
  private renderFrame(mood: MoodVector, live: boolean): void {
    const step = live ? this.director.step(mood, this.settings) : null;
    this.lastStep = step;
    const stats = this.compositor.render(mood, this.settings, this.coverLoader.art, step?.output ?? null);

    const track = this.nowPlaying.current();
    this.card.update(track, this.settings, mood.timeMs);
    this.lyricsOverlay.update(
      this.syncEngine.locate(track?.progressMs ?? 0),
      this.settings,
      stats.palette,
      mood,
      stats.meanLuminance,
      step?.output?.typography ?? 1,
    );

    this.hud.update(step, this.settings, mood.timeMs);
    // Активные эффекты и решение собираются в массивы — не на каждом кадре.
    const detailsDue = mood.timeMs - this.lastDetailsMs > 150;
    const decisions = this.director.director.decisions;
    const decision = decisions[decisions.length - 1] ?? null;
    if (detailsDue && (this.settings.director.hud || this.settings.debug)) {
      this.lastDetailsMs = mood.timeMs;
      const effects = this.director.director.activeEffects();
      this.hud.updateDetails(effects, decision
        ? `${decision.reason || '—'}${decision.transition ? ` · ${decision.transition}` : ''}`
        : '', this.director.model.profile, this.director.model.observationCount);
      this.debugOverlay.update(mood, stats, step ? {
        step, effects, decision, decisionMs: this.director.director.lastTickMs,
      } : null);
    } else if (!this.settings.debug) {
      this.debugOverlay.update(mood, stats);
    }

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
      particles: stats.transient.particleTypes.join(', '),
      budget: `${stats.scene.budget.load.toFixed(2)} / ${stats.scene.budget.limit || '∞'}`,
      fonts: this.fontStatus,
    });
  }

  private wireSources(): void {
    this.spotify.onTrack((track) => this.nowPlaying.update('spotify', track));
    this.bridge.onTrack((track) => this.nowPlaying.update('youtube-music', track));

    this.nowPlaying.onChange((track, changed) => {
      void this.coverLoader.load(track?.coverUrl ?? null);
      if (!changed) return;
      this.compositor.setTrack(
        track?.artist ?? null, track?.title ?? null, this.settings.generator.lockSeed,
      );
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

    this.applyManualTrack();
  }

  /**
   * Трек, введённый руками, в общий поток «что сейчас играет».
   *
   * Позицию ведём сами от момента ввода: у ручного трека нет источника,
   * который бы её сообщал, а тексту песни позиция нужна на каждом кадре.
   * Поэтому «играет» начинается в момент, когда поле заполнили.
   */
  private applyManualTrack(): void {
    const { manualArtist, manualTitle, manualDurationSec } = this.settings.sources;
    const artist = manualArtist.trim();
    const title = manualTitle.trim();
    if (!title) {
      this.nowPlaying.update('manual', null);
      this.manualStartedAt = 0;
      return;
    }

    const identity = `${artist}|${title}|${manualDurationSec}`;
    if (identity !== this.manualIdentity) {
      this.manualIdentity = identity;
      this.manualStartedAt = performance.now();
    }

    this.nowPlaying.update('manual', {
      title,
      artist,
      coverUrl: null,
      progressMs: 0,
      durationMs: Math.max(0, manualDurationSec) * 1000,
      isPlaying: true,
      source: 'manual',
      receivedAt: this.manualStartedAt,
    });
  }

  /**
   * Гарнитуры подключаются и сразу проверяются на кириллицу: доверять списку
   * на слово нельзя, а русский текст без глифов молча уедет в запасной шрифт.
   */
  private async loadFonts(): Promise<void> {
    try {
      const reports = await loadFonts();
      const missing = reports.filter((report) => !report.cyrillic).map((report) => report.name);
      this.fontStatus = missing.length === 0
        ? `все ${reports.length} с кириллицей`
        : `без кириллицы: ${missing.join(', ')}`;
      if (missing.length > 0) {
        console.warn('[fonts] кириллица не подтвердилась:', missing.join(', '));
      }
    } catch (err) {
      this.fontStatus = 'не загрузились';
      console.warn('[fonts] не удалось загрузить гарнитуры:', err);
    }
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
    void this.loadFonts();
  }

  /**
   * Настройки, которые видны сразу и не ждут следующего кадра рендера.
   * До запуска захвата кадров нет вовсе, а переключатель должен работать.
   */
  private applyUiSettings(): void {
    this.debugOverlay.setVisible(this.settings.debug);
    this.hud.setVisible(this.settings.director.hud);
  }

  /**
   * Неявное обучение из панели: выключил эффект — минус ему в этом
   * контексте, прибавил интенсивность — плюс текущей сцене, убавил — минус.
   * Сравниваем со снимком прошлого состояния, чтобы понять, что именно
   * поменялось, — панель сообщает лишь «что-то изменилось».
   */
  private learnFromPanel(): void {
    const next = watchedSnapshot(this.settings);
    const prev = this.watched;
    this.watched = next;
    if (!this.lastStep) return;
    for (const [id, enabled] of Object.entries(next.enabled)) {
      if (prev.enabled[id] !== enabled) this.director.effectToggled(id, enabled);
    }
    this.director.intensityChanged(next.intensity - prev.intensity);
  }

  private wireInput(): void {
    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      switch (event.key.toLowerCase()) {
        case 's':
          this.panel.toggleOpen();
          this.root.classList.toggle('app--panel', this.panel.isOpen);
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
          this.root.classList.remove('app--panel');
          break;
        // Режиссёр: пропустить сцену, похвалить, отвергнуть.
        case 'n':
          if (this.lastStep) this.director.skip(performance.now());
          break;
        case 'l':
          if (this.lastStep) this.director.like();
          break;
        case 'x':
          if (this.lastStep) this.director.reject(performance.now());
          break;
        case 'h':
          this.settings.director.hud = !this.settings.director.hud;
          this.persist();
          this.applyUiSettings();
          this.panel.refresh();
          break;
        case 't':
          this.settings.director.training = !this.settings.director.training;
          this.persist();
          this.applyUiSettings();
          this.panel.refresh();
          break;
        // Ответ на вопрос обучения: цифра — вариант, 0 — ни один.
        case '0':
          this.director.coach.rejectAll(performance.now());
          break;
        case '1':
        case '2':
        case '3':
        case '4':
          if (this.director.coach.current) this.director.coach.answer(Number(event.key) - 1, performance.now());
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

    // Память режиссёра пишется в хранилище не чаще раза в несколько секунд —
    // при закрытии дописываем хвост.
    window.addEventListener('pagehide', () => this.director.flush());

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

  /**
   * Размер берём у самого холста, а не у окна: открытая панель ужимает сцену,
   * и по `window.innerWidth` рендер оказался бы шире видимой области.
   */
  private resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.compositor.resize(width, height);
    if (!this.capture) this.renderIdleFrame();
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');
void new App(root).init();

/** То, по изменению чего режиссёр учится неявно. */
function watchedSnapshot(settings: Settings | null): { enabled: Record<string, boolean>; intensity: number } {
  if (!settings) return { enabled: {}, intensity: 0 };
  const enabled: Record<string, boolean> = {};
  for (const [id, p] of Object.entries(settings.primitives)) enabled[id] = p.enabled;
  // Интенсивность — среднее ручек, которые делают кадр насыщеннее.
  const intensity = (settings.transients.intensity + settings.particles.density
    + settings.light.bloom + settings.motion.amount) / 4;
  return { enabled, intensity };
}
