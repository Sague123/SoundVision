/**
 * Настройки пользователя с наложенными решениями режиссёра.
 *
 * Правило одно: пользователь задаёт потолок, режиссёр работает внутри него.
 * Решение режиссёра умножается на отношение «ползунок пользователя /
 * значение по умолчанию». На умолчаниях режиссёр ведёт свободно, а зритель,
 * которого укачивает и который убрал движение, получает от режиссёра и
 * камеру мягче — режиссёр не может перебить эту настройку.
 *
 * Объект заводится один раз и перезаписывается каждый кадр: копия всех
 * настроек на каждом кадре — это мусор для сборщика в самом горячем месте.
 */

import { defaultSettings, type Settings } from '../settings.ts';
import type { DirectorOutput } from './director.ts';

const DEFAULTS = defaultSettings();

/** Разделы, которые копируются поверхностно: внутри них только числа, флаги и строки. */
const FLAT_SECTIONS = [
  'audio', 'camera', 'generator', 'focus', 'motion', 'quality', 'palette', 'transients',
  'deformation', 'particles', 'light', 'memory', 'sources', 'cover', 'lyrics',
] as const;

export class EffectiveSettings {
  private readonly value: Settings = defaultSettings();

  derive(user: Settings, d: DirectorOutput | null): Settings {
    const e = this.value;
    for (const key of FLAT_SECTIONS) Object.assign(e[key], user[key]);
    // Вложенные объекты — отдельно, иначе поверхностная копия раздела
    // подменила бы их ссылками на пользовательские, и наложение ниже
    // испортило бы настройки самого пользователя.
    e.palette.tuning = Object.assign(this.tuning, user.palette.tuning);
    e.layers.base = Object.assign(this.base, user.layers.base);
    e.layers.genre = Object.assign(this.genre, user.layers.genre);
    e.layers.transient = Object.assign(this.transient, user.layers.transient);
    // Эти значения режиссёр не трогает — можно отдать ссылками.
    e.primitives = user.primitives;
    e.advanced = user.advanced;
    e.debug = user.debug;

    if (!d) return e;

    e.light.bloom = clamp01(d.bloom * ratio(user.light.bloom, DEFAULTS.light.bloom));
    e.light.rays = clamp01(d.rays * ratio(user.light.rays, DEFAULTS.light.rays));
    e.light.rim = clamp01(d.rim * ratio(user.light.rim, DEFAULTS.light.rim));
    e.memory.feedback = clamp01(d.feedback * ratio(user.memory.feedback, DEFAULTS.memory.feedback));
    e.particles.density = clamp01(d.particleDensity * ratio(user.particles.density, DEFAULTS.particles.density));
    e.camera.amount = clamp01(d.cameraAmount * ratio(user.camera.amount, DEFAULTS.camera.amount));
    // Тряску режиссёр может только запретить, но не включить выключенную.
    e.transients.shake = user.transients.shake && d.shake;
    return e;
  }

  private readonly tuning = { ...DEFAULTS.palette.tuning };
  private readonly base = { ...DEFAULTS.layers.base };
  private readonly genre = { ...DEFAULTS.layers.genre };
  private readonly transient = { ...DEFAULTS.layers.transient };
}

/** Во сколько раз пользователь отошёл от умолчания; 0 — выключил совсем. */
function ratio(value: number, def: number): number {
  return def > 0 ? value / def : value > 0 ? 1 : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
