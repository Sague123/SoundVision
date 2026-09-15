/**
 * Единая структура настроек. Её читают все модули, её же сохраняют профили,
 * её же редактирует панель настроек — больше состояния настроек нигде нет.
 */

import { defaultTuning, type PaletteTuning } from './render/palette.ts';
import { QUALITY_ORDER, type QualityLevel } from './render/post-pass.ts';
import type { FontMoodKey } from './ui/fonts.ts';
import type { LyricsAnimation } from './ui/lyrics-overlay.ts';
import { PARTICLE_TYPES, type ParticleType } from './render/particles.ts';
import { ALL_PRIMITIVE_IDS, type PrimitiveId } from './render/primitives/types.ts';

export interface LayerSettings {
  enabled: boolean;
  /** Вес слоя в сведении, 0..1. */
  weight: number;
}

export interface Settings {
  audio: {
    smoothing: number;
    energyGain: number;
    fluxGain: number;
    brightnessGain: number;
    noisinessGain: number;
    onsetThreshold: number;
    /** BPM вручную; null — доверяем трекеру. */
    bpmOverride: number | null;
  };
  layers: {
    base: LayerSettings;
    genre: LayerSettings;
    transient: LayerSettings;
  };
  camera: {
    /** Дрейф, орбита, наезд и крен наблюдателя внутри сцены. */
    enabled: boolean;
    /** Общая амплитуда движения камеры, 0..1. */
    amount: number;
    /**
     * Монтажные склейки на границах частей. Не чаще раза в 16 секунд —
     * иначе от резких смен ракурса укачивает.
     */
    cut: boolean;
  };
  generator: {
    /** auto — набор примитивов выбирает mood vector; manual — список ниже. */
    mode: 'auto' | 'manual';
    manual: PrimitiveId[];
    /** Множитель скорости морфинга между состояниями, 0.2..3. */
    morphRate: number;
  };
  motion: {
    /**
     * Общий множитель амплитуды движения: камера, тряска, толчки, деформации.
     * Камера вместе с деформациями и тряской на полной амплитуде укачивает —
     * эта ручка гасит всё разом.
     */
    amount: number;
    /**
     * Потолок суммарной активности эффектов. Группы конкурируют за него по
     * уместности, иначе всё работающее на полную сразу даёт кашу. 0 — снять.
     */
    budget: number;
  };
  quality: {
    /**
     * Уровень качества всей пост-цепочки. Каждый проход стоит кадров, поэтому
     * уровень меняет их согласованно, а не какой-то один параметр.
     */
    level: QualityLevel;
    /** Автоснижение при устойчивой просадке fps. */
    auto: boolean;
  };
  palette: {
    /** Гармоническая схема; 'auto' — её выбирает seed трека. */
    harmonyId: string;
    tuning: PaletteTuning;
  };
  transients: {
    // Импакт-эффекты. Что именно сработает на конкретном ударе, решают его
    // сила и частотный профиль — здесь только разрешение на каждый эффект.
    /** Разлёт частиц из точки удара. */
    burst: boolean;
    /** Расширяющееся кольцо с радиальным искажением; бас-удар. */
    shockwave: boolean;
    /** Водная рябь из нескольких затухающих колец; средний удар на жидком веществе. */
    ripple: boolean;
    /** Толчок камеры; направление — от частотного профиля. */
    shake: boolean;
    /** Резкий наезд с упругим возвратом; дроп. */
    punchZoom: boolean;
    /** Кратковременная бочка или подушка; сильный удар. */
    lensPulse: boolean;
    /** Резкий крен с возвратом; снейр. */
    rollKick: boolean;
    /** Сжатие сцены по вертикали; кик. */
    compression: boolean;
    /** Разлёт RGB-каналов от центра; пик flux. */
    chromaticBurst: boolean;
    /** Сдвиг горизонтальных блоков; резкий flux. */
    slice: boolean;
    /** Волна давления, расталкивающая частицы; дроп. */
    pressureWave: boolean;
    /** Полноэкранная вспышка. */
    strobe: boolean;
    /** Общая интенсивность модификаторов, 0..1. */
    intensity: number;
    /** Safety-лимит вспышек. Выше 3 Гц поднимать не стоит: фотосенситивная эпилепсия. */
    maxFlashHz: number;
  };
  deformation: {
    /** Постоянные деформации вещества: domain warp, twist, wave, melt, fold. */
    enabled: boolean;
    /** Общий множитель, 0..1. */
    amount: number;
  };
  particles: {
    enabled: boolean;
    /** auto — набор типов выбирает рейтинг уместности; manual — список ниже. */
    mode: 'auto' | 'manual';
    manual: ParticleType[];
    /** Общая плотность, 0..1. */
    density: number;
  };
  light: {
    /** Сила свечения ярких мест, 0..1. Порог адаптивный, кадр не выжигается. */
    bloom: number;
    /** Объёмные лучи от источника, 0..1. */
    rays: number;
    /** Контровой свет по силуэтам, 0..1. */
    rim: number;
    /** Блики на пиковых ударах. */
    flare: boolean;
    /** Дыхание экспозиции на долю. Это не строб: амплитуда мала и лимит не нужен. */
    exposure: boolean;
    /** Динамическая виньетка: поджимается на билд-апе, раскрывается на дропе. */
    vignette: boolean;
  };
  memory: {
    /**
     * Обратная связь кадра: прошлый кадр подмешивается в текущий со сдвигом,
     * масштабом и поворотом. Отсюда бесконечные туннели и спирали.
     */
    feedback: number;
    /** Временное размазывание на дропе. */
    smear: number;
    /** Призраки прошлых ударов. */
    ghosts: boolean;
  };
  sources: {
    /** Опрашивать Spotify (нужен Client ID и разовая авторизация). */
    spotify: boolean;
    /** Слушать локальный мост расширения YouTube Music. */
    bridge: boolean;
    bridgeUrl: string;
  };
  cover: {
    /** Использовать обложку как источник цвета. */
    useForPalette: boolean;
    /** Показывать обложку фоном. */
    useAsBackground: boolean;
    /**
     * Режим карточки «сейчас играет»: показать на смену трека и убрать,
     * держать всегда мелко в углу, или не показывать вовсе.
     */
    card: 'on-change' | 'always' | 'never';
    /** Тонкая линия прогресса трека по нижней кромке экрана. */
    progressLine: boolean;
  };
  lyrics: {
    enabled: boolean;
    fontSize: number;
    position: 'bottom' | 'center' | 'top';
    mode: 'karaoke' | 'lines';
    /** 'auto' — цвет из текущей палитры с проверкой контраста, иначе CSS-цвет. */
    color: string;
    /** 'auto' — гарнитура выбирается по характеру трека. */
    font: 'auto' | FontMoodKey;
    /** Схема появления строки. */
    animation: LyricsAnimation;
    /**
     * 'max' — плотная подложка для тех, кто реально подпевает;
     * 'auto' — лёгкая, чтобы не перекрывать картинку.
     */
    readability: 'auto' | 'max';
    /** Вести вес шрифта и трекинг за музыкой. */
    reactive: boolean;
  };
  debug: boolean;
}

export const MAX_SAFE_FLASH_HZ = 3;

export function defaultSettings(): Settings {
  return {
    audio: {
      smoothing: 0.72,
      energyGain: 1,
      fluxGain: 1,
      brightnessGain: 1,
      noisinessGain: 1,
      onsetThreshold: 1.45,
      bpmOverride: null,
    },
    layers: {
      base: { enabled: true, weight: 0.9 },
      genre: { enabled: true, weight: 1 },
      transient: { enabled: true, weight: 0.85 },
    },
    camera: {
      enabled: true,
      amount: 0.7,
      cut: true,
    },
    generator: {
      mode: 'auto',
      manual: ['flow-field', 'metaballs'],
      morphRate: 1,
    },
    motion: {
      amount: 1,
      budget: 2.4,
    },
    quality: {
      level: 'medium',
      auto: true,
    },
    palette: {
      harmonyId: 'auto',
      tuning: defaultTuning(),
    },
    transients: {
      burst: true,
      shockwave: true,
      ripple: true,
      shake: true,
      punchZoom: true,
      lensPulse: true,
      rollKick: true,
      compression: true,
      chromaticBurst: true,
      slice: true,
      pressureWave: true,
      // Строб выключен по умолчанию намеренно: он самый агрессивный из всего набора.
      strobe: false,
      intensity: 0.7,
      maxFlashHz: MAX_SAFE_FLASH_HZ,
    },
    deformation: {
      enabled: true,
      amount: 0.6,
    },
    particles: {
      enabled: true,
      mode: 'auto',
      manual: ['sparks', 'dust'],
      density: 0.6,
    },
    light: {
      bloom: 0.42,
      // Лучи и контровой свет заметно тише прежнего: оба размазывают свет по
      // большой площади, а кадр должен оставаться в основном тёмным.
      rays: 0.12,
      rim: 0.18,
      flare: true,
      exposure: true,
      vignette: true,
    },
    memory: {
      feedback: 0.28,
      smear: 0.45,
      ghosts: true,
    },
    sources: {
      spotify: false,
      bridge: false,
      bridgeUrl: 'ws://127.0.0.1:8787',
    },
    cover: {
      useForPalette: true,
      useAsBackground: false,
      card: 'on-change',
      progressLine: true,
    },
    lyrics: {
      enabled: true,
      fontSize: 44,
      position: 'bottom',
      mode: 'karaoke',
      color: 'auto',
      font: 'auto',
      animation: 'auto',
      readability: 'auto',
      reactive: true,
    },
    debug: false,
  };
}

/**
 * Стартовые шаблоны из плана. Каждый — частичное переопределение поверх
 * дефолтов, чтобы добавление новых полей не ломало старые шаблоны.
 */
export const PRESET_PROFILES: Array<{ id: string; name: string; apply: (settings: Settings) => void }> = [
  {
    id: 'rock-night',
    name: 'Рок-вечер',
    apply: (s) => {
      s.audio.onsetThreshold = 1.3;
      s.audio.smoothing = 0.6;
      s.palette.harmonyId = 'split-complementary';
      s.palette.tuning.chromaBoost = 1.15;
      s.generator.mode = 'auto';
      s.transients.intensity = 0.85;
      s.transients.shake = true;
      s.transients.slice = false;
      s.transients.chromaticBurst = false;
      s.deformation.amount = 0.45;
    },
  },
  {
    id: 'electronic',
    name: 'Электроника',
    apply: (s) => {
      s.audio.onsetThreshold = 1.55;
      s.audio.smoothing = 0.68;
      s.palette.harmonyId = 'complementary';
      s.palette.tuning.chromaBoost = 1.35;
      s.generator.morphRate = 1.4;
      s.transients.intensity = 1;
      s.transients.slice = true;
      s.transients.chromaticBurst = true;
      s.deformation.amount = 0.85;
      s.memory.feedback = 0.75;
      s.light.bloom = 0.7;
      s.light.rays = 0.5;
    },
  },
  {
    id: 'calm-camera',
    name: 'Спокойная камера',
    apply: (s) => {
      // Ровно про укачивание: движение и деформации приглушены, всё остальное
      // остаётся как есть.
      s.motion.amount = 0.35;
      s.motion.budget = 1.6;
      s.camera.amount = 0.4;
      s.camera.cut = false;
      s.deformation.amount = 0.3;
      s.transients.shake = false;
      s.transients.punchZoom = false;
      s.memory.smear = 0.2;
    },
  },
  {
    id: 'calm-background',
    name: 'Спокойный фон',
    apply: (s) => {
      s.audio.smoothing = 0.88;
      s.audio.onsetThreshold = 1.8;
      s.palette.harmonyId = 'analogous';
      s.palette.tuning.chromaBoost = 0.7;
      s.generator.morphRate = 0.5;
      s.layers.transient.weight = 0.3;
      s.camera.amount = 0.4;
      s.transients.intensity = 0.25;
      s.transients.strobe = false;
      s.transients.shake = false;
      s.transients.punchZoom = false;
      s.transients.slice = false;
      s.transients.chromaticBurst = false;
      s.deformation.amount = 0.35;
      s.memory.feedback = 0.3;
      s.memory.smear = 0.2;
      s.light.bloom = 0.4;
      s.light.rays = 0.2;
      s.light.flare = false;
    },
  },
];

/**
 * Слияние сохранённого профиля с дефолтами: профиль из прошлой версии не должен
 * ронять приложение из-за отсутствующего поля.
 */
export function mergeSettings(saved: unknown): Settings {
  const base = defaultSettings();
  if (!saved || typeof saved !== 'object') return base;
  const source = saved as Record<string, unknown>;

  mergeSection(base.audio, source.audio);
  mergeSection(base.camera, source.camera);
  mergeSection(base.generator, source.generator);
  mergeSection(base.motion, source.motion);
  mergeSection(base.quality, source.quality);
  mergeSection(base.transients, source.transients);
  mergeSection(base.deformation, source.deformation);
  mergeSection(base.particles, source.particles);
  mergeSection(base.light, source.light);
  mergeSection(base.memory, source.memory);
  mergeSection(base.sources, source.sources);
  mergeSection(base.cover, source.cover);
  mergeSection(base.lyrics, source.lyrics);
  mergeSection(base.palette, source.palette, ['tuning']);
  if (isRecord(source.palette)) mergeSection(base.palette.tuning, source.palette.tuning);
  if (isRecord(source.layers)) {
    for (const key of ['base', 'genre', 'transient'] as const) {
      mergeSection(base.layers[key], source.layers[key]);
    }
  }
  if (typeof source.debug === 'boolean') base.debug = source.debug;

  base.generator.manual = base.generator.manual.filter((id) => ALL_PRIMITIVE_IDS.includes(id));
  if (base.generator.manual.length === 0) base.generator.manual = ['flow-field'];
  base.particles.manual = base.particles.manual.filter((id) => PARTICLE_TYPES.includes(id));
  if (base.particles.manual.length === 0) base.particles.manual = ['dust'];
  base.transients.maxFlashHz = Math.min(MAX_SAFE_FLASH_HZ, Math.max(0, base.transients.maxFlashHz));
  if (!QUALITY_ORDER.includes(base.quality.level)) base.quality.level = 'medium';
  return base;
}

function mergeSection<T extends object>(target: T, source: unknown, skip: string[] = []): void {
  if (!isRecord(source)) return;
  for (const key of Object.keys(target) as Array<keyof T & string>) {
    if (skip.includes(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    const current = target[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      (target[key] as unknown) = value;
    } else if (typeof current === typeof value || current === null) {
      (target[key] as unknown) = value;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
