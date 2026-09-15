/**
 * Единая структура настроек. Её читают все модули, её же сохраняют профили,
 * её же редактирует панель настроек — больше состояния настроек нигде нет.
 */

import { defaultTuning, type PaletteTuning } from './render/palette.ts';
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
  };
  generator: {
    /** auto — набор примитивов выбирает mood vector; manual — список ниже. */
    mode: 'auto' | 'manual';
    manual: PrimitiveId[];
    /** Множитель скорости морфинга между состояниями, 0.2..3. */
    morphRate: number;
    /** Доля разрешения для raymarch-шейдера, 0.25..1. */
    quality: number;
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
    /** Показывать карточку «сейчас играет». */
    showCard: boolean;
  };
  lyrics: {
    enabled: boolean;
    fontSize: number;
    position: 'bottom' | 'center';
    mode: 'karaoke' | 'lines';
    /** 'auto' — цвет из текущей палитры, иначе CSS-цвет. */
    color: string;
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
    },
    generator: {
      mode: 'auto',
      manual: ['flow-field', 'metaballs'],
      morphRate: 1,
      quality: 0.5,
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
      strobe: true,
      intensity: 0.7,
      maxFlashHz: MAX_SAFE_FLASH_HZ,
    },
    deformation: {
      enabled: true,
      amount: 0.6,
    },
    sources: {
      spotify: false,
      bridge: false,
      bridgeUrl: 'ws://127.0.0.1:8787',
    },
    cover: {
      useForPalette: true,
      useAsBackground: false,
      showCard: true,
    },
    lyrics: {
      enabled: true,
      fontSize: 44,
      position: 'bottom',
      mode: 'karaoke',
      color: 'auto',
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
  mergeSection(base.transients, source.transients);
  mergeSection(base.deformation, source.deformation);
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
  base.transients.maxFlashHz = Math.min(MAX_SAFE_FLASH_HZ, Math.max(0, base.transients.maxFlashHz));
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
