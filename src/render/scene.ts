/**
 * Сцена как единая физическая система.
 *
 * Главная мысль: на экране не набор независимых фильтров, а один мир, в
 * котором музыка воздействует на пять связанных сущностей. Один удар в
 * музыке порождает согласованную реакцию всех сразу — вещество деформируется
 * волной от точки удара, свет вспыхивает, камера получает толчок, память
 * сохраняет призрак и повторяет его через половину и четверть такта.
 *
 *          ИМПУЛЬС (удар)
 *              |
 *   +----------+----------+---------+
 *   v          v          v         v
 * ВЕЩЕСТВО   СВЕТ      КАМЕРА    ПАМЯТЬ
 */

import { clamp, clamp01, SILENT_PROFILE, type BandProfile } from '../audio/features.ts';
import type { MoodVector, Section } from '../audio/mood-vector.ts';
import { SimplexNoise } from './noise.ts';
import { mulberry32, type GeneratorSeed } from './seed.ts';
import { lerp, smoothstep } from './primitives/types.ts';

// ---------------------------------------------------------------- вещество

/**
 * Агрегатное состояние — непрерывная ось, а не переключатель:
 *
 *   ТУМАН ──── ЖИДКОСТЬ ──── КРИСТАЛЛ ──── ПЛАЗМА
 *   0            0.33           0.66          1
 */
export const SUBSTANCE_STATES = ['fog', 'liquid', 'crystal', 'plasma'] as const;
export type SubstanceState = (typeof SUBSTANCE_STATES)[number];

export const SUBSTANCE_LABELS: Record<SubstanceState, string> = {
  fog: 'туман',
  liquid: 'жидкость',
  crystal: 'кристалл',
  plasma: 'плазма',
};

export interface Substance {
  /** Позиция на оси, 0..1. */
  axis: number;
  /** Ближайшее состояние — только для отладки и подписей. */
  nearest: SubstanceState;
  /** Насколько вещество откликается на импульс: мягко течёт или резко колется. */
  stiffness: number;
  /** Текущая деформация от прошедших волн, 0..1. */
  deformation: number;
}

// ------------------------------------------------------------------- свет

export interface Light {
  /** Направление источника в радианах. */
  angle: number;
  /** Базовая интенсивность, 0..1. */
  intensity: number;
  /** Мгновенная вспышка от импульса поверх базовой интенсивности, 0..1. */
  flash: number;
  /** Насколько свет тёплый: 0 — холодный (минор), 1 — тёплый (мажор). */
  warmth: number;
  /**
   * Положение источника в кадре, 0..1. Привязано к доминирующей полосе:
   * бас опускает свет вниз, верх поднимает вверх.
   */
  x: number;
  y: number;
  /** Экспозиция: множитель яркости, дышит на бит. Не строб. */
  exposure: number;
  /** Сжатие виньетки: 0 — раскрыта, 1 — поджата. */
  vignette: number;
  /** Сила блика на пиковом ударе, 0..1. */
  flare: number;
}

// ------------------------------------------------------------------ камера

export interface Camera {
  /** Смещение кадра в долях короткой стороны. */
  x: number;
  y: number;
  /** Масштаб: наезд и отъезд. */
  zoom: number;
  /** Крен в радианах. */
  roll: number;
  /** Вертикальное сжатие: 1 — норма, меньше — сцену придавило ударом сверху. */
  squash: number;
  /**
   * Точка интереса в долях кадра, 0..1. Вокруг неё идут наезд и крен, поэтому
   * кадр не крутится вечно вокруг геометрического центра.
   */
  focusX: number;
  focusY: number;
  /**
   * Поле зрения: 1 — норма, меньше — сужено (билд-ап), больше — расширено.
   * Узкое поле поджимает кадр и выпрямляет его, широкое — раздаёт и гнёт линзой.
   */
  fov: number;
  /**
   * Скорость движения вперёд/назад, -1..1. Сама по себе почти не видна:
   * туннель из неё делает обратная связь кадра, которой она задаёт направление.
   */
  dolly: number;
  /** Номер последней склейки: по смене значения потребители понимают, что был рез. */
  cutId: number;
}

// -------------------------------------------------------------- деформации

/**
 * Деформации вещества. Постоянно активны на низкой интенсивности и
 * усиливаются на пиках — именно из-за этого картинка «дышит», а не стоит.
 */
export interface Deformation {
  /** Искажение координатного пространства шумом — самый ценный приём. */
  domainWarp: number;
  /** Закручивание вокруг центра; скорость идёт от темпа. */
  twist: number;
  /** Синусоидальное смещение по осям. */
  wave: number;
  /** Локальные завихрения. */
  turbulence: number;
  /** Вертикальное стекание — медленные минорные участки. */
  melt: number;
  /** Зеркальные складки пространства. */
  fold: number;
  /** Собственные часы деформаций: идут в темпе трека, а не в реальном времени. */
  time: number;
}

// ------------------------------------------------------------------ память

/** Призрак прошлого удара: остаётся на сцене и медленно гаснет. */
export interface Ghost {
  x: number;
  y: number;
  strength: number;
  age: number;
  life: number;
  kind: ImpulseKind;
}

/**
 * Память сцены. Следы, обратная связь кадра и призраки — всё про то, что
 * сцена помнит прошлые кадры, а не рисуется заново каждый раз.
 */
export interface Memory {
  /** Длина следов: 0 — чистый кадр, 1 — почти без очистки. */
  trail: number;
  /**
   * Доля прошлого кадра, подмешиваемая в текущий. Всегда меньше единицы:
   * это и есть предохранитель от самовозбуждения.
   */
  feedbackAmount: number;
  /** Масштаб прошлого кадра: больше единицы — полёт в туннель. */
  feedbackZoom: number;
  /** Поворот прошлого кадра, радианы — из него получаются спирали. */
  feedbackRotate: number;
  /** Смещение прошлого кадра в долях кадра. */
  feedbackX: number;
  feedbackY: number;
  /** Временное размазывание: прошлый кадр без преобразования. */
  smear: number;
  ghosts: Ghost[];
  /** Доли такта, через которые память повторяет удар: выбраны seed'ом трека. */
  echoDivisions: readonly number[];
}

/** Потолок обратной связи. Выше — кадр уходит в самовозбуждение и белеет. */
export const FEEDBACK_CEILING = 0.88;

// ----------------------------------------------------------------- импульс

/** К какой части набора относится удар — решается по частотному профилю. */
export type ImpulseKind = 'bass' | 'snare' | 'hat' | 'broad';

export const IMPULSE_KIND_LABELS: Record<ImpulseKind, string> = {
  bass: 'бас',
  snare: 'снейр',
  hat: 'хэт',
  broad: 'широкий',
};

/** Расходящееся кольцо в UV-пространстве: shockwave и рябь. */
export interface WaveRing {
  x: number;
  y: number;
  /** Радиус фронта в долях半 диагонали. */
  radius: number;
  strength: number;
  /** Толщина фронта. */
  width: number;
  /** Сколько затухающих колец идёт следом (рябь — несколько, shockwave — одно). */
  rings: number;
}

/**
 * Накопленное состояние импакт-эффектов. Всё, что живёт в UV-пространстве,
 * собирается здесь и применяется одним проходом варпа.
 */
export interface ImpactState {
  shockwaves: WaveRing[];
  ripples: WaveRing[];
  /** Бочка (+) или подушка (−). */
  lensPulse: number;
  /** Разлёт RGB-каналов от центра. */
  chromaticBurst: number;
  /** Сдвиг горизонтальных блоков. */
  slice: number;
  /** Множитель силы, с которой волны расталкивают частицы. */
  pressure: number;
}

export interface Impulse {
  /** Сквозной номер: по нему потребители понимают, что импульс новый. */
  id: number;
  /** Частотный профиль удара. */
  profile: BandProfile;
  /** Классификация профиля — по ней выбираются эффекты. */
  kind: ImpulseKind;
  /** Точка удара в нормированных координатах 0..1. */
  x: number;
  y: number;
  /** Сила в момент рождения, 0..1. */
  strength: number;
  /** Возраст в секундах. */
  age: number;
  /** Сколько живёт, секунды. */
  life: number;
  /** Радиус фронта волны в долях диагонали. */
  radius: number;
  /** Эхо это или исходный удар. */
  echo: boolean;
  /** Оттенок эха берётся комплементарным; 0 — обычный удар. */
  tone: number;
}

/** Отложенное повторение удара памятью сцены. */
interface PendingEcho {
  atMs: number;
  x: number;
  y: number;
  strength: number;
  profile: BandProfile;
}

/**
 * Бюджет интенсивности: сколько визуальной активности сцена себе позволяет.
 *
 * Без него все эффекты, работающие на полную одновременно, дают кашу. Группы
 * конкурируют за общий лимит по уместности: удары получают больше, когда бьют,
 * деформации — когда материал шумный, память — на дропе.
 */
export interface BudgetState {
  /** Запрошенная суммарная активность. */
  load: number;
  /** Лимит, 0 — не ограничивать. */
  limit: number;
  /** Во сколько раз пришлось ужать каждую группу, 1 — не ужимали. */
  scale: {
    deformation: number;
    impact: number;
    memory: number;
    motion: number;
  };
}

export interface SceneState {
  substance: Substance;
  light: Light;
  camera: Camera;
  deformation: Deformation;
  impact: ImpactState;
  /** Живые импульсы, включая эхо. */
  impulses: Impulse[];
  /** Суммарная энергия волн прямо сейчас, 0..1 — общий множитель реакций. */
  impulseEnergy: number;
  memory: Memory;
  budget: BudgetState;
}

/**
 * Что сцене разрешено делать. Собирается композитором из настроек: сцена не
 * лезет в Settings сама, поэтому её можно гонять в проверках без UI.
 */
export interface SceneConfig {
  /** Общая интенсивность импакт-эффектов, 0..1. */
  intensity: number;
  shake: boolean;
  shockwave: boolean;
  ripple: boolean;
  punchZoom: boolean;
  lensPulse: boolean;
  rollKick: boolean;
  compression: boolean;
  chromaticBurst: boolean;
  slice: boolean;
  pressureWave: boolean;
  /** Общий множитель постоянных деформаций вещества, 0..1. */
  deformation: number;
  /** Монтажные склейки на границах частей. */
  cut: boolean;
  /** Доля обратной связи кадра, 0..1 (умножается на потолок безопасности). */
  feedback: number;
  /** Временное размазывание на дропе, 0..1. */
  smear: number;
  /** Призраки прошлых ударов. */
  ghosts: boolean;
  /** Блики на пиковых ударах. */
  flare: boolean;
  /**
   * Потолок суммарной активности эффектов. 0 — не ограничивать.
   * Смысл см. в BudgetState.
   */
  budget: number;
  /** Общий множитель амплитуды движения: камера, тряска, деформации. */
  motion: number;
}

export function defaultSceneConfig(): SceneConfig {
  return {
    intensity: 0.7,
    shake: true,
    shockwave: true,
    ripple: true,
    punchZoom: true,
    lensPulse: true,
    rollKick: true,
    compression: true,
    chromaticBurst: true,
    slice: true,
    pressureWave: true,
    deformation: 0.6,
    cut: false,
    feedback: 0.5,
    smear: 0.6,
    ghosts: true,
    flare: true,
    budget: 2.4,
    motion: 1,
  };
}

/**
 * Классификация удара по частотному профилю.
 * Бочка и хай-хэт должны давать разные реакции — вот здесь это и решается.
 */
export function classifyImpulse(profile: BandProfile): ImpulseKind {
  const { low, mid, high } = profile;
  const peak = Math.max(low, mid, high);
  if (peak <= 0) return 'broad';
  // Если ни одна полоса заметно не выделяется, удар широкополосный.
  const spread = peak - Math.min(low, mid, high);
  if (spread < 0.3) return 'broad';
  if (low === peak) return 'bass';
  if (high === peak) return 'hat';
  return 'snare';
}

/** Реже раза в 15 секунд склейка не мешает, чаще — укачивает. */
const CUT_MIN_INTERVAL_MS = 16_000;

const MAX_IMPULSES = 24;
/** Сколько колец одного типа живёт одновременно: шейдер читает их в цикле. */
const MAX_RINGS = 4;
const MAX_PENDING_ECHOES = 32;
/** Порог силы удара, ниже которого импульс не рождается. */
const IMPULSE_FLOOR = 0.08;
/**
 * Ритмические рисунки эха — доли такта, через которые повторяется удар.
 * Рисунок выбирается seed'ом трека, поэтому один трек «отвечает» прямо,
 * другой — пунктиром.
 */
const ECHO_PATTERNS: number[][] = [
  [0.5, 0.25],        // прямое
  [0.375, 0.75],      // пунктирное, 3/8 такта
  [0.25, 0.5, 0.75],  // плотное
];

const MAX_GHOSTS = 14;

export class Scene {
  private readonly impulses: Impulse[] = [];
  private readonly pendingEchoes: PendingEcho[] = [];
  private noise = new SimplexNoise();
  private rng = mulberry32(1);

  private axis = 0.2;
  private deformation = 0;
  private lightFlash = 0;
  private cameraKickX = 0;
  private cameraKickY = 0;
  private cameraKickRoll = 0;
  private orbitPhase = 0;
  private zoomDrift = 1;
  private prevFlux = 0;
  private nextImpulseId = 1;

  /** Импакт-эффекты: затухающие скаляры и живые кольца. */
  private readonly shockwaves: WaveRing[] = [];
  private readonly ripples: WaveRing[] = [];
  private lensPulse = 0;
  private chromaticBurst = 0;
  private slice = 0;
  private pressure = 0;
  /** Точка интереса и её медленный дрейф. */
  private focusX = 0.5;
  private focusY = 0.5;
  private focusSeedX = 0;
  private focusSeedY = 0;
  private fov = 1;
  private dolly = 0;
  private cutId = 0;
  private lastCutMs = -Infinity;
  private echoPattern: number[] = ECHO_PATTERNS[0];
  private readonly ghosts: Ghost[] = [];
  private feedbackRotate = 0;
  private lightX = 0.5;
  private lightY = 0.5;
  private vignette = 0.45;
  private flare = 0;

  /** Упругий наезд: смещение и его скорость — обычная пружина с затуханием. */
  private punchOffset = 0;
  private punchVelocity = 0;
  private compression = 0;
  private shakeEnergy = 0;
  /** 1 — тряска строго по вертикали (бас), 0 — мелкая дрожь без оси (верх). */
  private shakeAxis = 0.5;
  private config: SceneConfig = defaultSceneConfig();

  /** Часы деформаций идут в темпе трека, поэтому twist не «плывёт» при смене BPM. */
  private warpTime = 0;
  private prevSection: Section = 'calm';
  /** Смещения шума, чтобы дрейф камеры у разных треков не совпадал. */
  private driftSeedX = 0;
  private driftSeedY = 0;

  reseed(seed: GeneratorSeed): void {
    this.rng = mulberry32(seed.seed ^ 0x3c6ef372);
    this.noise = new SimplexNoise(this.rng);
    this.driftSeedX = this.rng() * 100;
    this.driftSeedY = this.rng() * 100;
    this.focusSeedX = this.rng() * 100;
    this.focusSeedY = this.rng() * 100;
    this.orbitPhase = this.rng() * Math.PI * 2;
    this.echoPattern = ECHO_PATTERNS[Math.floor(this.rng() * ECHO_PATTERNS.length)];
    this.ghosts.length = 0;
    this.impulses.length = 0;
    this.pendingEchoes.length = 0;
    this.shockwaves.length = 0;
    this.ripples.length = 0;
  }

  update(mood: MoodVector, config: SceneConfig): SceneState {
    const dt = Math.min(0.1, mood.deltaMs / 1000);
    this.config = config;

    const sectionChanged = mood.section !== this.prevSection;
    this.emitImpulses(mood, config.intensity);
    this.maybeCut(mood, sectionChanged);
    this.releaseEchoes(mood);
    this.integrateImpulses(dt);

    const impulseEnergy = this.impulses.reduce(
      (sum, impulse) => sum + impulse.strength * (1 - impulse.age / impulse.life),
      0,
    );
    const normalizedImpulse = clamp01(impulseEnergy * 0.7);

    const substance = this.updateSubstance(mood, dt, normalizedImpulse);
    const light = this.updateLight(mood, dt);
    const camera = this.updateCamera(mood, dt, substance);
    const deformation = this.updateDeformation(mood, dt, substance);
    const impact = this.updateImpact(dt);
    const memory = this.updateMemory(mood, dt, substance, camera);
    const budget = this.applyBudget(mood, normalizedImpulse, deformation, impact, memory, camera);

    return {
      substance,
      light,
      camera,
      deformation,
      impact,
      impulses: this.impulses,
      impulseEnergy: normalizedImpulse,
      memory,
      budget,
    };
  }

  /**
   * Рождение импульса. Источников два: удар (onset) и резкий скачок flux —
   * второй ловит глитчи и дропы, у которых нет внятной атаки.
   */
  private emitImpulses(mood: MoodVector, intensity: number): void {
    const fluxJump = mood.flux - this.prevFlux;
    this.prevFlux = mood.flux;

    const sectionChanged = mood.section !== this.prevSection;
    this.prevSection = mood.section;

    let strength = 0;
    let profile = mood.onsetProfile;
    if (mood.onset && mood.onsetStrength > IMPULSE_FLOOR) strength = mood.onsetStrength;
    if (fluxJump > 0.2) {
      strength = Math.max(strength, clamp01(fluxJump * 1.6));
      // У скачка flux собственного профиля нет — берём текущий баланс полос.
      if (profile === SILENT_PROFILE) profile = mood.bands;
    }
    if (sectionChanged && mood.section === 'drop') {
      strength = Math.max(strength, 0.9);
      if (profile === SILENT_PROFILE) profile = mood.bands;
    }
    if (strength <= 0) return;

    const scaled = strength * intensity;
    // Точка удара смещается от центра тем сильнее, чем громче: тихие удары
    // приходят «отовсюду», громкие имеют явный источник.
    const spread = 0.12 + scaled * 0.3;
    const x = 0.5 + (this.rng() * 2 - 1) * spread;
    const y = 0.5 + (this.rng() * 2 - 1) * spread;

    this.spawn(x, y, scaled, false, profile, mood, sectionChanged && mood.section === 'drop');
    this.scheduleEchoes(mood, x, y, scaled, profile);
  }

  /** Память: тот же удар повторяется через 1/2 и 1/4 такта, слабее. */
  private scheduleEchoes(mood: MoodVector, x: number, y: number, strength: number, profile: BandProfile = SILENT_PROFILE): void {
    if (strength < 0.25) return; // слабые удары эха не оставляют, иначе каша
    const barMs = (60000 / Math.max(40, mood.bpm)) * 4;

    for (const division of this.echoPattern) {
      if (this.pendingEchoes.length >= MAX_PENDING_ECHOES) break;
      this.pendingEchoes.push({
        atMs: mood.timeMs + barMs * division,
        x,
        y,
        strength: strength * (division === 0.5 ? 0.45 : 0.22),
        profile,
      });
    }
  }

  private releaseEchoes(mood: MoodVector): void {
    for (let i = this.pendingEchoes.length - 1; i >= 0; i--) {
      const echo = this.pendingEchoes[i];
      if (mood.timeMs < echo.atMs) continue;
      this.pendingEchoes.splice(i, 1);
      // Пропускаем протухшее эхо: после паузы вкладки они бы вышли пачкой.
      if (mood.timeMs - echo.atMs > 400) continue;
      // Эхо несёт профиль исходного удара: повтор должен звучать так же.
      this.spawn(echo.x, echo.y, echo.strength * this.config.intensity, true, echo.profile, mood, false);
    }
  }

  /**
   * Рождение импульса и вся согласованная реакция на него.
   *
   * Какие эффекты сработают, решает лестница по силе удара: слабый onset даёт
   * только толчок камеры, дроп — толчок, ударную волну, разлёт каналов,
   * волну давления и вспышку разом. Между ними всё промежуточное, поэтому
   * нарастание читается как нарастание, а не как «есть удар / нет удара».
   *
   * Что именно сработает, решает ещё и частотный профиль: бас даёт ударную
   * волну и сжатие по вертикали, снейр — крен, хэт — мелкую дрожь.
   */
  private spawn(
    x: number,
    y: number,
    strength: number,
    echo: boolean,
    profile: BandProfile,
    mood: MoodVector,
    isDrop: boolean,
  ): void {
    if (this.impulses.length >= MAX_IMPULSES) this.impulses.shift();
    const kind = classifyImpulse(profile);
    const life = 0.45 + strength * 0.75;
    const impulse: Impulse = {
      id: this.nextImpulseId++,
      profile,
      kind,
      x: clamp01(x),
      y: clamp01(y),
      strength: clamp01(strength),
      age: 0,
      life,
      radius: 0,
      echo,
      tone: echo ? 1 : 0,
    };
    this.impulses.push(impulse);

    const config = this.config;
    // Эхо бьёт мягче исходного удара, но по тем же правилам.
    const power = strength * (echo ? 0.6 : 1);

    // --- ступень 1: всегда, даже на самом слабом ударе ---
    this.deformation = clamp01(this.deformation + power * 0.7);
    this.lightFlash = clamp01(this.lightFlash + power * (echo ? 0.3 : 0.75));

    if (config.shake) {
      this.shakeEnergy = clamp01(this.shakeEnergy + power * 0.85);
      // Низ бьёт по вертикали, верх даёт мелкую дрожь без выраженной оси.
      this.shakeAxis = lerp(this.shakeAxis, clamp01(profile.low - profile.high * 0.8), 0.6);
    }
    // Отдача камеры от точки удара.
    const angle = Math.atan2(y - 0.5, x - 0.5);
    this.cameraKickX -= Math.cos(angle) * power * 0.035;
    this.cameraKickY -= Math.sin(angle) * power * 0.035;

    // Призрак остаётся на сцене и гаснет несколько секунд после самого удара.
    if (config.ghosts && power > 0.3) {
      if (this.ghosts.length >= MAX_GHOSTS) this.ghosts.shift();
      this.ghosts.push({
        x: clamp01(x), y: clamp01(y), strength: clamp01(power), age: 0,
        life: 2.5 + power * 3.5, kind,
      });
    }

    // --- ступень 2: заметный удар ---
    if (power > 0.3) {
      if (config.shockwave && kind === 'bass') {
        this.pushRing(this.shockwaves, x, y, power, 0.07, 1);
      }
      // Рябь — отклик жидкого вещества на средний удар: несколько колец.
      if (config.ripple && kind !== 'bass' && this.axis > 0.2 && this.axis < 0.62) {
        this.pushRing(this.ripples, x, y, power * 0.8, 0.14, 3);
      }
      if (config.compression && kind === 'bass') {
        this.compression = Math.max(this.compression, power * 0.8);
      }
      if (config.rollKick && kind === 'snare') {
        this.cameraKickRoll += (this.rng() < 0.5 ? -1 : 1) * power * 0.06;
      }
    }

    // --- ступень 3: сильный удар ---
    if (power > 0.5) {
      if (config.lensPulse) {
        // Бас выдавливает бочку наружу, верх — подушку внутрь.
        const direction = profile.low > profile.high ? 1 : -1;
        this.lensPulse = Math.max(Math.abs(this.lensPulse), power * 0.5) * direction;
      }
      if (config.slice && mood.flux > 0.35) this.slice = Math.max(this.slice, power);
    }

    // --- ступень 4: пик ---
    if (power > 0.68) {
      if (config.chromaticBurst) this.chromaticBurst = Math.max(this.chromaticBurst, power);
      // Блик — дозированно: только на пиковых ударах и не от эха.
      if (config.flare && !echo) this.flare = Math.max(this.flare, power * 0.8);
    }

    // --- дроп: всё сразу ---
    if (isDrop) {
      // Толчок задаёт пружине скорость, а не позицию: отсюда упругий возврат.
      if (config.punchZoom) this.punchVelocity += power * 3.4;
      if (config.pressureWave) this.pressure = Math.max(this.pressure, power);
      if (config.chromaticBurst) this.chromaticBurst = Math.max(this.chromaticBurst, power * 0.9);
    }
  }

  /**
   * Бюджет интенсивности.
   *
   * Каждая группа заявляет свою нагрузку и свою уместность. Если сумма
   * нагрузок влезает в лимит — ничего не трогаем. Если нет, каждая группа
   * получает долю лимита пропорционально уместности, но не больше, чем
   * просила: сильные в моменте эффекты ужимаются меньше слабых.
   *
   * Значения правятся на месте: SceneState раздаётся дальше уже ужатым.
   */
  private applyBudget(
    mood: MoodVector,
    impulseEnergy: number,
    deformation: Deformation,
    impact: ImpactState,
    memory: Memory,
    camera: Camera,
  ): BudgetState {
    const limit = this.config.budget;
    const groups = {
      deformation: {
        load: (deformation.domainWarp + deformation.twist + deformation.wave
          + deformation.turbulence + deformation.melt + deformation.fold) / 2.2,
        relevance: 0.3 + mood.noisiness * 0.7,
      },
      impact: {
        load: Math.abs(impact.lensPulse) + impact.chromaticBurst + impact.slice
          + (impact.shockwaves.length + impact.ripples.length) * 0.25,
        relevance: 0.35 + impulseEnergy * 1.1,
      },
      memory: {
        load: memory.feedbackAmount + memory.smear,
        relevance: 0.25 + (mood.section === 'drop' ? 0.5 : 0) + mood.energy * 0.3,
      },
      motion: {
        load: (Math.abs(camera.x) + Math.abs(camera.y)) * 6
          + Math.abs(camera.roll) * 5 + Math.abs(camera.zoom - 1) * 2.5,
        relevance: 0.3 + mood.energy * 0.5,
      },
    };

    const load = groups.deformation.load + groups.impact.load + groups.memory.load + groups.motion.load;
    const scale = { deformation: 1, impact: 1, memory: 1, motion: 1 };

    if (limit > 0 && load > limit) {
      const totalRelevance = groups.deformation.relevance + groups.impact.relevance
        + groups.memory.relevance + groups.motion.relevance;
      for (const key of ['deformation', 'impact', 'memory', 'motion'] as const) {
        const group = groups[key];
        if (group.load <= 1e-6) continue;
        const allowed = (limit * group.relevance) / totalRelevance;
        scale[key] = clamp01(allowed / group.load);
      }

      const d = scale.deformation;
      deformation.domainWarp *= d;
      deformation.twist *= d;
      deformation.wave *= d;
      deformation.turbulence *= d;
      deformation.melt *= d;
      deformation.fold *= d;

      const i = scale.impact;
      impact.lensPulse *= i;
      impact.chromaticBurst *= i;
      impact.slice *= i;
      for (const ring of impact.shockwaves) ring.strength *= i;
      for (const ring of impact.ripples) ring.strength *= i;

      memory.feedbackAmount *= scale.memory;
      memory.smear *= scale.memory;

      const m = scale.motion;
      camera.x *= m;
      camera.y *= m;
      camera.roll *= m;
      camera.zoom = 1 + (camera.zoom - 1) * m;
      camera.squash = 1 + (camera.squash - 1) * m;
    }

    return { load, limit, scale };
  }

  /**
   * Память сцены: следы, обратная связь кадра и призраки.
   *
   * Обратная связь — самая опасная часть: кадр, подмешанный сам в себя с
   * коэффициентом ≥ 1, за секунду уходит в белое. Поэтому доля жёстко
   * ограничена FEEDBACK_CEILING, а шейдер дополнительно гасит прошлый кадр.
   */
  private updateMemory(mood: MoodVector, dt: number, substance: Substance, camera: Camera): Memory {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const ghost = this.ghosts[i];
      ghost.age += dt;
      if (ghost.age >= ghost.life) this.ghosts.splice(i, 1);
    }

    // Поворот прошлого кадра копится — из этого получаются спирали, а не просто
    // повторы под одним углом.
    this.feedbackRotate += dt * camera.roll * 0.5 + dt * substance.axis * 0.02;

    const config = this.config;
    const sectionPush = mood.section === 'drop' ? 0.25 : mood.section === 'calm' ? -0.1 : 0;
    const feedbackAmount = config.feedback <= 0 ? 0 : Math.min(
      FEEDBACK_CEILING,
      (0.3 + mood.energy * 0.3 + substance.axis * 0.15 + sectionPush) * config.feedback,
    );

    return {
      // Кристалл держит форму дольше, плазма сгорает мгновенно.
      trail: clamp01(0.8 - mood.energy * 0.45 - substance.axis * 0.25),
      feedbackAmount,
      // Долли задаёт направление полёта: вперёд — туннель, назад — раскрытие.
      feedbackZoom: 1 + camera.dolly * 0.016 * (config.feedback > 0 ? 1 : 0),
      feedbackRotate: this.feedbackRotate * 0.04,
      feedbackX: camera.x * 0.15,
      feedbackY: camera.y * 0.15,
      // Размазывание — отдельный приём и только на дропе.
      smear: mood.section === 'drop' ? clamp01(mood.energy * 0.45) * config.smear : 0,
      ghosts: this.ghosts,
      echoDivisions: this.echoPattern,
    };
  }

  /** Кольцо живёт в списке, пока его фронт не уйдёт за пределы кадра. */
  private pushRing(target: WaveRing[], x: number, y: number, strength: number, width: number, rings: number): void {
    if (target.length >= MAX_RINGS) target.shift();
    target.push({ x: clamp01(x), y: clamp01(y), radius: 0, strength: clamp01(strength), width, rings });
  }

  /** Затухание импакт-эффектов и продвижение фронтов волн. */
  private updateImpact(dt: number): ImpactState {
    for (const list of [this.shockwaves, this.ripples]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const ring = list[i];
        // Ударная волна быстрее ряби: у неё шире шаг радиуса.
        const speed = list === this.shockwaves ? 1.5 : 0.7;
        ring.radius += dt * speed;
        ring.strength *= Math.exp(-dt * (list === this.shockwaves ? 2.6 : 1.5));
        if (ring.radius > 1.8 || ring.strength < 0.01) list.splice(i, 1);
      }
    }

    this.lensPulse *= Math.exp(-dt * 7);
    this.chromaticBurst *= Math.exp(-dt * 6);
    this.slice *= Math.exp(-dt * 9);
    this.pressure *= Math.exp(-dt * 3);

    return {
      shockwaves: this.shockwaves,
      ripples: this.ripples,
      lensPulse: Math.abs(this.lensPulse) < 0.002 ? 0 : this.lensPulse,
      chromaticBurst: this.chromaticBurst < 0.002 ? 0 : this.chromaticBurst,
      slice: this.slice < 0.004 ? 0 : this.slice,
      pressure: this.pressure,
    };
  }

  /**
   * Деформации вещества. Каждая держит ненулевой базовый уровень — без него
   * картинка встаёт колом между ударами — и растёт от своего источника.
   */
  private updateDeformation(mood: MoodVector, dt: number, substance: Substance): Deformation {
    // Часы идут в темпе: twist и волна не «плывут» при смене BPM.
    this.warpTime += dt * (0.25 + Math.max(40, mood.bpm) / 220);

    const scale = this.config.deformation;
    const peak = substance.deformation;
    // Медленный минор на вязком веществе — единственное, что заставляет сцену течь вниз.
    // Порог по оси намеренно низкий: медленные минорные места — это почти
    // всегда секция calm, а она сама уводит вещество к туману. С порогом
    // «от жидкости» стекание не включалось бы никогда.
    const meltCondition = (mood.key.mode === 'minor' ? 1 : 0.25)
      * (1 - smoothstep(70, 120, mood.bpm))
      * (1 - mood.energy)
      * smoothstep(0.05, 0.35, substance.axis);

    return {
      domainWarp: clamp01((0.12 + mood.noisiness * 0.35 + peak * 0.5) * scale),
      twist: clamp01((0.06 + mood.energy * 0.25 + substance.axis * 0.2 + peak * 0.3) * scale),
      wave: clamp01((0.08 + mood.bands.mid * 0.3 + mood.flux * 0.3) * scale),
      turbulence: clamp01((0.05 + mood.noisiness * 0.4 + substance.axis * 0.3) * scale),
      melt: clamp01(meltCondition * 0.7 * scale),
      // Складки живут на кристаллической части оси — там же, где калейдоскоп.
      fold: clamp01(smoothstep(0.55, 1, substance.axis) * 0.5 * scale),
      time: this.warpTime,
    };
  }

  private integrateImpulses(dt: number): void {
    for (let i = this.impulses.length - 1; i >= 0; i--) {
      const impulse = this.impulses[i];
      impulse.age += dt;
      // Фронт волны замедляется к концу жизни — так он «затухает», а не обрывается.
      const progress = impulse.age / impulse.life;
      impulse.radius = smoothstep(0, 1, progress) * (0.45 + impulse.strength * 0.7);
      if (impulse.age >= impulse.life) this.impulses.splice(i, 1);
    }
  }

  /**
   * Точка на оси вещества. Шумность гонит к плазме, чистый тихий звук — к
   * туману, ритмичная яркость — к кристаллу. Переход всегда плавный.
   */
  private updateSubstance(mood: MoodVector, dt: number, impulseEnergy: number): Substance {
    const sectionPush = mood.section === 'drop' ? 0.28 : mood.section === 'calm' ? -0.2 : 0;
    const target = clamp01(
      0.12 +
      mood.noisiness * 0.45 +
      mood.brightness * 0.28 +
      mood.energy * 0.2 +
      sectionPush,
    );
    // Вещество меняет состояние медленнее всего остального: это «из чего сделан мир».
    this.axis = lerp(this.axis, target, 1 - Math.exp(-dt / 1.6));

    this.deformation = Math.max(0, this.deformation - dt * (1.4 + this.axis * 2.2));

    return {
      axis: this.axis,
      nearest: SUBSTANCE_STATES[Math.min(3, Math.round(this.axis * 3))],
      // Туман почти не сопротивляется, кристалл откликается резко.
      stiffness: clamp01(0.15 + this.axis * 0.75),
      deformation: clamp01(this.deformation + impulseEnergy * 0.3),
    };
  }

  private updateLight(mood: MoodVector, dt: number): Light {
    this.lightFlash = Math.max(0, this.lightFlash - dt * 3.2);
    this.flare = Math.max(0, this.flare - dt * 2.6);
    // Источник медленно обходит сцену; на быстрых треках — быстрее.
    const orbit = this.orbitPhase + (mood.timeMs / 1000) * (0.08 + mood.bpm / 2400);

    // Высота источника — от того, какая полоса сейчас громче. Бас тяжёлый и
    // светит снизу, верх лёгкий и светит сверху.
    const bands = mood.bands;
    const weight = bands.low + bands.mid + bands.high;
    const balance = weight > 1e-5 ? (bands.high - bands.low) / weight : 0;
    const targetY = 0.5 - balance * 0.38;
    this.lightY = lerp(this.lightY, clamp(0.08, 0.92, targetY), 1 - Math.exp(-dt / 0.8));
    const targetX = 0.5 + Math.cos(orbit) * 0.32;
    this.lightX = lerp(this.lightX, targetX, 1 - Math.exp(-dt / 0.35));

    // Экспозиция дышит на долю. Амплитуда намеренно маленькая: это дыхание,
    // а не стробоскоп, и лимита частоты ей не нужно.
    const exposure = 1 + Math.sin(mood.beatPhase * Math.PI * 2) * mood.energy * 0.1
      + this.lightFlash * 0.12;

    // Виньетка поджимается на билд-апе и раскрывается на дропе.
    const vignetteTarget = mood.section === 'buildup'
      ? 0.75 + mood.energy * 0.2
      : mood.section === 'drop'
        ? 0.12
        : 0.45 - mood.energy * 0.15;
    this.vignette = lerp(this.vignette, vignetteTarget,
      1 - Math.exp(-dt / (vignetteTarget < this.vignette ? 0.25 : 1.1)));

    return {
      angle: orbit,
      intensity: clamp01(0.3 + mood.energy * 0.6),
      flash: this.lightFlash,
      warmth: mood.key.mode === 'major' ? clamp01(0.55 + mood.key.confidence * 0.45) : clamp01(0.45 - mood.key.confidence * 0.45),
      x: this.lightX,
      y: this.lightY,
      exposure,
      vignette: clamp01(this.vignette),
      flare: clamp01(this.flare),
    };
  }

  /**
   * Камера: медленный дрейф шумом + орбита в темпе + наезд от энергии +
   * крен от секции, поверх этого — толчки от импульсов.
   */
  private updateCamera(mood: MoodVector, dt: number, substance: Substance): Camera {
    const decay = Math.exp(-dt * 4.5);
    this.cameraKickX *= decay;
    this.cameraKickY *= decay;
    this.cameraKickRoll *= decay;

    const t = mood.timeMs / 1000;
    // Дрейф — низкочастотный шум: камера «дышит», не повторяясь.
    const driftX = this.noise.noise2D(this.driftSeedX, t * 0.05) * 0.05;
    const driftY = this.noise.noise2D(this.driftSeedY, t * 0.045 + 13.1) * 0.05;

    // Орбита привязана к фразе, а не к биту: иначе кадр дёргается.
    const barsPerSecond = Math.max(0.5, mood.bpm) / 60 / 4;
    this.orbitPhase += dt * barsPerSecond * 0.25;
    const orbitRadius = 0.02 + mood.energy * 0.04 + substance.axis * 0.02;
    const orbitX = Math.cos(this.orbitPhase * Math.PI * 2) * orbitRadius;
    const orbitY = Math.sin(this.orbitPhase * Math.PI * 2) * orbitRadius * 0.6;

    // Наезд копится на билд-апе и разряжается на дропе.
    const zoomTarget = mood.section === 'buildup'
      ? 1.04 + mood.energy * 0.1
      : mood.section === 'drop'
        ? 1.1 + mood.energy * 0.14
        : 1 + mood.energy * 0.04;
    this.zoomDrift = lerp(this.zoomDrift, zoomTarget, 1 - Math.exp(-dt / 0.9));

    // Punch zoom — затухающая пружина: резкий наезд и упругий возврат с перелётом.
    const stiffness = 62;
    const damping = 7.5;
    this.punchVelocity += (-stiffness * this.punchOffset - damping * this.punchVelocity) * dt;
    this.punchOffset += this.punchVelocity * dt;
    if (Math.abs(this.punchOffset) < 1e-4 && Math.abs(this.punchVelocity) < 1e-3) {
      this.punchOffset = 0;
      this.punchVelocity = 0;
    }

    // Тряска: низ бьёт по вертикали, верх даёт дрожь без выраженной оси.
    this.shakeEnergy = Math.max(0, this.shakeEnergy - dt * 3.2);
    const shakeAmplitude = this.shakeEnergy * this.shakeEnergy * 0.03;
    const jitterAngle = Math.random() * Math.PI * 2;
    const shakeX = Math.cos(jitterAngle) * shakeAmplitude * (1 - this.shakeAxis);
    const shakeY = (Math.sin(jitterAngle) * (1 - this.shakeAxis)
      + (Math.random() * 2 - 1) * this.shakeAxis * 1.4) * shakeAmplitude;

    this.compression = Math.max(0, this.compression - dt * 4.2);

    const rollBase = Math.sin(this.orbitPhase * Math.PI * 2 * 0.5) * (0.01 + substance.axis * 0.03);

    // Look-at wander: точка интереса медленно уходит от центра и возвращается.
    // Отдельный шум, а не тот же, что у дрейфа, — иначе кадр просто едет целиком.
    const focusTargetX = 0.5 + this.noise.noise2D(this.focusSeedX, t * 0.022) * 0.18;
    const focusTargetY = 0.5 + this.noise.noise2D(this.focusSeedY, t * 0.019 + 7.7) * 0.14;
    this.focusX = lerp(this.focusX, focusTargetX, 1 - Math.exp(-dt / 1.2));
    this.focusY = lerp(this.focusY, focusTargetY, 1 - Math.exp(-dt / 1.2));

    // FOV breathing: на билд-апе поле сужается и копит напряжение,
    // на дропе резко раскрывается. Поэтому вниз тянемся медленно, вверх — быстро.
    const fovTarget = mood.section === 'buildup'
      ? 0.82 - mood.energy * 0.06
      : mood.section === 'drop'
        ? 1.2 + mood.energy * 0.18
        : 1 + (mood.energy - 0.4) * 0.08;
    const fovTau = fovTarget > this.fov ? 0.12 : 1.4;
    this.fov = clamp(0.7, 1.45, lerp(this.fov, fovTarget, 1 - Math.exp(-dt / fovTau)));

    // Dolly: плотное вещество тянет вперёд, разреженное — назад.
    const dollyTarget = clamp(-1, 1, (substance.axis - 0.45) * 1.6 + mood.energy * 0.5 - 0.2);
    this.dolly = lerp(this.dolly, dollyTarget, 1 - Math.exp(-dt / 2.2));

    // Мастер амплитуды применяется один раз — ко всему выходу камеры сразу,
    // включая дрейф и орбиту. Именно они дают основную часть движения, и
    // «спокойная камера» должна гасить в первую очередь их, а не только толчки.
    const motion = this.config.motion;
    const zoomRaw = clamp(0.85, 1.6,
      (this.zoomDrift + substance.deformation * 0.02 + this.punchOffset) / Math.sqrt(this.fov));

    return {
      x: (driftX + orbitX + this.cameraKickX + shakeX) * motion,
      y: (driftY + orbitY + this.cameraKickY + shakeY) * motion,
      // Узкое поле зрения читается как поджатый кадр — компенсируем масштабом.
      zoom: 1 + (zoomRaw - 1) * motion,
      roll: (rollBase + this.cameraKickRoll) * motion,
      // Удар сверху сплющивает сцену по вертикали и чуть растягивает по горизонтали.
      squash: 1 - this.compression * 0.1 * motion,
      focusX: this.focusX,
      focusY: this.focusY,
      fov: this.fov,
      dolly: this.dolly,
      cutId: this.cutId,
    };
  }

  /**
   * Монтажная склейка: мгновенная смена ракурса.
   *
   * Делается сбросом фаз — точка интереса, орбита и дрейф прыгают в новое
   * место, и кадр читается как другой план. Лимит по времени жёсткий: чаще
   * раза в 15-20 секунд от этого укачивает.
   */
  private maybeCut(mood: MoodVector, sectionChanged: boolean): void {
    if (!this.config.cut || !sectionChanged) return;
    // Режем только на дропе и на возврате в затишье — это и есть границы частей.
    if (mood.section !== 'drop' && mood.section !== 'calm') return;
    if (mood.timeMs - this.lastCutMs < CUT_MIN_INTERVAL_MS) return;

    this.lastCutMs = mood.timeMs;
    this.cutId++;
    this.driftSeedX = this.rng() * 100;
    this.driftSeedY = this.rng() * 100;
    this.focusSeedX = this.rng() * 100;
    this.focusSeedY = this.rng() * 100;
    this.orbitPhase = this.rng() * Math.PI * 2;
    // Точку интереса переносим мгновенно: в этом весь смысл склейки.
    this.focusX = 0.5 + (this.rng() * 2 - 1) * 0.2;
    this.focusY = 0.5 + (this.rng() * 2 - 1) * 0.16;
  }
}
