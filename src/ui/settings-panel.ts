/**
 * Панель настроек.
 *
 * Правит тот же объект Settings, который читают анализатор и рендер, — всё
 * применяется со следующего кадра, кнопки «Применить» нет и быть не должно.
 *
 * Панель не лежит поверх картинки: пока она открыта, сцена ужимается влево.
 * Настраивать то, что закрыто настройками, невозможно, а именно так вела себя
 * прошлая версия.
 */

import { HARMONY_SCHEMES } from '../render/palette.ts';
import type { QualityLevel } from '../render/post-pass.ts';
import { PARTICLE_LABELS, PARTICLE_TYPES } from '../render/particles.ts';
import { FONT_CHOICES, type FontMoodKey } from './fonts.ts';
import { LYRICS_ANIMATIONS, type LyricsAnimation } from './lyrics-overlay.ts';
import { ALL_PRIMITIVE_IDS, PRIMITIVE_LABELS, type PrimitiveId } from '../render/primitives/types.ts';
import { PRIMITIVE_PARAMS, type ParamSpec } from '../render/primitives/tuning.ts';
import {
  MAX_SAFE_FLASH_HZ, defaultSettings, type PrimitiveRole, type Settings,
} from '../settings.ts';
import {
  button, collapsible, colorField, note, row, select, slider, textField, toggle,
  type Control, type SectionHandle,
} from './controls.ts';
import {
  activePreset, builtInPresets, deletePreset, exportPresets, importPresets, isModified,
  listPresets, renamePreset, savePreset, setActivePreset,
} from './presets.ts';

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
  particles: string;
  budget: string;
  fonts: string;
}

export interface SettingsPanelHandlers {
  /** Настройки изменились — сохранить и применить. */
  onChange(): void;
  onReshuffle(): void;
  onSpotifyConnect(): void;
  onSpotifyDisconnect(): void;
  /** Полная замена настроек (загрузка пресета). */
  onReplace(settings: Settings): void;
}

/** Умолчания для кнопок сброса: один снимок на всю жизнь панели. */
const DEFAULTS = defaultSettings();

export class SettingsPanel {
  readonly element = document.createElement('aside');
  private readonly body = document.createElement('div');
  private readonly statusBox = document.createElement('dl');
  private readonly presetList = document.createElement('div');
  private readonly presetState = document.createElement('p');
  private readonly searchInput = document.createElement('input');
  private readonly importInput = document.createElement('input');
  /** Контрол и раздел, в котором он лежит: по этой паре работает поиск. */
  private readonly controls: Array<{ control: Control; section: SectionHandle }> = [];
  private readonly sections: SectionHandle[] = [];
  /** Разделы примитивов пересобираются при смене расширенного режима. */
  private readonly primitiveBodies = new Map<PrimitiveId, HTMLElement>();
  private presetName = '';

  constructor(private readonly settings: Settings, private readonly handlers: SettingsPanelHandlers) {
    this.element.className = 'panel panel--hidden';

    const header = document.createElement('header');
    header.className = 'panel__header';
    header.innerHTML = '<h2>Настройки</h2>';
    header.append(button('✕', () => this.close(), 'panel__button--ghost'));

    this.searchInput.type = 'search';
    this.searchInput.className = 'panel__search';
    this.searchInput.placeholder = 'Поиск по настройкам…';
    this.searchInput.addEventListener('input', () => this.applySearch());

    this.importInput.type = 'file';
    this.importInput.accept = 'application/json,.json';
    this.importInput.hidden = true;
    this.importInput.addEventListener('change', () => void this.importFromFile());

    this.body.className = 'panel__body';
    this.statusBox.className = 'panel__status';
    this.presetList.className = 'panel__presets';
    this.presetState.className = 'panel__note panel__note--state';

    this.element.append(header, this.searchInput, this.body, this.importInput);
    this.build();
    this.renderPresets();
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

  /** Перечитать все поля — после загрузки пресета или смены настроек извне. */
  refresh(): void {
    for (const { control } of this.controls) control.sync();
    this.renderPresets();
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
      ['Частицы', status.particles || '—'],
      ['Бюджет', status.budget],
      ['Seed', status.seed],
      ['Источник', status.source],
      ['Spotify', status.spotify],
      ['YT Music', status.bridge],
      ['Текст', status.lyrics],
      ['Гарнитуры', status.fonts],
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

  // --- сборка ---------------------------------------------------------------

  /** Текущий раздел: в него уходят все контролы, созданные через `track`. */
  private current: SectionHandle | null = null;

  private track<T extends Control>(control: T): T {
    // Все контролы сообщают об изменении одинаково — оборачиваем один раз здесь.
    control.element.addEventListener('input', () => this.changed());
    control.element.addEventListener('change', () => this.changed());
    if (this.current) this.controls.push({ control, section: this.current });
    return control;
  }

  private changed(): void {
    this.handlers.onChange();
    this.updatePresetState();
  }

  /**
   * Раздел собирается с отложенным содержимым: `track` должен знать, в какой
   * раздел кладёт контрол, а узнать это можно только после создания раздела.
   */
  private addSection(title: string, fill: () => Array<HTMLElement | Control>): SectionHandle {
    const handle = collapsible(title);
    this.current = handle;
    const content = handle.element.querySelector('.panel__content');
    for (const child of fill()) {
      content?.append('element' in child ? child.element : child);
    }
    this.current = null;
    this.sections.push(handle);
    this.body.append(handle.element);
    return handle;
  }

  private applySearch(): void {
    const query = this.searchInput.value.trim().toLowerCase();
    if (!query) {
      for (const { control } of this.controls) control.element.hidden = false;
      for (const handle of this.sections) handle.setVisible(true);
      return;
    }

    const matched = new Set<SectionHandle>();
    for (const { control, section } of this.controls) {
      const hit = control.searchText.includes(query);
      control.element.hidden = !hit;
      if (hit) matched.add(section);
    }
    for (const handle of this.sections) {
      const hit = matched.has(handle);
      handle.setVisible(hit);
      // Найденное должно быть видно сразу, даже если раздел был свёрнут.
      if (hit) handle.expand();
    }
  }

  private build(): void {
    const s = this.settings;
    const d = DEFAULTS;

    this.addSection('Состояние', () => [this.statusBox]);

    this.addSection('Пресеты', () => [
      this.presetState,
      this.presetList,
      this.track(textField({
        label: 'Имя пресета', placeholder: 'Например: Вечер пятницы',
        get: () => this.presetName, set: (v) => { this.presetName = v; },
      })),
      row(
        button('Сохранить', () => this.saveCurrent(), 'panel__button--accent'),
        button('Как новый', () => this.saveAsNew()),
        button('Сброс', () => this.resetToPreset(), 'panel__button--ghost'),
      ),
      row(
        button('Экспорт JSON', () => this.exportToFile()),
        button('Импорт JSON', () => this.importInput.click()),
      ),
      note('Пресет — полный снимок всех настроек с именем и меткой времени. '
        + 'Хранятся в браузере; экспорт в JSON нужен для бэкапа и переноса на другую машину.'),
    ]);

    this.addSection('Общее', () => [
      this.track(select({
        label: 'Качество',
        options: [
          { value: 'low', label: 'Низкое' },
          { value: 'medium', label: 'Среднее' },
          { value: 'high', label: 'Высокое' },
        ],
        get: () => s.quality.level,
        set: (v: QualityLevel) => { s.quality.level = v; },
        def: d.quality.level,
        hint: 'Меняет разрешение свечения, число проходов размытия и выборки лучей согласованно',
      })),
      this.track(toggle({
        label: 'Автоснижение при просадке',
        get: () => s.quality.auto, set: (v) => { s.quality.auto = v; },
        def: d.quality.auto,
        hint: 'Ручной выбор — это потолок: авто опускает уровень, но не поднимает выше',
      })),
      this.track(slider({
        label: 'Лимит кадров', min: 0, max: 144, step: 1,
        get: () => s.quality.fpsLimit, set: (v) => { s.quality.fpsLimit = v; },
        format: (v) => (v > 0 ? `${v.toFixed(0)} fps` : 'без лимита'),
        def: d.quality.fpsLimit,
      })),
      this.track(slider({
        label: 'Бюджет интенсивности', min: 0, max: 5, step: 0.1,
        get: () => s.motion.budget, set: (v) => { s.motion.budget = v; },
        format: (v) => (v > 0 ? v.toFixed(1) : 'без лимита'),
        def: d.motion.budget,
        hint: 'Потолок суммарной активности: группы конкурируют за него по уместности',
      })),
      this.track(slider({
        label: 'Амплитуда движения', min: 0, max: 1, step: 0.02,
        get: () => s.motion.amount, set: (v) => { s.motion.amount = v; },
        format: percent, def: d.motion.amount,
        hint: 'Гасит камеру, тряску, толчки и деформации разом — ручка против укачивания',
      })),
      ...(['base', 'genre', 'transient'] as const).flatMap((key) => {
        const labels = { base: 'База', genre: 'Жанр', transient: 'Транзиенты' };
        return [
          this.track(toggle({
            label: `Слой: ${labels[key]}`,
            get: () => s.layers[key].enabled, set: (v) => { s.layers[key].enabled = v; },
            def: d.layers[key].enabled,
          })),
          this.track(slider({
            label: `${labels[key]}: вес`, min: 0, max: 1, step: 0.01,
            get: () => s.layers[key].weight, set: (v) => { s.layers[key].weight = v; },
            format: percent, def: d.layers[key].weight,
          })),
        ];
      }),
      this.track(toggle({
        label: 'Расширенный режим',
        get: () => s.advanced,
        set: (v) => { s.advanced = v; this.rebuildPrimitiveParams(); },
        def: d.advanced,
        hint: 'Снимает безопасные границы ползунков. За ними лежат значения, ломающие картинку',
      })),
    ]);

    this.addSection('Фокус', () => [
      note('В кадре ровно одно соло на 60-80% веса, максимум один совместимый акцент и фон. '
        + 'Соло меняется только на границе части — иначе взгляду не за что держаться.'),
      this.track(slider({
        label: 'Соло: минимум', min: 5, max: 120, step: 1,
        get: () => s.focus.soloMinSec, set: (v) => { s.focus.soloMinSec = v; },
        format: seconds, def: d.focus.soloMinSec,
      })),
      this.track(slider({
        label: 'Соло: максимум', min: 5, max: 180, step: 1,
        get: () => s.focus.soloMaxSec, set: (v) => { s.focus.soloMaxSec = v; },
        format: seconds, def: d.focus.soloMaxSec,
      })),
      this.track(slider({
        label: 'Вес акцента', min: 0, max: 0.6, step: 0.01,
        get: () => s.focus.accentWeight, set: (v) => { s.focus.accentWeight = v; },
        format: percent, def: d.focus.accentWeight,
      })),
      this.track(slider({
        label: 'Вес фона', min: 0, max: 0.4, step: 0.01,
        get: () => s.focus.backgroundWeight, set: (v) => { s.focus.backgroundWeight = v; },
        format: percent, def: d.focus.backgroundWeight,
      })),
      this.track(slider({
        label: 'Увод старого соло', min: 200, max: 4000, step: 50,
        get: () => s.focus.exitMs, set: (v) => { s.focus.exitMs = v; },
        format: millis, def: d.focus.exitMs,
      })),
      this.track(slider({
        label: 'Ввод нового соло', min: 200, max: 4000, step: 50,
        get: () => s.focus.enterMs, set: (v) => { s.focus.enterMs = v; },
        format: millis, def: d.focus.enterMs,
        hint: 'Новое входит после того, как старое ушло: одновременный кроссфейд даёт кашу',
      })),
    ]);

    this.addSection('Аудио-анализ', () => [
      this.track(slider({
        label: 'Сглаживание', min: 0, max: 0.95, step: 0.01,
        get: () => s.audio.smoothing, set: (v) => { s.audio.smoothing = v; },
        def: d.audio.smoothing,
      })),
      this.track(slider({
        label: 'Энергия', min: 0.2, max: 3, step: 0.05,
        get: () => s.audio.energyGain, set: (v) => { s.audio.energyGain = v; },
        def: d.audio.energyGain,
      })),
      this.track(slider({
        label: 'Flux', min: 0.2, max: 3, step: 0.05,
        get: () => s.audio.fluxGain, set: (v) => { s.audio.fluxGain = v; },
        def: d.audio.fluxGain,
      })),
      this.track(slider({
        label: 'Яркость тембра', min: 0.2, max: 3, step: 0.05,
        get: () => s.audio.brightnessGain, set: (v) => { s.audio.brightnessGain = v; },
        def: d.audio.brightnessGain,
      })),
      this.track(slider({
        label: 'Шумность (ZCR)', min: 0.2, max: 3, step: 0.05,
        get: () => s.audio.noisinessGain, set: (v) => { s.audio.noisinessGain = v; },
        def: d.audio.noisinessGain,
      })),
      this.track(slider({
        label: 'Порог удара', min: 1.05, max: 3, step: 0.05,
        get: () => s.audio.onsetThreshold, set: (v) => { s.audio.onsetThreshold = v; },
        def: d.audio.onsetThreshold,
      })),
      this.track(slider({
        label: 'BPM вручную', min: 0, max: 200, step: 1,
        get: () => s.audio.bpmOverride ?? 0,
        // 0 — специальное значение «не переопределять».
        set: (v) => { s.audio.bpmOverride = v > 0 ? v : null; },
        format: (v) => (v > 0 ? v.toFixed(0) : 'авто'),
        def: 0,
      })),
    ]);

    this.addSection('Цвет', () => [
      note('Оттенок берётся от тоники по квинтовому кругу, температура — от лада. '
        + 'Схема задаёт, как от этого оттенка строится остальная палитра.'),
      this.track(select({
        label: 'Гармония',
        options: [
          { value: 'auto', label: 'Авто (от seed трека)' },
          ...HARMONY_SCHEMES.map((scheme) => ({ value: scheme.id, label: scheme.name })),
        ],
        get: () => s.palette.harmonyId, set: (v) => { s.palette.harmonyId = v; },
        def: d.palette.harmonyId,
      })),
      this.track(slider({
        label: 'Сдвиг оттенка', min: -180, max: 180, step: 1,
        get: () => s.palette.tuning.hueOffset, set: (v) => { s.palette.tuning.hueOffset = v; },
        format: (v) => `${v.toFixed(0)}°`, def: d.palette.tuning.hueOffset,
      })),
      this.track(slider({
        label: 'Хрома', min: 0, max: 2, step: 0.05,
        get: () => s.palette.tuning.chromaBoost, set: (v) => { s.palette.tuning.chromaBoost = v; },
        format: percent, def: d.palette.tuning.chromaBoost,
      })),
      this.track(slider({
        label: 'Светлота форм', min: 0.5, max: 1.5, step: 0.02,
        get: () => s.palette.tuning.lightnessBoost,
        set: (v) => { s.palette.tuning.lightnessBoost = v; },
        format: percent, def: d.palette.tuning.lightnessBoost,
        hint: 'Светлота — это контраст между фоном и формами, а не общая яркость',
      })),
      this.track(slider({
        label: 'Температура лада', min: 0, max: 1, step: 0.02,
        get: () => s.palette.tuning.temperature, set: (v) => { s.palette.tuning.temperature = v; },
        format: percent, def: d.palette.tuning.temperature,
      })),
      this.track(slider({
        label: 'Якорь обложки', min: 0, max: 1, step: 0.02,
        get: () => s.palette.tuning.coverWeight, set: (v) => { s.palette.tuning.coverWeight = v; },
        format: percent, def: d.palette.tuning.coverWeight,
      })),
      this.track(toggle({
        label: 'Цвет из обложки',
        get: () => s.cover.useForPalette, set: (v) => { s.cover.useForPalette = v; },
        def: d.cover.useForPalette,
      })),
      this.track(toggle({
        label: 'Обложка фоном',
        get: () => s.cover.useAsBackground, set: (v) => { s.cover.useAsBackground = v; },
        def: d.cover.useAsBackground,
      })),
    ]);

    this.addSection('Камера', () => [
      note('Наблюдатель внутри сцены: дрейф, орбита в темпе, наезд на билд-апе и крен.'),
      this.track(toggle({
        label: 'Движение камеры',
        get: () => s.camera.enabled, set: (v) => { s.camera.enabled = v; },
        def: d.camera.enabled,
      })),
      this.track(slider({
        label: 'Амплитуда камеры', min: 0, max: 1, step: 0.02,
        get: () => s.camera.amount, set: (v) => { s.camera.amount = v; },
        format: percent, def: d.camera.amount,
      })),
      this.track(toggle({
        label: 'Монтажные склейки',
        get: () => s.camera.cut, set: (v) => { s.camera.cut = v; },
        def: d.camera.cut,
        hint: 'Резкая смена ракурса на границе части, не чаще раза в 16 секунд',
      })),
    ]);

    this.addSection('Импульсы', () => [
      note('Что сработает на конкретном ударе, решают его сила и частотный профиль: '
        + 'слабый удар даёт только толчок камеры, дроп — почти всё сразу.'),
      ...([
        ['burst', 'Particle burst'],
        ['shockwave', 'Shockwave (бас)'],
        ['ripple', 'Ripple (жидкое вещество)'],
        ['shake', 'Screen shake'],
        ['punchZoom', 'Punch zoom (дроп)'],
        ['lensPulse', 'Lens pulse'],
        ['rollKick', 'Roll kick (снейр)'],
        ['compression', 'Compression (кик)'],
        ['chromaticBurst', 'Chromatic burst'],
        ['slice', 'Slice displacement'],
        ['pressureWave', 'Pressure wave (дроп)'],
        ['strobe', 'Strobe flash'],
      ] as const).map(([key, label]) => this.track(toggle({
        label,
        get: () => s.transients[key], set: (v) => { s.transients[key] = v; },
        def: d.transients[key],
      }))),
      this.track(slider({
        label: 'Интенсивность импульсов', min: 0, max: 1, step: 0.01,
        get: () => s.transients.intensity, set: (v) => { s.transients.intensity = v; },
        format: percent, def: d.transients.intensity,
      })),
      this.track(slider({
        label: 'Лимит вспышек', min: 0, max: MAX_SAFE_FLASH_HZ, step: 0.5,
        get: () => s.transients.maxFlashHz,
        set: (v) => { s.transients.maxFlashHz = Math.min(MAX_SAFE_FLASH_HZ, v); },
        format: (v) => (v > 0 ? `${v} Гц` : 'выкл'),
        def: d.transients.maxFlashHz,
      })),
      note(`Потолок ${MAX_SAFE_FLASH_HZ} Гц не снимается ни расширенным режимом, ни пресетом: `
        + 'это защита от фотосенситивной эпилепсии.'),
    ]);

    this.addSection('Деформации', () => [
      note('Domain warping идёт первым: остальные деформации ложатся уже на искажённое им '
        + 'пространство. Все работают всегда на низком уровне и усиливаются на пиках.'),
      this.track(toggle({
        label: 'Деформации',
        get: () => s.deformation.enabled, set: (v) => { s.deformation.enabled = v; },
        def: d.deformation.enabled,
      })),
      this.track(slider({
        label: 'Общая сила', min: 0, max: 1, step: 0.02,
        get: () => s.deformation.amount, set: (v) => { s.deformation.amount = v; },
        format: percent, def: d.deformation.amount,
      })),
      ...([
        ['domainWarp', 'Domain warp'],
        ['twist', 'Закрутка'],
        ['wave', 'Волна'],
        ['turbulence', 'Турбулентность'],
        ['melt', 'Стекание'],
        ['fold', 'Складка'],
      ] as const).map(([key, label]) => this.track(slider({
        label, min: 0, max: 1, step: 0.02,
        get: () => s.deformation[key], set: (v) => { s.deformation[key] = v; },
        format: percent, def: d.deformation[key],
      }))),
    ]);

    this.addSection('Свет', () => [
      note('Порог свечения адаптивный — он держится выше средней яркости кадра, '
        + 'поэтому светится то, что выделяется, а не картинка целиком.'),
      this.track(slider({
        label: 'Свечение (bloom)', min: 0, max: 1, step: 0.02,
        get: () => s.light.bloom, set: (v) => { s.light.bloom = v; },
        format: percent, def: d.light.bloom,
      })),
      this.track(slider({
        label: 'Сдвиг порога свечения', min: -0.3, max: 0.3, step: 0.01,
        get: () => s.light.bloomBias, set: (v) => { s.light.bloomBias = v; },
        def: d.light.bloomBias,
        hint: 'Плюс — светится только самое яркое, минус — свечения больше',
      })),
      this.track(slider({
        label: 'Объёмные лучи', min: 0, max: 1, step: 0.02,
        get: () => s.light.rays, set: (v) => { s.light.rays = v; },
        format: percent, def: d.light.rays,
      })),
      this.track(slider({
        label: 'Контровой свет', min: 0, max: 1, step: 0.02,
        get: () => s.light.rim, set: (v) => { s.light.rim = v; },
        format: percent, def: d.light.rim,
      })),
      this.track(toggle({
        label: 'Блики на пиках',
        get: () => s.light.flare, set: (v) => { s.light.flare = v; }, def: d.light.flare,
      })),
      this.track(toggle({
        label: 'Дыхание экспозиции',
        get: () => s.light.exposure, set: (v) => { s.light.exposure = v; }, def: d.light.exposure,
      })),
      this.track(toggle({
        label: 'Динамическая виньетка',
        get: () => s.light.vignette, set: (v) => { s.light.vignette = v; }, def: d.light.vignette,
      })),
    ]);

    this.addSection('Память', () => [
      note('Обратная связь подмешивает прошлый кадр в текущий со сдвигом, масштабом и '
        + 'поворотом — отсюда туннели и спирали. Доля жёстко ограничена, чтобы кадр не '
        + 'ушёл в самовозбуждение.'),
      this.track(slider({
        label: 'Следы', min: 0, max: 1, step: 0.02,
        get: () => s.memory.trails, set: (v) => { s.memory.trails = v; },
        format: percent, def: d.memory.trails,
      })),
      this.track(slider({
        label: 'Обратная связь', min: 0, max: 1, step: 0.02,
        get: () => s.memory.feedback, set: (v) => { s.memory.feedback = v; },
        format: percent, def: d.memory.feedback,
      })),
      this.track(slider({
        label: 'Ритмическое эхо', min: 0, max: 1, step: 0.02,
        get: () => s.memory.echo, set: (v) => { s.memory.echo = v; },
        format: percent, def: d.memory.echo,
        hint: 'Повтор кадра на 1/2, 1/4 или пунктирную 3/8 доли',
      })),
      this.track(slider({
        label: 'Размазывание на дропе', min: 0, max: 1, step: 0.02,
        get: () => s.memory.smear, set: (v) => { s.memory.smear = v; },
        format: percent, def: d.memory.smear,
      })),
      this.track(toggle({
        label: 'Призраки ударов',
        get: () => s.memory.ghosts, set: (v) => { s.memory.ghosts = v; }, def: d.memory.ghosts,
      })),
    ]);

    this.buildPrimitives();

    this.addSection('Частицы', () => [
      note('Все типы несёт то же поле потока, что и линии фона — поэтому они часть '
        + 'сцены, а не слой поверх неё.'),
      this.track(toggle({
        label: 'Частицы',
        get: () => s.particles.enabled, set: (v) => { s.particles.enabled = v; },
        def: d.particles.enabled,
      })),
      this.track(select({
        label: 'Набор типов',
        options: [
          { value: 'auto', label: 'Авто (по настроению)' },
          { value: 'manual', label: 'Вручную' },
        ],
        get: () => s.particles.mode, set: (v) => { s.particles.mode = v; },
        def: d.particles.mode,
      })),
      ...PARTICLE_TYPES.map((type) => this.track(toggle({
        label: PARTICLE_LABELS[type],
        get: () => s.particles.manual.includes(type),
        set: (v) => {
          const set = new Set(s.particles.manual);
          if (v) set.add(type);
          else set.delete(type);
          s.particles.manual = [...set];
        },
      }))),
      this.track(slider({
        label: 'Плотность частиц', min: 0, max: 1, step: 0.02,
        get: () => s.particles.density, set: (v) => { s.particles.density = v; },
        format: percent, def: d.particles.density,
      })),
      this.track(slider({
        label: 'Время жизни', min: 0.2, max: 3, step: 0.05,
        get: () => s.particles.life, set: (v) => { s.particles.life = v; },
        format: multiplier, def: d.particles.life,
      })),
      this.track(slider({
        label: 'Скорость частиц', min: 0.2, max: 3, step: 0.05,
        get: () => s.particles.speed, set: (v) => { s.particles.speed = v; },
        format: multiplier, def: d.particles.speed,
      })),
      this.track(slider({
        label: 'Размер частиц', min: 0.2, max: 3, step: 0.05,
        get: () => s.particles.size, set: (v) => { s.particles.size = v; },
        format: multiplier, def: d.particles.size,
      })),
    ]);

    this.addSection('Текст песни', () => [
      this.track(toggle({
        label: 'Показывать текст',
        get: () => s.lyrics.enabled, set: (v) => { s.lyrics.enabled = v; }, def: d.lyrics.enabled,
      })),
      this.track(slider({
        label: 'Размер шрифта', min: 18, max: 120, step: 1,
        get: () => s.lyrics.fontSize, set: (v) => { s.lyrics.fontSize = v; },
        format: (v) => `${v.toFixed(0)} px`, def: d.lyrics.fontSize,
      })),
      this.track(select({
        label: 'Позиция текста',
        options: [
          { value: 'bottom', label: 'Внизу' },
          { value: 'center', label: 'По центру' },
          { value: 'top', label: 'Вверху' },
        ],
        get: () => s.lyrics.position, set: (v) => { s.lyrics.position = v; },
        def: d.lyrics.position,
      })),
      this.track(select({
        label: 'Режим текста',
        options: [
          { value: 'karaoke', label: 'Караоке (по словам)' },
          { value: 'lines', label: 'Построчно' },
        ],
        get: () => s.lyrics.mode, set: (v) => { s.lyrics.mode = v; }, def: d.lyrics.mode,
      })),
      this.track(select({
        label: 'Гарнитура',
        options: [
          { value: 'auto', label: 'Авто (по характеру трека)' },
          ...FONT_CHOICES.map((font) => ({ value: font.id, label: `${font.name} — ${font.description}` })),
        ],
        get: () => s.lyrics.font, set: (v: 'auto' | FontMoodKey) => { s.lyrics.font = v; },
        def: d.lyrics.font,
        hint: 'Все гарнитуры проверяются на кириллицу прямо в браузере: треки бывают русскими',
      })),
      this.track(select({
        label: 'Появление строки',
        options: LYRICS_ANIMATIONS,
        get: () => s.lyrics.animation, set: (v: LyricsAnimation) => { s.lyrics.animation = v; },
        def: d.lyrics.animation,
      })),
      this.track(select({
        label: 'Читаемость',
        options: [
          { value: 'auto', label: 'Обычная подложка' },
          { value: 'max', label: 'Максимальная (плотная)' },
        ],
        get: () => s.lyrics.readability, set: (v: 'auto' | 'max') => { s.lyrics.readability = v; },
        def: d.lyrics.readability,
      })),
      this.track(toggle({
        label: 'Реакция текста на музыку',
        get: () => s.lyrics.reactive, set: (v) => { s.lyrics.reactive = v; }, def: d.lyrics.reactive,
        hint: 'Ведёт вес шрифта энергией и расширяет трекинг на пиках; нужен variable font',
      })),
      this.track(toggle({
        label: 'Цвет текста из палитры',
        get: () => s.lyrics.color === 'auto',
        set: (v) => { s.lyrics.color = v ? 'auto' : '#ffffff'; },
        def: true,
      })),
      this.track(colorField('Свой цвет текста', () => s.lyrics.color, (v) => { s.lyrics.color = v; })),
    ]);

    this.addSection('Карточка трека', () => [
      this.track(select({
        label: 'Показывать карточку',
        options: [
          { value: 'on-change', label: 'При смене трека' },
          { value: 'always', label: 'Всегда мелко в углу' },
          { value: 'never', label: 'Никогда' },
        ],
        get: () => s.cover.card, set: (v: 'on-change' | 'always' | 'never') => { s.cover.card = v; },
        def: d.cover.card,
      })),
      this.track(select({
        label: 'Угол карточки',
        options: [
          { value: 'top-left', label: 'Сверху слева' },
          { value: 'top-right', label: 'Сверху справа' },
          { value: 'bottom-left', label: 'Снизу слева' },
          { value: 'bottom-right', label: 'Снизу справа' },
        ],
        get: () => s.cover.cardCorner,
        set: (v: Settings['cover']['cardCorner']) => { s.cover.cardCorner = v; },
        def: d.cover.cardCorner,
      })),
      this.track(slider({
        label: 'Держать карточку', min: 2, max: 30, step: 1,
        get: () => s.cover.cardHoldSec, set: (v) => { s.cover.cardHoldSec = v; },
        format: seconds, def: d.cover.cardHoldSec,
      })),
      this.track(toggle({
        label: 'Линия прогресса трека',
        get: () => s.cover.progressLine, set: (v) => { s.cover.progressLine = v; },
        def: d.cover.progressLine,
      })),
      note('Если текст песни внизу, карточка сама уходит наверх.'),
    ]);

    this.addSection('Источники', () => [
      this.track(toggle({
        label: 'Spotify', get: () => s.sources.spotify, set: (v) => { s.sources.spotify = v; },
        def: d.sources.spotify,
      })),
      row(
        button('Подключить Spotify', () => this.handlers.onSpotifyConnect()),
        button('Отключить', () => this.handlers.onSpotifyDisconnect(), 'panel__button--ghost'),
      ),
      note('Client ID заводится в Spotify Developer Dashboard; Redirect URI — адрес этой страницы.'),
      this.track(toggle({
        label: 'YouTube Music (мост)',
        get: () => s.sources.bridge, set: (v) => { s.sources.bridge = v; }, def: d.sources.bridge,
      })),
      this.track(textField({
        label: 'Адрес моста', placeholder: 'ws://127.0.0.1:8787',
        get: () => s.sources.bridgeUrl, set: (v) => { s.sources.bridgeUrl = v; },
      })),
    ]);

    this.addSection('Отладка', () => [
      this.track(toggle({
        label: 'Дебаг-оверлей', get: () => s.debug, set: (v) => { s.debug = v; }, def: d.debug,
      })),
      this.track(select({
        label: 'Соло-режим примитива',
        options: [
          { value: '', label: 'Выключен' },
          ...ALL_PRIMITIVE_IDS.map((id) => ({ value: id, label: PRIMITIVE_LABELS[id] })),
        ],
        get: () => s.generator.solo ?? '',
        set: (v) => { s.generator.solo = v === '' ? null : (v as PrimitiveId); },
        def: '',
        hint: 'Один примитив на экране, остальные выключены — для подбора его параметров',
      })),
      this.track(select({
        label: 'Набор примитивов',
        options: [
          { value: 'auto', label: 'Авто (система фокуса)' },
          { value: 'manual', label: 'Вручную (список ниже)' },
        ],
        get: () => s.generator.mode, set: (v) => { s.generator.mode = v; },
        def: d.generator.mode,
      })),
      ...ALL_PRIMITIVE_IDS.map((id) => this.track(toggle({
        label: `Вручную: ${PRIMITIVE_LABELS[id]}`,
        get: () => s.generator.manual.includes(id),
        set: (v) => {
          const set = new Set(s.generator.manual);
          if (v) set.add(id);
          else set.delete(id);
          s.generator.manual = [...set];
        },
      }))),
      this.track(slider({
        label: 'Скорость морфинга', min: 0.2, max: 3, step: 0.05,
        get: () => s.generator.morphRate, set: (v) => { s.generator.morphRate = v; },
        def: d.generator.morphRate,
      })),
      this.track(toggle({
        label: 'Фиксировать seed',
        get: () => s.generator.lockSeed, set: (v) => { s.generator.lockSeed = v; },
        def: d.generator.lockSeed,
        hint: 'Смена трека не меняет пул примитивов, симметрию и сдвиг палитры — '
          + 'иначе при подборе параметров меняется всё сразу',
      })),
      row(button('Reshuffle', () => this.handlers.onReshuffle(), 'panel__button--accent')),
      note('Reshuffle даёт тому же треку новую стартовую точку генератора.'),
    ]);
  }

  /** Раздел «Примитивы»: у каждого примитива свой подраздел со своими параметрами. */
  private buildPrimitives(): void {
    const s = this.settings;
    const d = DEFAULTS;

    for (const id of ALL_PRIMITIVE_IDS) {
      this.addSection(`Примитив: ${PRIMITIVE_LABELS[id]}`, () => {
        const paramsBox = document.createElement('div');
        paramsBox.className = 'panel__params';
        this.primitiveBodies.set(id, paramsBox);

        const solo = button('Соло', () => {
          // Повторный клик снимает соло: иначе из режима не выйти.
          s.generator.solo = s.generator.solo === id ? null : id;
          this.refresh();
          this.changed();
        }, 'panel__button--accent');

        return [
          row(solo),
          this.track(toggle({
            label: `${PRIMITIVE_LABELS[id]}: включён`,
            get: () => s.primitives[id].enabled,
            set: (v) => { s.primitives[id].enabled = v; },
            def: d.primitives[id].enabled,
          })),
          this.track(select({
            label: `${PRIMITIVE_LABELS[id]}: роль`,
            options: [
              { value: 'auto', label: 'Авто (система фокуса)' },
              { value: 'solo', label: 'Соло' },
              { value: 'accent', label: 'Акцент' },
              { value: 'background', label: 'Фон' },
            ],
            get: () => s.primitives[id].role,
            set: (v: PrimitiveRole) => { s.primitives[id].role = v; },
            def: d.primitives[id].role,
          })),
          paramsBox,
        ];
      });
      this.fillPrimitiveParams(id);
    }
  }

  private fillPrimitiveParams(id: PrimitiveId): void {
    const box = this.primitiveBodies.get(id);
    const section = this.sections[this.sections.length - 1];
    if (!box || !section) return;

    box.replaceChildren();
    // Контролы этого раздела пересобираются — старые из списка поиска убираем.
    for (let i = this.controls.length - 1; i >= 0; i--) {
      if (box.contains(this.controls[i].control.element)) this.controls.splice(i, 1);
    }

    const owner = this.sections.find((handle) => handle.element.contains(box)) ?? section;
    this.current = owner;
    for (const spec of PRIMITIVE_PARAMS[id]) {
      box.append(this.track(paramControl(this.settings, id, spec)).element);
    }
    this.current = null;
  }

  /** Расширенный режим меняет границы ползунков — значит, их надо пересобрать. */
  private rebuildPrimitiveParams(): void {
    for (const id of ALL_PRIMITIVE_IDS) this.fillPrimitiveParams(id);
    this.applySearch();
  }

  // --- пресеты --------------------------------------------------------------

  private saveCurrent(): void {
    const name = this.presetName.trim() || activePreset();
    if (!name) return;
    savePreset(name, this.settings);
    this.renderPresets();
  }

  private saveAsNew(): void {
    const name = this.presetName.trim();
    if (!name) return;
    savePreset(name, this.settings);
    this.presetName = '';
    this.refresh();
  }

  /** «Вернуть»: откатить правки к тому, что записано в активном пресете. */
  private resetToPreset(): void {
    const name = activePreset();
    const preset = [...builtInPresets(), ...listPresets()].find((entry) => entry.name === name);
    if (!preset) return;
    this.handlers.onReplace(structuredClone(preset.settings));
    setActivePreset(preset.name);
    this.renderPresets();
  }

  private exportToFile(): void {
    const presets = listPresets();
    if (presets.length === 0) {
      // Экспортировать пустоту незачем — но текущее состояние выгрузить полезно.
      presets.push({ name: activePreset() ?? 'Текущие настройки', settings: this.settings, savedAt: Date.now() });
    }
    const blob = new Blob([exportPresets(presets)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `soundvision-presets-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  private async importFromFile(): Promise<void> {
    const file = this.importInput.files?.[0];
    this.importInput.value = '';
    if (!file) return;

    const result = importPresets(await file.text());
    this.renderPresets();
    this.presetState.textContent = result.error
      ? `Импорт не удался: ${result.error}`
      : `Импортировано: ${result.added.join(', ')}`;
  }

  private renderPresets(): void {
    const active = activePreset();
    this.presetList.replaceChildren();

    for (const preset of builtInPresets()) {
      this.presetList.append(this.presetRow(preset.name, preset.settings, active, true));
    }
    const user = listPresets();
    if (user.length === 0) {
      this.presetList.append(note('Своих пресетов пока нет. Введите имя и нажмите «Как новый».'));
    }
    for (const preset of user) {
      this.presetList.append(this.presetRow(preset.name, preset.settings, active, false));
    }
    this.updatePresetState();
  }

  private presetRow(
    name: string,
    settings: Settings,
    active: string | null,
    builtIn: boolean,
  ): HTMLElement {
    const load = button(name, () => {
      this.handlers.onReplace(structuredClone(settings));
      setActivePreset(name);
      this.renderPresets();
    }, name === active ? 'panel__button--accent' : '');

    if (builtIn) return row(load);

    return row(
      load,
      button('✎', () => {
        const next = window.prompt('Новое имя пресета', name);
        if (next) renamePreset(name, next);
        this.renderPresets();
      }, 'panel__button--ghost'),
      button('✕', () => {
        deletePreset(name);
        this.renderPresets();
      }, 'panel__button--ghost'),
    );
  }

  private updatePresetState(): void {
    const active = activePreset();
    if (!active) {
      this.presetState.textContent = 'Пресет не выбран — правки никуда не записываются.';
      this.presetState.classList.remove('panel__note--modified');
      return;
    }
    const modified = isModified(this.settings);
    this.presetState.textContent = modified
      ? `«${active}» — изменено. «Сброс» вернёт записанное, «Сохранить» перезапишет.`
      : `«${active}» — без изменений.`;
    this.presetState.classList.toggle('panel__note--modified', modified);
  }
}

/** Один параметр примитива: диапазон берётся расширенный, если включён режим. */
function paramControl(settings: Settings, id: PrimitiveId, spec: ParamSpec): Control {
  const [min, max] = settings.advanced && spec.wide ? spec.wide : [spec.min, spec.max];
  const format = spec.format === 'percent' ? percent
    : spec.format === 'multiplier' ? multiplier
      : (value: number) => (Number.isInteger(spec.step) ? value.toFixed(0) : value.toFixed(2));

  return slider({
    label: spec.label,
    min,
    max,
    step: spec.step,
    get: () => settings.primitives[id].params[spec.key] ?? spec.def,
    set: (v) => { settings.primitives[id].params[spec.key] = v; },
    format,
    def: spec.def,
    hint: spec.hint,
  });
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function multiplier(value: number): string {
  return `${value.toFixed(2)}×`;
}

function seconds(value: number): string {
  return `${value.toFixed(0)} с`;
}

function millis(value: number): string {
  return `${value.toFixed(0)} мс`;
}
