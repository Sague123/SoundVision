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
import {
  defaultPrimitiveParams, resolvePrimitiveParams,
} from './render/primitives/tuning.ts';

export interface LayerSettings {
  enabled: boolean;
  /** Вес слоя в сведении, 0..1. */
  weight: number;
}

/** Роль примитива в кадре. 'auto' — её назначает система фокуса. */
export type PrimitiveRole = 'auto' | 'solo' | 'accent' | 'background';

export interface PrimitiveSettings {
  enabled: boolean;
  role: PrimitiveRole;
  /** Свои параметры примитива; ключи — из PRIMITIVE_PARAMS. */
  params: Record<string, number>;
}

export interface Settings {
  /**
   * Расширенный режим: снимает безопасные границы ползунков. За галочкой
   * именно потому, что за ней лежат значения, ломающие картинку, — они нужны
   * для поиска, а не для повседневной настройки.
   */
  advanced: boolean;
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
    /**
     * Соло-режим панели: один примитив на экране, остальные выключены.
     * Без него параметры примитива не подобрать — он тонет в общем кадре.
     */
    solo: PrimitiveId | null;
  };
  focus: {
    /** Сколько соло держится минимум и максимум, в секундах. */
    soloMinSec: number;
    soloMaxSec: number;
    /** Вес акцента и фона относительно соло, 0..1. */
    accentWeight: number;
    backgroundWeight: number;
    /** Длительность увода старого соло и ввода нового, мс. */
    exitMs: number;
    enterMs: number;
  };
  /** Свои настройки каждого примитива — раздел на примитив в панели. */
  primitives: Record<PrimitiveId, PrimitiveSettings>;
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
    /** Потолок кадров в секунду; 0 — не ограничивать. */
    fpsLimit: number;
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
    /** Искажение координат шумом от шума — основа всех остальных. */
    domainWarp: number;
    /** Закрутка вокруг центра. */
    twist: number;
    /** Бегущая волна по кадру. */
    wave: number;
    /** Мелкая многооктавная турбулентность. */
    turbulence: number;
    /** Стекание вниз. */
    melt: number;
    /** Складка: отражение пространства от линии. */
    fold: number;
  };
  particles: {
    enabled: boolean;
    /** auto — набор типов выбирает рейтинг уместности; manual — список ниже. */
    mode: 'auto' | 'manual';
    manual: ParticleType[];
    /** Общая плотность, 0..1. */
    density: number;
    /** Время жизни частицы, множитель к базовому. */
    life: number;
    /** Скорость в общем поле потока, множитель. */
    speed: number;
    /** Размер частицы, множитель. */
    size: number;
  };
  light: {
    /** Сила свечения ярких мест, 0..1. Порог адаптивный, кадр не выжигается. */
    bloom: number;
    /**
     * Сдвиг адаптивного порога bloom. Сам порог считается от средней яркости
     * кадра — ручка только смещает его, иначе на ярком кадре всё выгорает.
     */
    bloomBias: number;
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
    /** Длина следов: сколько прошлого кадра остаётся под новым, 0..1. */
    trails: number;
    /**
     * Обратная связь кадра: прошлый кадр подмешивается в текущий со сдвигом,
     * масштабом и поворотом. Отсюда бесконечные туннели и спирали.
     */
    feedback: number;
    /** Временное размазывание на дропе. */
    smear: number;
    /** Призраки прошлых ударов. */
    ghosts: boolean;
    /** Ритмическое эхо на 1/2, 1/4 или пунктирную 3/8, 0..1. */
    echo: number;
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
    /** Угол, в котором стоит карточка. */
    cardCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    /** Сколько карточка держится в режиме «на смену трека», секунд. */
    cardHoldSec: number;
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

/** Примитивы, которые рисуют сам сигнал, а не абстракцию рядом с ним. */
export const AUDIO_PRIMITIVE_IDS: PrimitiveId[] = [
  'waveform-terrain', 'wave-mesh', 'spectrum', 'radial-waveform', 'oscilloscope',
];

function defaultPrimitives(): Record<PrimitiveId, PrimitiveSettings> {
  const out = {} as Record<PrimitiveId, PrimitiveSettings>;
  for (const id of ALL_PRIMITIVE_IDS) {
    out[id] = { enabled: true, role: 'auto', params: defaultPrimitiveParams(id) };
  }
  return out;
}

export function defaultSettings(): Settings {
  return {
    advanced: false,
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
      solo: null,
    },
    focus: {
      soloMinSec: 22,
      soloMaxSec: 42,
      accentWeight: 0.26,
      backgroundWeight: 0.1,
      exitMs: 900,
      enterMs: 1100,
    },
    primitives: defaultPrimitives(),
    motion: {
      amount: 1,
      budget: 2.4,
    },
    quality: {
      level: 'medium',
      auto: true,
      fpsLimit: 0,
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
      // Domain warping идёт первым и сильнее прочих: остальные деформации
      // ложатся уже на искажённое им пространство.
      domainWarp: 0.7,
      twist: 0.4,
      wave: 0.4,
      turbulence: 0.35,
      melt: 0.3,
      fold: 0.25,
    },
    particles: {
      enabled: true,
      mode: 'auto',
      manual: ['sparks', 'dust'],
      density: 0.6,
      life: 1,
      speed: 1,
      size: 1,
    },
    light: {
      bloom: 0.42,
      bloomBias: 0,
      // Лучи и контровой свет заметно тише прежнего: оба размазывают свет по
      // большой площади, а кадр должен оставаться в основном тёмным.
      rays: 0.12,
      rim: 0.18,
      flare: true,
      exposure: true,
      vignette: true,
    },
    memory: {
      trails: 0.35,
      feedback: 0.28,
      smear: 0.45,
      ghosts: true,
      echo: 0.5,
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
      cardCorner: 'top-left',
      cardHoldSec: 8,
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
      // Живой звук: широкий штрих, глубокий ландшафт, длинное послесвечение —
      // картинка должна держать удар, а не рассыпаться на мелкую сетку.
      s.primitives['waveform-terrain'].params.depth = 150;
      s.primitives['waveform-terrain'].params.verticalGain = 1.3;
      s.primitives['waveform-terrain'].params.lineWidth = 1.4;
      s.primitives.oscilloscope.params.persistence = 0.75;
      s.primitives.spectrum.params.glitch = 0.2;
      s.primitives.spectrum.params.rainbow = 0;
      s.primitives['l-system'].params.depth = 6;
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
      // Сетка мелкая и частая, глитч на полную, радуга по частоте — здесь
      // она к месту, потому что читается как легенда спектра.
      s.primitives.spectrum.params.bars = 256;
      s.primitives.spectrum.params.glitch = 1;
      s.primitives.spectrum.params.gap = 0.55;
      s.primitives['wave-mesh'].params.lines = 140;
      s.primitives['wave-mesh'].params.flow = 1.6;
      s.primitives['wave-mesh'].params.spectrumMix = 0.8;
      s.primitives.oscilloscope.params.persistence = 0.45;
      s.primitives.metaballs.params.shells = 3;
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
    id: 'audio-waves',
    name: 'Аудио-волны',
    apply: (s) => {
      // Соло на ландшафте из волны: это самый прямой показ сигнала, и весь
      // остальной набор здесь только мешал бы ему.
      s.generator.mode = 'auto';
      for (const id of ALL_PRIMITIVE_IDS) {
        s.primitives[id].role = 'auto';
        s.primitives[id].enabled = AUDIO_PRIMITIVE_IDS.includes(id);
      }
      s.primitives['waveform-terrain'].role = 'solo';
      s.palette.tuning.chromaBoost = 0.85;
      s.deformation.amount = 0.25;
      s.memory.feedback = 0.15;
      s.light.bloom = 0.5;
      s.light.rays = 0.08;
      // Сам сигнал и ничего вокруг: глубокая история, сильное отражение,
      // заметный «дождь» от гребней.
      s.primitives['waveform-terrain'].params.depth = 170;
      s.primitives['waveform-terrain'].params.reflection = 0.85;
      s.primitives['waveform-terrain'].params.rain = 0.75;
      s.primitives['waveform-terrain'].params.perspective = 0.6;
      s.primitives.oscilloscope.params.gain = 1.25;
      s.primitives['radial-waveform'].params.rings = 3;
    },
  },
  {
    id: 'max-sharpness',
    name: 'Максимальная чёткость',
    apply: (s) => {
      // Всё, что размазывает кадр, — в ноль: свечение, следы, обратная связь,
      // деформации. Остаются линии в нативном разрешении и почти чёрный фон.
      s.quality.level = 'high';
      s.quality.auto = false;
      s.light.bloom = 0.15;
      s.light.rays = 0;
      s.light.rim = 0.08;
      s.light.flare = false;
      s.memory.trails = 0.1;
      s.memory.feedback = 0;
      s.memory.smear = 0;
      s.deformation.amount = 0.2;
      s.palette.tuning.lightnessBoost = 1.15;
      s.palette.tuning.chromaBoost = 0.9;
      // Линия ровно в один физический пиксель у всех, кто её рисует.
      for (const id of ALL_PRIMITIVE_IDS) {
        if ('lineWidth' in s.primitives[id].params) s.primitives[id].params.lineWidth = 1;
      }
      // Меньше линий — каждая видна отдельно, а не сливается с соседней.
      s.primitives['wave-mesh'].params.lines = 70;
      s.primitives['waveform-terrain'].params.depth = 70;
      s.primitives.spectrum.params.gap = 0.7;
    },
  },
  {
    id: 'min-motion',
    name: 'Минимум движения',
    apply: (s) => {
      // Для тех, кого укачивает: движение, тряска и склейки выключены целиком.
      s.motion.amount = 0.15;
      s.motion.budget = 1.2;
      s.camera.enabled = false;
      s.camera.amount = 0.15;
      s.camera.cut = false;
      s.deformation.amount = 0.15;
      s.transients.shake = false;
      s.transients.punchZoom = false;
      s.transients.lensPulse = false;
      s.transients.slice = false;
      s.transients.strobe = false;
      s.memory.smear = 0.1;
      s.generator.morphRate = 0.6;
      // Медленные примитивы: движение внутри кадра тоже укачивает.
      s.primitives['wave-mesh'].params.flow = 0.35;
      s.primitives['flow-field'].params.speed = 0.4;
      s.primitives.metaballs.params.speed = 0.4;
      s.primitives.voronoi.params.speed = 0.35;
      s.primitives['radial-waveform'].params.spin = 0.3;
      s.primitives.cellular.params.speed = 0.5;
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
      // Фон не должен притягивать взгляд: редкие тонкие линии, медленный ход.
      s.primitives['wave-mesh'].params.lines = 60;
      s.primitives['wave-mesh'].params.flow = 0.5;
      s.primitives['wave-mesh'].params.amplitude = 0.7;
      s.primitives['waveform-terrain'].params.depth = 60;
      s.primitives['waveform-terrain'].params.rain = 0.2;
      s.primitives.spectrum.params.glitch = 0;
      s.primitives.spectrum.params.barHeight = 0.6;
      s.primitives.oscilloscope.params.persistence = 0.8;
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
  mergeSection(base.focus, source.focus);
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
  if (typeof source.advanced === 'boolean') base.advanced = source.advanced;

  // Параметры примитивов — отдельно: их надо и дополнить дефолтами, и обрезать
  // по допустимому диапазону, иначе сохранённое значение из расширенного
  // режима останется жить и после того, как режим выключили.
  if (isRecord(source.primitives)) {
    for (const id of ALL_PRIMITIVE_IDS) {
      const saved = source.primitives[id];
      if (!isRecord(saved)) continue;
      const target = base.primitives[id];
      if (typeof saved.enabled === 'boolean') target.enabled = saved.enabled;
      if (saved.role === 'auto' || saved.role === 'solo'
        || saved.role === 'accent' || saved.role === 'background') {
        target.role = saved.role;
      }
      target.params = resolvePrimitiveParams(
        id,
        isRecord(saved.params) ? (saved.params as Record<string, number>) : undefined,
        base.advanced,
      );
    }
  }
  if (base.generator.solo !== null && !ALL_PRIMITIVE_IDS.includes(base.generator.solo)) {
    base.generator.solo = null;
  }

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
