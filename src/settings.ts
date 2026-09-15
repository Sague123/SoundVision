/**
 * Единая структура настроек. Её читают все модули, её же сохраняют профили,
 * её же редактирует панель настроек — больше состояния настроек нигде нет.
 */

import type { PaletteSpec } from './render/palette.ts';
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
    schemeId: string;
    useCustom: boolean;
    custom: { major: PaletteSpec; minor: PaletteSpec };
  };
  transients: {
    burst: boolean;
    shockwave: boolean;
    glitch: boolean;
    shake: boolean;
    strobe: boolean;
    /** Общая интенсивность модификаторов, 0..1. */
    intensity: number;
    /** Safety-лимит вспышек. Выше 3 Гц поднимать не стоит: фотосенситивная эпилепсия. */
    maxFlashHz: number;
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
    generator: {
      mode: 'auto',
      manual: ['flow-field', 'metaballs'],
      morphRate: 1,
      quality: 0.5,
    },
    palette: {
      schemeId: 'aurora',
      useCustom: false,
      custom: {
        major: { hue: 150, spread: 80, saturation: 74, lightness: 58 },
        minor: { hue: 250, spread: 70, saturation: 60, lightness: 44 },
      },
    },
    transients: {
      burst: true,
      shockwave: true,
      glitch: true,
      shake: true,
      strobe: true,
      intensity: 0.7,
      maxFlashHz: MAX_SAFE_FLASH_HZ,
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
      s.palette.schemeId = 'ember';
      s.generator.mode = 'auto';
      s.transients.intensity = 0.85;
      s.transients.shake = true;
      s.transients.glitch = false;
    },
  },
  {
    id: 'electronic',
    name: 'Электроника',
    apply: (s) => {
      s.audio.onsetThreshold = 1.55;
      s.audio.smoothing = 0.68;
      s.palette.schemeId = 'neon';
      s.generator.morphRate = 1.4;
      s.transients.intensity = 1;
      s.transients.glitch = true;
    },
  },
  {
    id: 'calm-background',
    name: 'Спокойный фон',
    apply: (s) => {
      s.audio.smoothing = 0.88;
      s.audio.onsetThreshold = 1.8;
      s.palette.schemeId = 'tide';
      s.generator.morphRate = 0.5;
      s.layers.transient.weight = 0.3;
      s.transients.intensity = 0.25;
      s.transients.strobe = false;
      s.transients.shake = false;
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
  mergeSection(base.generator, source.generator);
  mergeSection(base.transients, source.transients);
  mergeSection(base.sources, source.sources);
  mergeSection(base.cover, source.cover);
  mergeSection(base.lyrics, source.lyrics);
  mergeSection(base.palette, source.palette, ['custom']);
  if (isRecord(source.palette) && isRecord(source.palette.custom)) {
    mergeSection(base.palette.custom.major, source.palette.custom.major);
    mergeSection(base.palette.custom.minor, source.palette.custom.minor);
  }
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
