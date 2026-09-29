/**
 * Обучение режиссёра вкусу зрителя.
 *
 * Запоминать «зрителю нравится Particle Storm» бесполезно: тот же эффект
 * может быть хорош на тяжёлом дропе и неуместен в тихом куплете. Поэтому
 * каждое наблюдение хранится в контексте, на трёх уровнях сразу:
 *
 *   пользователь — нравится ли это вообще, в любой музыке;
 *   состояние    — нравится ли это в таком моменте (пик, спад, куплет);
 *   контекст     — в таком моменте при такой энергии, басе и голосе.
 *
 * Глобальное знание — какие сцены к какому состоянию подходят в принципе —
 * лежит в описаниях сцен (`fits`) и сюда не пишется.
 *
 * Оценка собирается от общего к частному со «стягиванием»: частный уровень
 * перебивает общий только тогда, когда по нему накопились наблюдения. Одно
 * случайное нажатие в редком контексте не переворачивает всю картину.
 *
 * Никакой большой модели в кадровом цикле: это счётчики с затуханием,
 * запись и чтение — микросекунды.
 */

import type { AudioFeatures } from './audio-features.ts';
import type { MusicalState } from './musical-state.ts';
import type { VisualTrait } from './scenes.ts';

export interface VisualProfile {
  darkness: number;
  complexity: number;
  motion: number;
  particlePreference: number;
  geometryPreference: number;
  organicPreference: number;
  typographyPreference: number;
  glitchPreference: number;
  cameraPreference: number;
  colorPreference: number;
  impactPreference: number;
  minimalism: number;
  surpriseTolerance: number;
}

export const PROFILE_KEYS: Array<keyof VisualProfile> = [
  'darkness', 'complexity', 'motion', 'particlePreference', 'geometryPreference',
  'organicPreference', 'typographyPreference', 'glitchPreference', 'cameraPreference',
  'colorPreference', 'impactPreference', 'minimalism', 'surpriseTolerance',
];

export function neutralProfile(): VisualProfile {
  return Object.fromEntries(PROFILE_KEYS.map((k) => [k, 0.5])) as unknown as VisualProfile;
}

/** Что именно оценивается: сцена, переход, камера, интенсивность, эффект. */
export type ItemKind = 'scene' | 'transition' | 'camera' | 'intensity' | 'effect' | 'particle';
export type ItemId = `${ItemKind}:${string}`;

export interface AudioContextSummary {
  energy: number;
  bass: number;
  transient: number;
  vocal: number;
  flux: number;
}

/** Событие обратной связи в формате §14 — для журнала и для выгрузки. */
export interface FeedbackEvent {
  timestamp: number;
  audioContext: AudioContextSummary;
  musicalState: MusicalState;
  scene: string;
  effect: ItemId;
  parameters?: Record<string, number | string>;
  /** -1..1: насколько понравилось. */
  userFeedback: number;
  kind: 'explicit' | 'implicit';
  /** Откуда сигнал: ответ на вопрос, выключение эффекта, пропуск сцены… */
  signal: string;
}

interface Counter {
  pos: number;
  neg: number;
  /** Время последнего обновления, для затухания. */
  t: number;
}

export interface Preference {
  /** -1..1: не нравится ↔ нравится. */
  value: number;
  /** 0..1: насколько режиссёр в этом уверен. */
  certainty: number;
}

/** Вкус меняется: наблюдение двухнедельной давности весит вдвое меньше. */
const HALF_LIFE_MS = 14 * 24 * 3600 * 1000;
/** Насколько уровень говорит о конкретном моменте: пользователь, состояние, контекст. */
const LEVEL_SPECIFICITY = [0.3, 0.6, 1];
/** Сколько наблюдений нужно уровню, чтобы перебить более общий. */
const SHRINK = 3;
const MAX_EVENTS = 500;
const STORAGE_KEY = 'soundvision.director.memory';
const STORAGE_VERSION = 1;

/** Контекст дискретизируется грубо: тонкая сетка никогда бы не заполнилась. */
export function contextKey(state: MusicalState, a: AudioContextSummary): string {
  const energy = a.energy < 0.35 ? 'lo' : a.energy > 0.7 ? 'hi' : 'mid';
  const bass = a.bass > 0.6 ? 'bass' : 'thin';
  const vocal = a.vocal > 0.45 ? 'vocal' : 'inst';
  return `${state}|${energy}|${bass}|${vocal}`;
}

export function summarize(f: AudioFeatures): AudioContextSummary {
  return {
    energy: f.energy,
    bass: f.bass,
    transient: f.transientStrength,
    vocal: f.vocalLikelihood,
    flux: f.spectralFlux,
  };
}

/** Какие черты профиля двигает оценка того или иного элемента. */
export type TraitResolver = (item: ItemId) => VisualTrait[];

export class PreferenceModel {
  private readonly counters = new Map<string, Counter>();
  private events: FeedbackEvent[] = [];
  profile: VisualProfile = neutralProfile();
  private dirty = false;
  private lastSave = 0;

  constructor(private readonly traitsOf: TraitResolver, private readonly clock: () => number = Date.now) {}

  /** Записать наблюдение. `userFeedback` уже со знаком и силой сигнала. */
  record(event: FeedbackEvent): void {
    const now = this.clock();
    const key = contextKey(event.musicalState, event.audioContext);
    const weight = Math.min(1, Math.abs(event.userFeedback));
    if (weight <= 0) return;
    const positive = event.userFeedback > 0;

    for (const level of this.levels(event.musicalState, key)) {
      const id = `${level}#${event.effect}`;
      const c = this.decayed(id, now);
      if (positive) c.pos += weight;
      else c.neg += weight;
      c.t = now;
      this.counters.set(id, c);
    }

    this.nudgeProfile(event);
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.dirty = true;
  }

  /** Оценка элемента в контексте: от общего уровня к частному. */
  preference(item: ItemId, state: MusicalState, audio: AudioContextSummary): Preference {
    const now = this.clock();
    let value = 0;
    let doubt = 1;
    const levels = this.levels(state, contextKey(state, audio));
    for (let i = 0; i < levels.length; i++) {
      const c = this.decayed(`${levels[i]}#${item}`, now);
      const n = c.pos + c.neg;
      if (n <= 0) continue;
      const mean = (c.pos - c.neg) / n;
      // Частный уровень тянет оценку к себе с силой n/(n + SHRINK).
      value += (mean - value) * (n / (n + SHRINK));
      /*
       * Уверенность — не просто число наблюдений. Двенадцать ответов «да»
       * и «нет» в других контекстах ничего не говорят о незнакомом: раньше
       * это давало уверенность 0.75, и обучение не спрашивало ровно там,
       * где должно. Поэтому вклад уровня весит по его точности (общий
       * уровень — меньше всех) и по согласию ответов внутри него.
       */
      const known = (n / (n + 4)) * LEVEL_SPECIFICITY[i] * (0.4 + 0.6 * Math.abs(mean));
      doubt *= 1 - known;
    }
    return { value, certainty: 1 - doubt };
  }

  get recentEvents(): readonly FeedbackEvent[] {
    return this.events;
  }

  /** Сколько всего наблюдений — по нему видно, учился ли режиссёр вообще. */
  get observationCount(): number {
    return this.events.length;
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as {
        version: number;
        counters: Array<[string, Counter]>;
        events: FeedbackEvent[];
        profile: Partial<VisualProfile>;
      };
      if (data.version !== STORAGE_VERSION) return;
      this.counters.clear();
      for (const [id, c] of data.counters ?? []) {
        if (typeof c?.pos === 'number' && typeof c?.neg === 'number') this.counters.set(id, c);
      }
      this.events = Array.isArray(data.events) ? data.events.slice(-MAX_EVENTS) : [];
      this.profile = { ...neutralProfile(), ...sanitizeProfile(data.profile) };
    } catch {
      // Битая память не должна ронять приложение — начнём учиться заново.
    }
  }

  /** Сохранить, но не чаще раза в несколько секунд: запись в хранилище не бесплатна. */
  save(force = false): void {
    if (!this.dirty) return;
    const now = this.clock();
    if (!force && now - this.lastSave < 4000) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: STORAGE_VERSION,
        counters: [...this.counters.entries()],
        events: this.events,
        profile: this.profile,
      }));
      this.dirty = false;
      this.lastSave = now;
    } catch {
      // Приватный режим или переполненное хранилище: учимся в пределах сеанса.
    }
  }

  reset(): void {
    this.counters.clear();
    this.events = [];
    this.profile = neutralProfile();
    this.dirty = true;
    this.save(true);
  }

  /** Выгрузка памяти целиком — для переноса и разбора. */
  export(): string {
    return JSON.stringify({
      version: STORAGE_VERSION,
      counters: [...this.counters.entries()],
      events: this.events,
      profile: this.profile,
    }, null, 2);
  }

  private levels(state: MusicalState, key: string): string[] {
    return ['user', `state:${state}`, `ctx:${key}`];
  }

  private decayed(id: string, now: number): Counter {
    const c = this.counters.get(id);
    if (!c) return { pos: 0, neg: 0, t: now };
    const k = Math.pow(0.5, Math.max(0, now - c.t) / HALF_LIFE_MS);
    return { pos: c.pos * k, neg: c.neg * k, t: now };
  }

  /**
   * Профиль сдвигается в сторону черт того, что понравилось, и прочь от
   * черт того, что отвергли. Шаг маленький: профиль — медленная величина.
   */
  private nudgeProfile(event: FeedbackEvent): void {
    const rate = 0.06 * Math.min(1, Math.abs(event.userFeedback));
    const dir = event.userFeedback > 0 ? 1 : -1;
    const p = this.profile;
    const move = (key: keyof VisualProfile, towards: number): void => {
      p[key] = clamp01(p[key] + (towards - p[key]) * rate);
    };
    const push = (key: keyof VisualProfile): void => move(key, dir > 0 ? 1 : 0);

    for (const trait of this.traitsOf(event.effect)) {
      switch (trait) {
        case 'particles': push('particlePreference'); break;
        case 'geometry': push('geometryPreference'); break;
        case 'organic': push('organicPreference'); break;
        case 'glitch': push('glitchPreference'); break;
        case 'typography': push('typographyPreference'); break;
        case 'minimal': push('minimalism'); break;
        case 'impact': push('impactPreference'); break;
        case 'dark': push('darkness'); break;
      }
    }

    // Прямые ответы про интенсивность и камеру двигают профиль к выбранному.
    const [kind, value] = event.effect.split(':') as [ItemKind, string];
    if (kind === 'intensity' && dir > 0) {
      const level = Number(value) / 100;
      if (Number.isFinite(level)) {
        move('complexity', level);
        move('impactPreference', level);
      }
    }
    if (kind === 'camera' && dir > 0) {
      const motion = { static: 0.1, smooth: 0.4, orbit: 0.55, forward: 0.6, aggressive: 0.9, impact: 1 }[value];
      if (motion !== undefined) {
        move('motion', motion);
        move('cameraPreference', motion);
      }
    }
    if (event.signal === 'surprise') push('surpriseTolerance');
  }
}

function sanitizeProfile(value: unknown): Partial<VisualProfile> {
  if (!value || typeof value !== 'object') return {};
  const out: Partial<VisualProfile> = {};
  for (const key of PROFILE_KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clamp01(v);
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
