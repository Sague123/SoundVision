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

import { clamp, clamp01 } from '../audio/features.ts';
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
}

// ----------------------------------------------------------------- импульс

export interface Impulse {
  /** Сквозной номер: по нему потребители понимают, что импульс новый. */
  id: number;
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
}

export interface SceneState {
  substance: Substance;
  light: Light;
  camera: Camera;
  /** Живые импульсы, включая эхо. */
  impulses: Impulse[];
  /** Суммарная энергия волн прямо сейчас, 0..1 — общий множитель реакций. */
  impulseEnergy: number;
  /** Длина следов от памяти, 0..1. */
  memoryTrail: number;
}

const MAX_IMPULSES = 24;
const MAX_PENDING_ECHOES = 32;
/** Порог силы удара, ниже которого импульс не рождается. */
const IMPULSE_FLOOR = 0.08;
/** Доли такта, на которых память повторяет удар. */
const ECHO_DIVISIONS = [0.5, 0.25];

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
  private prevSection: Section = 'calm';
  /** Смещения шума, чтобы дрейф камеры у разных треков не совпадал. */
  private driftSeedX = 0;
  private driftSeedY = 0;

  reseed(seed: GeneratorSeed): void {
    this.rng = mulberry32(seed.seed ^ 0x3c6ef372);
    this.noise = new SimplexNoise(this.rng);
    this.driftSeedX = this.rng() * 100;
    this.driftSeedY = this.rng() * 100;
    this.orbitPhase = this.rng() * Math.PI * 2;
    this.impulses.length = 0;
    this.pendingEchoes.length = 0;
  }

  update(mood: MoodVector, intensity: number): SceneState {
    const dt = Math.min(0.1, mood.deltaMs / 1000);

    this.emitImpulses(mood, intensity);
    this.releaseEchoes(mood, intensity);
    this.integrateImpulses(dt);

    const impulseEnergy = this.impulses.reduce(
      (sum, impulse) => sum + impulse.strength * (1 - impulse.age / impulse.life),
      0,
    );
    const normalizedImpulse = clamp01(impulseEnergy * 0.7);

    const substance = this.updateSubstance(mood, dt, normalizedImpulse);
    const light = this.updateLight(mood, dt);
    const camera = this.updateCamera(mood, dt, substance);

    return {
      substance,
      light,
      camera,
      impulses: this.impulses,
      impulseEnergy: normalizedImpulse,
      // Кристалл держит форму дольше, плазма сгорает мгновенно.
      memoryTrail: clamp01(0.8 - mood.energy * 0.45 - substance.axis * 0.25),
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
    if (mood.onset && mood.onsetStrength > IMPULSE_FLOOR) strength = mood.onsetStrength;
    if (fluxJump > 0.2) strength = Math.max(strength, clamp01(fluxJump * 1.6));
    if (sectionChanged && mood.section === 'drop') strength = Math.max(strength, 0.9);
    if (strength <= 0) return;

    const scaled = strength * intensity;
    // Точка удара смещается от центра тем сильнее, чем громче: тихие удары
    // приходят «отовсюду», громкие имеют явный источник.
    const spread = 0.12 + scaled * 0.3;
    const x = 0.5 + (this.rng() * 2 - 1) * spread;
    const y = 0.5 + (this.rng() * 2 - 1) * spread;

    this.spawn(x, y, scaled, false);
    this.scheduleEchoes(mood, x, y, scaled);
  }

  /** Память: тот же удар повторяется через 1/2 и 1/4 такта, слабее. */
  private scheduleEchoes(mood: MoodVector, x: number, y: number, strength: number): void {
    if (strength < 0.25) return; // слабые удары эха не оставляют, иначе каша
    const barMs = (60000 / Math.max(40, mood.bpm)) * 4;

    for (const division of ECHO_DIVISIONS) {
      if (this.pendingEchoes.length >= MAX_PENDING_ECHOES) break;
      this.pendingEchoes.push({
        atMs: mood.timeMs + barMs * division,
        x,
        y,
        strength: strength * (division === 0.5 ? 0.45 : 0.22),
      });
    }
  }

  private releaseEchoes(mood: MoodVector, intensity: number): void {
    for (let i = this.pendingEchoes.length - 1; i >= 0; i--) {
      const echo = this.pendingEchoes[i];
      if (mood.timeMs < echo.atMs) continue;
      this.pendingEchoes.splice(i, 1);
      // Пропускаем протухшее эхо: после паузы вкладки они бы вышли пачкой.
      if (mood.timeMs - echo.atMs > 400) continue;
      this.spawn(echo.x, echo.y, echo.strength * intensity, true);
    }
  }

  private spawn(x: number, y: number, strength: number, echo: boolean): void {
    if (this.impulses.length >= MAX_IMPULSES) this.impulses.shift();
    const life = 0.45 + strength * 0.75;
    this.impulses.push({
      id: this.nextImpulseId++,
      x: clamp01(x),
      y: clamp01(y),
      strength: clamp01(strength),
      age: 0,
      life,
      radius: 0,
      echo,
      tone: echo ? 1 : 0,
    });

    // Одна и та же волна двигает всё сразу — в этом и смысл «живой сцены».
    this.deformation = clamp01(this.deformation + strength * 0.7);
    this.lightFlash = clamp01(this.lightFlash + strength * (echo ? 0.3 : 0.75));
    const angle = Math.atan2(y - 0.5, x - 0.5);
    // Камеру толкает от точки удара, как отдачей.
    this.cameraKickX -= Math.cos(angle) * strength * 0.035;
    this.cameraKickY -= Math.sin(angle) * strength * 0.035;
    this.cameraKickRoll += (this.rng() * 2 - 1) * strength * 0.03;
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
    // Источник медленно обходит сцену; на быстрых треках — быстрее.
    const orbit = this.orbitPhase + (mood.timeMs / 1000) * (0.08 + mood.bpm / 2400);
    return {
      angle: orbit,
      intensity: clamp01(0.3 + mood.energy * 0.6),
      flash: this.lightFlash,
      warmth: mood.key.mode === 'major' ? clamp01(0.55 + mood.key.confidence * 0.45) : clamp01(0.45 - mood.key.confidence * 0.45),
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

    const rollBase = Math.sin(this.orbitPhase * Math.PI * 2 * 0.5) * (0.01 + substance.axis * 0.03);

    return {
      x: driftX + orbitX + this.cameraKickX,
      y: driftY + orbitY + this.cameraKickY,
      zoom: clamp(1, 1.4, this.zoomDrift + substance.deformation * 0.02),
      roll: rollBase + this.cameraKickRoll,
    };
  }
}
