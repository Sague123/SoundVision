/**
 * Переходы — самостоятельные эффекты.
 *
 * Смена сцены через простой кроссфейд двух сложных картинок даёт кашу на
 * полсекунды, и каждый переход выглядит одинаково. Здесь переход задаёт две
 * вещи: как старая сцена отдаёт кадр новой (перекрытие, пауза, кривые) и что
 * происходит с кадром целиком по ходу перехода — наезд, крен, провал в
 * темноту, глитч, вспышка, волна деформации. Движение при этом не рвётся:
 * камера и деформации продолжают идти, переход лишь ложится поверх.
 *
 * Вспышки безопасны: переходы разделены не меньше чем четырьмя секундами,
 * то есть это меньше 0.25 Гц при лимите в 3 Гц, и вспышка — это усиление
 * свечения, а не белый кадр.
 */

import { ease } from './lifecycle.ts';
import type { MusicalState } from './musical-state.ts';

export const TRANSITION_TYPES = [
  'fade', 'dissolve', 'morph', 'zoom', 'tunnel', 'rotation', 'collapse',
  'explosion', 'glitch', 'fragment', 'blackout',
] as const;

export type TransitionType = (typeof TRANSITION_TYPES)[number];

/** Глобальные модификаторы кадра; нейтральные значения — ничего не меняют. */
export interface FrameModifiers {
  /** Провал в темноту, 0..1. */
  blackout: number;
  /** Множитель масштаба кадра, 1 — нейтрально. */
  zoom: number;
  /** Крен, радианы. */
  roll: number;
  glitch: number;
  /** Усиление свечения, 0..1. */
  flash: number;
  /** Добавка к деформациям, 0..1. */
  warp: number;
  /** Выброс частиц, 0..1. */
  particleBurst: number;
  /** Размазывание прошлого кадра, 0..1. */
  smear: number;
}

export function neutralModifiers(): FrameModifiers {
  return { blackout: 0, zoom: 1, roll: 0, glitch: 0, flash: 0, warp: 0, particleBurst: 0, smear: 0 };
}

/** Как старая сцена уходит и новая входит. */
export interface Handover {
  exitMs: number;
  exitDelayMs: number;
  enterMs: number;
  enterDelayMs: number;
  /** Полная длительность перехода — когда модификаторы возвращаются в ноль. */
  totalMs: number;
}

const HANDOVER: Record<TransitionType, Handover> = {
  // Перекрытие: оба слоя видны одновременно недолго.
  fade: { exitMs: 1200, exitDelayMs: 0, enterMs: 1200, enterDelayMs: 200, totalMs: 1400 },
  // Пауза между уходом и входом — кадр на миг пустеет.
  dissolve: { exitMs: 700, exitDelayMs: 0, enterMs: 900, enterDelayMs: 550, totalMs: 1500 },
  morph: { exitMs: 1500, exitDelayMs: 0, enterMs: 1500, enterDelayMs: 100, totalMs: 1700 },
  zoom: { exitMs: 450, exitDelayMs: 150, enterMs: 600, enterDelayMs: 450, totalMs: 1100 },
  tunnel: { exitMs: 700, exitDelayMs: 0, enterMs: 800, enterDelayMs: 500, totalMs: 1400 },
  rotation: { exitMs: 900, exitDelayMs: 0, enterMs: 900, enterDelayMs: 300, totalMs: 1300 },
  collapse: { exitMs: 600, exitDelayMs: 0, enterMs: 800, enterDelayMs: 650, totalMs: 1500 },
  // Удар: старое срезается почти мгновенно, новое вспыхивает сразу.
  explosion: { exitMs: 180, exitDelayMs: 0, enterMs: 300, enterDelayMs: 60, totalMs: 900 },
  glitch: { exitMs: 120, exitDelayMs: 260, enterMs: 160, enterDelayMs: 300, totalMs: 700 },
  fragment: { exitMs: 500, exitDelayMs: 0, enterMs: 700, enterDelayMs: 350, totalMs: 1100 },
  blackout: { exitMs: 250, exitDelayMs: 0, enterMs: 500, enterDelayMs: 450, totalMs: 1100 },
};

export function handoverOf(type: TransitionType): Handover {
  return HANDOVER[type];
}

/** Какие переходы уместны в каком состоянии музыки — глобальное знание. */
export const TRANSITION_FITS: Record<TransitionType, Partial<Record<MusicalState, number>>> = {
  fade: { AMBIENT: 0.8, VOCAL_FOCUS: 0.8, BREAKDOWN: 0.6, IDLE: 0.7, SILENCE: 0.7 },
  dissolve: { AMBIENT: 0.7, BREAKDOWN: 0.8, VOCAL_FOCUS: 0.6 },
  morph: { AMBIENT: 0.6, BUILD: 0.6, VOCAL_FOCUS: 0.7, TRANSITION: 0.8 },
  zoom: { BUILD: 0.7, RISING: 0.8, IMPACT: 0.7, PEAK: 0.5 },
  tunnel: { RISING: 0.8, BUILD: 0.6, PEAK: 0.5 },
  rotation: { RHYTHMIC: 0.7, TRANSITION: 0.6, BUILD: 0.5 },
  collapse: { BREAKDOWN: 0.9, SILENCE: 0.6 },
  explosion: { IMPACT: 1, PEAK: 0.7 },
  glitch: { CHAOTIC: 0.9, IMPACT: 0.6, RHYTHMIC: 0.5 },
  fragment: { IMPACT: 0.7, CHAOTIC: 0.7, PEAK: 0.5 },
  blackout: { SILENCE: 0.8, BREAKDOWN: 0.5 },
};

export class TransitionEngine {
  private type: TransitionType | null = null;
  private startedAt = 0;
  private readonly mods = neutralModifiers();

  get active(): TransitionType | null {
    return this.type;
  }

  start(type: TransitionType, now: number): Handover {
    this.type = type;
    this.startedAt = now;
    return HANDOVER[type];
  }

  /** Модификаторы на этот кадр. Один и тот же объект — без аллокаций. */
  modifiers(now: number): FrameModifiers {
    const m = this.mods;
    m.blackout = 0; m.zoom = 1; m.roll = 0; m.glitch = 0;
    m.flash = 0; m.warp = 0; m.particleBurst = 0; m.smear = 0;
    if (!this.type) return m;

    const spec = HANDOVER[this.type];
    const t = (now - this.startedAt) / spec.totalMs;
    if (t >= 1) {
      this.type = null;
      return m;
    }
    // Колокол: 0 → 1 → 0 по ходу перехода. Пик — в момент смены сцен.
    const bell = Math.sin(Math.PI * clamp01(t));
    const early = clamp01(t / 0.45);
    const late = clamp01((t - 0.45) / 0.55);

    switch (this.type) {
      case 'fade':
        break;
      case 'dissolve':
        m.smear = bell * 0.7;
        break;
      case 'morph':
        m.warp = bell;
        m.smear = bell * 0.4;
        break;
      case 'zoom':
        // Пролёт сквозь кадр: наезд на старое, затем новое выходит из-за спины.
        m.zoom = t < 0.45 ? 1 + ease(early, 'ease-in') * 0.8 : 0.85 + ease(late, 'ease-out') * 0.15;
        m.flash = bell * 0.25;
        break;
      case 'tunnel':
        m.zoom = 1 + bell * 0.6;
        m.roll = bell * 0.35;
        m.smear = bell * 0.6;
        break;
      case 'rotation':
        m.roll = Math.sin(Math.PI * 2 * clamp01(t)) * 0.3;
        break;
      case 'collapse':
        // Старое сжимается в точку и гаснет, новое разворачивается из неё.
        m.zoom = t < 0.45 ? 1 - ease(early, 'ease-in') * 0.6 : 0.4 + ease(late, 'ease-out') * 0.6;
        m.blackout = bell * 0.65;
        break;
      case 'explosion':
        m.flash = Math.max(0, 1 - t * 2.5) * 0.35;
        m.particleBurst = Math.max(0, 1 - t * 3);
        m.zoom = 1 + Math.max(0, 1 - t * 2) * 0.12;
        m.glitch = Math.max(0, 1 - t * 4) * 0.4;
        break;
      case 'glitch':
        m.glitch = bell;
        break;
      case 'fragment':
        m.glitch = bell * 0.5;
        m.particleBurst = early < 1 ? 1 - early : 0;
        m.smear = bell * 0.3;
        break;
      case 'blackout':
        m.blackout = t < 0.3 ? ease(t / 0.3, 'ease-out') * 0.95
          : t < 0.5 ? 0.95
            : 0.95 * (1 - ease((t - 0.5) / 0.5, 'ease-in-out'));
        break;
    }
    return m;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
