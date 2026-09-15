/**
 * Панель настроек. Правит один и тот же объект Settings, который читают
 * анализатор и рендер, — поэтому всё применяется со следующего кадра.
 */

import { HARMONY_SCHEMES } from '../render/palette.ts';
import { ALL_PRIMITIVE_IDS, PRIMITIVE_LABELS, type PrimitiveId } from '../render/primitives/types.ts';
import { MAX_SAFE_FLASH_HZ, PRESET_PROFILES, type Settings } from '../settings.ts';
import {
  button, colorField, note, row, section, select, slider, textField, toggle, type Control,
} from './controls.ts';
import { deleteProfile, listProfiles, presetSettings, saveProfile } from './profiles.ts';

export interface PanelStatus {
  fps: number;
  bpm: number;
  key: string;
  section: string;
  source: string;
  spotify: string;
  bridge: string;
  lyrics: string;
  primitives: string;
  seed: string;
  substance: string;
  harmony: string;
}

export interface SettingsPanelHandlers {
  /** Настройки изменились — сохранить и применить. */
  onChange(): void;
  onReshuffle(): void;
  onSpotifyConnect(): void;
  onSpotifyDisconnect(): void;
  /** Полная замена настроек (загрузка профиля или шаблона). */
  onReplace(settings: Settings): void;
}

export class SettingsPanel {
  readonly element = document.createElement('aside');
  private readonly body = document.createElement('div');
  private readonly statusBox = document.createElement('dl');
  private readonly profileList = document.createElement('div');
  private readonly controls: Control[] = [];
  private profileName = '';

  constructor(private readonly settings: Settings, private readonly handlers: SettingsPanelHandlers) {
    this.element.className = 'panel panel--hidden';

    const header = document.createElement('header');
    header.className = 'panel__header';
    header.innerHTML = '<h2>Настройки</h2>';
    header.append(button('✕', () => this.close(), 'panel__button--ghost'));

    this.body.className = 'panel__body';
    this.statusBox.className = 'panel__status';
    this.profileList.className = 'panel__profiles';

    this.element.append(header, this.body);
    this.build();
    this.renderProfiles();
  }

  get isOpen(): boolean {
    return !this.element.classList.contains('panel--hidden');
  }

  toggleOpen(): void {
    this.element.classList.toggle('panel--hidden');
  }

  close(): void {
    this.element.classList.add('panel--hidden');
  }

  /** Перечитать все поля — после загрузки профиля или шаблона. */
  refresh(): void {
    for (const control of this.controls) control.sync();
    this.renderProfiles();
  }

  setStatus(status: PanelStatus): void {
    const rows: Array<[string, string]> = [
      ['FPS', status.fps.toFixed(0)],
      ['BPM', status.bpm.toFixed(1)],
      ['Тональность', status.key],
      ['Секция', status.section],
      ['Вещество', status.substance],
      ['Гармония', status.harmony],
      ['Примитивы', status.primitives || '—'],
      ['Seed', status.seed],
      ['Источник', status.source],
      ['Spotify', status.spotify],
      ['YT Music', status.bridge],
      ['Текст', status.lyrics],
    ];
    this.statusBox.replaceChildren();
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      this.statusBox.append(dt, dd);
    }
  }

  private track<T extends Control>(control: T): T {
    // Все контролы сообщают об изменении одинаково — оборачиваем один раз здесь.
    control.element.addEventListener('input', () => this.handlers.onChange());
    control.element.addEventListener('change', () => this.handlers.onChange());
    this.controls.push(control);
    return control;
  }

  private build(): void {
    const s = this.settings;

    this.body.append(section('Состояние', this.statusBox));

    this.body.append(section(
      'Чувствительность',
      this.track(slider({
        label: 'Сглаживание', min: 0, max: 0.95, step: 0.01,
        get: () => s.audio.smoothing, set: (v) => { s.audio.smoothing = v; },
      })),
      this.track(slider({
        label: 'Энергия', min: 0.2, max: 3, step: 0.05,
        get: () => s.audio.energyGain, set: (v) => { s.audio.energyGain = v; },
      })),
      this.track(slider({
        label: 'Flux', min: 0.2, max: 3, step: 0.05,
        get: () => s.audio.fluxGain, set: (v) => { s.audio.fluxGain = v; },
      })),
      this.track(slider({
        label: 'Яркость тембра', min: 0.2, max: 3, step: 0.05,
        get: () => s.audio.brightnessGain, set: (v) => { s.audio.brightnessGain = v; },
      })),
      this.track(slider({
        label: 'Шумность (ZCR)', min: 0.2, max: 3, step: 0.05,
        get: () => s.audio.noisinessGain, set: (v) => { s.audio.noisinessGain = v; },
      })),
      this.track(slider({
        label: 'Порог удара', min: 1.05, max: 3, step: 0.05,
        get: () => s.audio.onsetThreshold, set: (v) => { s.audio.onsetThreshold = v; },
      })),
      this.track(slider({
        label: 'BPM вручную', min: 0, max: 200, step: 1,
        get: () => s.audio.bpmOverride ?? 0,
        // 0 — специальное значение «не переопределять».
        set: (v) => { s.audio.bpmOverride = v > 0 ? v : null; },
        format: (v) => (v > 0 ? v.toFixed(0) : 'авто'),
      })),
    ));

    this.body.append(section(
      'Микс слоёв',
      ...(['base', 'genre', 'transient'] as const).flatMap((key) => {
        const labels = { base: 'База', genre: 'Жанр', transient: 'Транзиенты' };
        return [
          this.track(toggle({
            label: labels[key],
            get: () => s.layers[key].enabled,
            set: (v) => { s.layers[key].enabled = v; },
          })),
          this.track(slider({
            label: `${labels[key]}: вес`, min: 0, max: 1, step: 0.01,
            get: () => s.layers[key].weight, set: (v) => { s.layers[key].weight = v; },
            format: (v) => `${Math.round(v * 100)}%`,
          })),
        ];
      }),
    ));

    this.body.append(section(
      'Генератор',
      this.track(select({
        label: 'Набор примитивов',
        options: [
          { value: 'auto', label: 'Авто (по настроению)' },
          { value: 'manual', label: 'Вручную' },
        ],
        get: () => s.generator.mode,
        set: (v) => { s.generator.mode = v; },
      })),
      ...ALL_PRIMITIVE_IDS.map((id: PrimitiveId) => this.track(toggle({
        label: PRIMITIVE_LABELS[id],
        get: () => s.generator.manual.includes(id),
        set: (v) => {
          const set = new Set(s.generator.manual);
          if (v) set.add(id);
          else set.delete(id);
          s.generator.manual = [...set];
        },
      }))),
      note('Ручной список работает только в режиме «Вручную».'),
      this.track(slider({
        label: 'Скорость морфинга', min: 0.2, max: 3, step: 0.05,
        get: () => s.generator.morphRate, set: (v) => { s.generator.morphRate = v; },
      })),
      this.track(slider({
        label: 'Качество raymarch', min: 0.3, max: 1, step: 0.05,
        get: () => s.generator.quality, set: (v) => { s.generator.quality = v; },
        format: (v) => `${Math.round(v * 100)}%`,
      })),
      row(button('Reshuffle', () => this.handlers.onReshuffle(), 'panel__button--accent')),
      note('Reshuffle даёт тому же треку новую стартовую точку генератора.'),
    ));

    this.body.append(section(
      'Палитра',
      note('Оттенок берётся от тоники по квинтовому кругу, температура — от лада. '
        + 'Схема задаёт, как от этого оттенка строится остальная палитра.'),
      this.track(select({
        label: 'Гармония',
        options: [
          { value: 'auto', label: 'Авто (от seed трека)' },
          ...HARMONY_SCHEMES.map((scheme) => ({ value: scheme.id, label: scheme.name })),
        ],
        get: () => s.palette.harmonyId,
        set: (v) => { s.palette.harmonyId = v; },
      })),
      this.track(slider({
        label: 'Сдвиг оттенка', min: -180, max: 180, step: 1,
        get: () => s.palette.tuning.hueOffset,
        set: (v) => { s.palette.tuning.hueOffset = v; },
        format: (v) => `${v.toFixed(0)}°`,
      })),
      this.track(slider({
        label: 'Хрома', min: 0, max: 2, step: 0.05,
        get: () => s.palette.tuning.chromaBoost,
        set: (v) => { s.palette.tuning.chromaBoost = v; },
        format: (v) => `${Math.round(v * 100)}%`,
      })),
      this.track(slider({
        label: 'Светлота форм', min: 0.5, max: 1.5, step: 0.02,
        get: () => s.palette.tuning.lightnessBoost,
        set: (v) => { s.palette.tuning.lightnessBoost = v; },
        format: (v) => `${Math.round(v * 100)}%`,
      })),
      this.track(slider({
        label: 'Температура лада', min: 0, max: 1, step: 0.02,
        get: () => s.palette.tuning.temperature,
        set: (v) => { s.palette.tuning.temperature = v; },
        format: (v) => `${Math.round(v * 100)}%`,
      })),
      this.track(slider({
        label: 'Якорь обложки', min: 0, max: 1, step: 0.02,
        get: () => s.palette.tuning.coverWeight,
        set: (v) => { s.palette.tuning.coverWeight = v; },
        format: (v) => `${Math.round(v * 100)}%`,
      })),
    ));

    this.body.append(section(
      'Камера',
      note('Наблюдатель внутри сцены: дрейф, орбита в темпе, наезд на билд-апе и крен. '
        + 'Удар даёт камере толчок.'),
      this.track(toggle({
        label: 'Движение камеры',
        get: () => s.camera.enabled,
        set: (v) => { s.camera.enabled = v; },
      })),
      this.track(slider({
        label: 'Амплитуда', min: 0, max: 1, step: 0.02,
        get: () => s.camera.amount,
        set: (v) => { s.camera.amount = v; },
        format: (v) => `${Math.round(v * 100)}%`,
      })),
    ));

    this.body.append(section(
      'Транзиенты',
      this.track(toggle({
        label: 'Particle burst', get: () => s.transients.burst, set: (v) => { s.transients.burst = v; },
      })),
      this.track(toggle({
        label: 'Shockwave', get: () => s.transients.shockwave, set: (v) => { s.transients.shockwave = v; },
      })),
      this.track(toggle({
        label: 'Glitch / datamosh', get: () => s.transients.glitch, set: (v) => { s.transients.glitch = v; },
      })),
      this.track(toggle({
        label: 'Screen shake', get: () => s.transients.shake, set: (v) => { s.transients.shake = v; },
      })),
      this.track(toggle({
        label: 'Strobe flash', get: () => s.transients.strobe, set: (v) => { s.transients.strobe = v; },
      })),
      this.track(slider({
        label: 'Интенсивность', min: 0, max: 1, step: 0.01,
        get: () => s.transients.intensity, set: (v) => { s.transients.intensity = v; },
        format: (v) => `${Math.round(v * 100)}%`,
      })),
      this.track(slider({
        label: 'Лимит вспышек', min: 0, max: MAX_SAFE_FLASH_HZ, step: 0.5,
        get: () => s.transients.maxFlashHz,
        set: (v) => { s.transients.maxFlashHz = Math.min(MAX_SAFE_FLASH_HZ, v); },
        format: (v) => (v > 0 ? `${v} Гц` : 'выкл'),
      })),
      note(`Потолок ${MAX_SAFE_FLASH_HZ} Гц не снимается: это защита от фотосенситивной эпилепсии.`),
    ));

    this.body.append(section(
      'Обложка и источники',
      this.track(toggle({
        label: 'Цвет из обложки', get: () => s.cover.useForPalette,
        set: (v) => { s.cover.useForPalette = v; },
      })),
      this.track(toggle({
        label: 'Обложка фоном', get: () => s.cover.useAsBackground,
        set: (v) => { s.cover.useAsBackground = v; },
      })),
      this.track(toggle({
        label: 'Карточка «сейчас играет»', get: () => s.cover.showCard,
        set: (v) => { s.cover.showCard = v; },
      })),
      this.track(toggle({
        label: 'Spotify', get: () => s.sources.spotify, set: (v) => { s.sources.spotify = v; },
      })),
      row(
        button('Подключить Spotify', () => this.handlers.onSpotifyConnect()),
        button('Отключить', () => this.handlers.onSpotifyDisconnect(), 'panel__button--ghost'),
      ),
      note('Client ID заводится в Spotify Developer Dashboard; Redirect URI — адрес этой страницы.'),
      this.track(toggle({
        label: 'YouTube Music (мост)', get: () => s.sources.bridge, set: (v) => { s.sources.bridge = v; },
      })),
      this.track(textField({
        label: 'Адрес моста', placeholder: 'ws://127.0.0.1:8787',
        get: () => s.sources.bridgeUrl, set: (v) => { s.sources.bridgeUrl = v; },
      })),
    ));

    this.body.append(section(
      'Текст песни',
      this.track(toggle({
        label: 'Показывать текст', get: () => s.lyrics.enabled, set: (v) => { s.lyrics.enabled = v; },
      })),
      this.track(slider({
        label: 'Размер шрифта', min: 18, max: 120, step: 1,
        get: () => s.lyrics.fontSize, set: (v) => { s.lyrics.fontSize = v; },
        format: (v) => `${v.toFixed(0)} px`,
      })),
      this.track(select({
        label: 'Позиция',
        options: [{ value: 'bottom', label: 'Внизу' }, { value: 'center', label: 'По центру' }],
        get: () => s.lyrics.position, set: (v) => { s.lyrics.position = v; },
      })),
      this.track(select({
        label: 'Режим',
        options: [{ value: 'karaoke', label: 'Караоке (по словам)' }, { value: 'lines', label: 'Построчно' }],
        get: () => s.lyrics.mode, set: (v) => { s.lyrics.mode = v; },
      })),
      this.track(toggle({
        label: 'Цвет из палитры',
        get: () => s.lyrics.color === 'auto',
        set: (v) => { s.lyrics.color = v ? 'auto' : '#ffffff'; },
      })),
      this.track(colorField('Свой цвет', () => s.lyrics.color, (v) => { s.lyrics.color = v; })),
    ));

    this.body.append(section(
      'Профили',
      row(...PRESET_PROFILES.map((preset) => button(preset.name, () => {
        const next = presetSettings(preset.id);
        if (next) this.handlers.onReplace(next);
      }))),
      this.track(textField({
        label: 'Имя профиля', placeholder: 'Например: Вечер пятницы',
        get: () => this.profileName, set: (v) => { this.profileName = v; },
      })),
      row(button('Сохранить профиль', () => {
        if (!this.profileName.trim()) return;
        saveProfile(this.profileName, this.settings);
        this.renderProfiles();
      })),
      this.profileList,
    ));

    this.body.append(section(
      'Отладка',
      this.track(toggle({
        label: 'Дебаг-оверлей', get: () => s.debug, set: (v) => { s.debug = v; },
      })),
    ));
  }

  private renderProfiles(): void {
    const profiles = listProfiles();
    this.profileList.replaceChildren();
    if (profiles.length === 0) {
      this.profileList.append(note('Сохранённых профилей пока нет.'));
      return;
    }
    for (const profile of profiles) {
      this.profileList.append(row(
        button(profile.name, () => this.handlers.onReplace(structuredClone(profile.settings))),
        button('✕', () => {
          deleteProfile(profile.name);
          this.renderProfiles();
        }, 'panel__button--ghost'),
      ));
    }
  }
}
