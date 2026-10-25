/**
 * Музыкальное состояние в реальном времени.
 *
 * Трек заранее не анализируется: состояние выводится из того, что звучит
 * прямо сейчас, и из короткой памяти о последних секундах. Музыкально
 * безошибочным оно быть не обязано — ему достаточно давать режиссёру
 * осмысленный контекст: «идёт нарастание», «только что ударило», «упало».
 *
 * Каждое состояние получает оценку 0..1, оценки сглаживаются и нормируются
 * в вероятности. Переключение — только с гистерезисом: новое состояние
 * должно обойти текущее с запасом, а текущее — отстоять минимальное время.
 * Иначе на границе двух состояний картинка дёргалась бы каждые 100 мс.
 */

import { follow, type AudioFeatures } from './audio-features.ts';

export const MUSICAL_STATES = [
  'IDLE', 'SILENCE', 'AMBIENT', 'BUILD', 'RISING', 'IMPACT', 'PEAK',
  'RHYTHMIC', 'VOCAL_FOCUS', 'BREAKDOWN', 'TRANSITION', 'CHAOTIC',
] as const;

export type MusicalState = (typeof MUSICAL_STATES)[number];

export interface MusicalStateSnapshot {
  state: MusicalState;
  previous: MusicalState;
  /** Вероятность текущего состояния — уверенность машины в нём. */
  confidence: number;
  /** Сколько миллисекунд держится текущее состояние. */
  heldMs: number;
  /** Сглаженные вероятности всех состояний. */
  probabilities: Readonly<Record<MusicalState, number>>;
  /** Сменилось ли состояние на этом шаге. */
  changed: boolean;
}

/** Минимальное время в состоянии до того, как его можно покинуть. */
const MIN_DWELL_MS: Record<MusicalState, number> = {
  IDLE: 1500, SILENCE: 600, AMBIENT: 2500, BUILD: 2000, RISING: 1200,
  IMPACT: 0, PEAK: 2500, RHYTHMIC: 2500, VOCAL_FOCUS: 2500,
  BREAKDOWN: 2000, TRANSITION: 1200, CHAOTIC: 1500,
};

/** Удар — событие, а не часть трека: он сам заканчивается. */
const IMPACT_MAX_MS = 1400;
/** Между двумя ударами не меньше: иначе дробь читается как череда дропов. */
const IMPACT_COOLDOWN_MS = 2500;
/** Насколько новое состояние должно обойти текущее. */
const SWITCH_MARGIN = 0.12;

export class MusicalStateMachine {
  private state: MusicalState = 'IDLE';
  private previous: MusicalState = 'IDLE';
  private since = 0;
  private readonly scores = Object.fromEntries(
    MUSICAL_STATES.map((s) => [s, 0]),
  ) as Record<MusicalState, number>;
  private readonly probabilities = Object.fromEntries(
    MUSICAL_STATES.map((s) => [s, 0]),
  ) as Record<MusicalState, number>;

  /** Недавний максимум энергии — от него меряется «упало». */
  private recentHigh = 0;
  /** Сколько длится тишина, мс. */
  private silentFor = 0;
  /** Устойчивая энергия: медленная, пик не делает из неё PEAK. */
  private sustained = 0;
  private lastImpactAt = -Infinity;
  private prevImpact = 0;
  private started = false;
  private readonly snapshot: MusicalStateSnapshot = {
    state: 'IDLE', previous: 'IDLE', confidence: 0, heldMs: 0,
    probabilities: this.probabilities, changed: false,
  };

  update(f: AudioFeatures): MusicalStateSnapshot {
    const now = f.timeMs;
    if (!this.started) {
      this.since = now;
      this.started = true;
    }
    const dt = this.lastTime === null ? 0.016 : Math.min(0.1, Math.max(0.001, (now - this.lastTime) / 1000));
    this.lastTime = now;

    this.silentFor = f.silenceLevel > 0.85 ? this.silentFor + dt * 1000 : 0;
    // Полторы секунды: пик признаётся через пару секунд дропа, а не через шесть.
    this.sustained += (f.energy - this.sustained) * follow(dt, 1.5);
    // Максимум держится секунд десять и медленно отпускает.
    this.recentHigh = Math.max(f.energy, this.recentHigh - dt * 0.03);

    const raw = this.raw(f);
    for (const s of MUSICAL_STATES) {
      // Удар не сглаживается: он должен срабатывать в тот же кадр.
      const tau = s === 'IMPACT' ? 0 : 0.45;
      this.scores[s] += (raw[s] - this.scores[s]) * follow(dt, tau);
    }

    let total = 0;
    for (const s of MUSICAL_STATES) total += this.scores[s];
    for (const s of MUSICAL_STATES) {
      this.probabilities[s] = total > 1e-6 ? this.scores[s] / total : 1 / MUSICAL_STATES.length;
    }

    const changed = this.decide(now);
    const snap = this.snapshot;
    snap.state = this.state;
    snap.previous = this.previous;
    snap.confidence = this.probabilities[this.state];
    snap.heldMs = now - this.since;
    snap.changed = changed;
    return snap;
  }

  private lastTime: number | null = null;

  /** Сырые оценки состояний — каждая прямо из назначения состояния. */
  private raw(f: AudioFeatures): Record<MusicalState, number> {
    const loud = 1 - f.silenceLevel;
    const rising = Math.max(0, f.energyTrend);
    const falling = Math.max(0, -f.energyTrend);
    const drop = Math.max(0, this.recentHigh - f.energy);
    const steady = 1 - Math.min(1, Math.abs(f.energyTrend) * 2);

    // Один и тот же объект на каждом кадре: аудио-цикл не должен мусорить.
    const r = this.rawScores;
    // До первого звука и после долгой тишины.
    r.IDLE = this.silentFor > 8000 ? 1 : 0;
    r.SILENCE = f.silenceLevel > 0.6 ? f.silenceLevel : 0;
    // Тихо и ровно. Растущая энергия — уже не фон, а начало нарастания:
    // без этого множителя всё нарастание читалось как «эмбиент».
    r.AMBIENT = loud * (1 - f.energy) ** 2 * (1 - f.rhythmicDensity) * (1 - f.transientStrength * 0.6)
      * (1 - clamp(rising * 2.5));
    // Нарастание: энергия растёт, удары учащаются, но пика ещё нет.
    // На уже высокой энергии рост — это волнение внутри пика, а не нарастание.
    r.BUILD = loud * clamp(rising * 2.4) * (0.55 + f.rhythmicDensity * 0.45)
      * (1 - clamp((this.sustained - 0.7) * 4));
    // Подход к дропу: крутой рост уже на высокой энергии.
    // На плато высокой энергии это уже не подход, а сам пик.
    r.RISING = loud * clamp((rising - 0.25) * 3) * f.energy * (1 - clamp((this.sustained - 0.75) * 4));
    // Удар: резкий скачок энергии вместе с атакой.
    r.IMPACT = f.energyJump > 0.35 && f.transientStrength > 0.4
      ? clamp(f.energyJump * 0.7 + f.transientStrength * 0.5)
      : 0;
    // Пик: высокая энергия держится, а не проскочила.
    r.PEAK = loud * clamp((this.sustained - 0.55) * 2.5) * (0.5 + steady * 0.5);
    r.RHYTHMIC = loud * f.rhythmicDensity * f.beatConfidence * steady * (0.4 + f.energy * 0.6);
    r.VOCAL_FOCUS = loud * f.vocalLikelihood * (1 - Math.max(0, this.sustained - 0.7) * 2);
    // Спад: энергия заметно ниже недавнего максимума.
    r.BREAKDOWN = loud * clamp((drop - 0.25) * 2.5) * (0.5 + falling) * (1 - f.energy * 0.5);
    // Музыка меняется, но без направления: много нового, тренда нет.
    r.TRANSITION = loud * f.spectralFlux * f.dynamicRange * steady;
    r.CHAOTIC = loud * f.spectralFlux * f.zeroCrossingRate * f.rhythmicDensity * (0.5 + f.dynamicRange);
    return r;
  }

  private readonly rawScores = Object.fromEntries(
    MUSICAL_STATES.map((s) => [s, 0]),
  ) as Record<MusicalState, number>;

  private decide(now: number): boolean {
    const held = now - this.since;
    let best: MusicalState = this.state;
    let bestScore = -1;
    for (const s of MUSICAL_STATES) {
      if (this.probabilities[s] > bestScore) {
        bestScore = this.probabilities[s];
        best = s;
      }
    }

    // Удар — вне очереди: минимального времени у текущего не ждёт, но и
    // сам не повторяется чаще раза в секунду.
    // Срабатываем по фронту: оценка должна пересечь порог снизу вверх. Иначе
    // один длинный переход засчитывался бы ударом раз за разом.
    const impact = this.scores.IMPACT;
    const rose = impact > 0.5 && this.prevImpact <= 0.5;
    this.prevImpact = impact;
    if (this.state !== 'IMPACT' && rose && now - this.lastImpactAt > IMPACT_COOLDOWN_MS) {
      this.lastImpactAt = now;
      return this.enter('IMPACT', now);
    }

    if (this.state === 'IMPACT') {
      if (held < IMPACT_MAX_MS) return false;
      // После удара — туда, куда тянет сильнее всего, кроме самого удара.
      let next: MusicalState = 'PEAK';
      let nextScore = -1;
      for (const s of MUSICAL_STATES) {
        if (s === 'IMPACT') continue;
        if (this.probabilities[s] > nextScore) {
          nextScore = this.probabilities[s];
          next = s;
        }
      }
      return this.enter(next, now);
    }

    if (best === this.state) return false;
    if (held < MIN_DWELL_MS[this.state]) return false;

    const current = this.probabilities[this.state];
    // Уходим, если соперник обошёл с запасом или текущее почти пропало.
    if (bestScore > current + SWITCH_MARGIN || current < 0.05) {
      return this.enter(best, now);
    }
    return false;
  }

  private enter(state: MusicalState, now: number): boolean {
    if (state === this.state) return false;
    this.previous = this.state;
    this.state = state;
    this.since = now;
    return true;
  }
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
