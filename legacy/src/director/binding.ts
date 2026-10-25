/**
 * Привязка параметра эффекта к аудио-признаку.
 *
 * Прямое «размер ← бас» даёт ровно тот визуализатор, от которого уходим:
 * всё дёргается синхронно и одинаково. Здесь у каждой привязки свой
 * характер — кривая, порог, мёртвая зона, отдельные атака и спад, задержка.
 * Одна и та же бочка может мгновенно раздуть частицы и медленно, с запозданием
 * в восьмую долю, качнуть свет.
 *
 * Оценка идёт каждый кадр и не выделяет памяти: состояние огибающей и кольцо
 * задержки заведены при создании.
 */

import { clamp01, follow, type AudioFeatures, type FeatureKey } from './audio-features.ts';

export type BindingCurve = 'linear' | 'ease-in' | 'ease-out' | 'smooth' | 'pow';

export interface BindingSpec {
  source: FeatureKey;
  /** Итоговый множитель после всех преобразований. */
  multiplier?: number;
  /** Смещение, прибавляемое в самом конце. */
  offset?: number;
  curve?: BindingCurve;
  /** Показатель для кривой 'pow'. */
  exponent?: number;
  /** Ниже порога — ноль, выше — растягивается обратно на 0..1. */
  threshold?: number;
  /** Мелкие колебания около нуля гасятся, чтобы тишина не дрожала. */
  deadzone?: number;
  invert?: boolean;
  /** Время нарастания и спада огибающей, секунды. */
  attack?: number;
  release?: number;
  /** Дополнительное сглаживание уже после огибающей, секунды. */
  smoothing?: number;
  /** Задержка, миллисекунды: реакция может отставать, как эхо. */
  delayMs?: number;
  /** Границы результата. */
  clamp?: readonly [number, number];
}

/** Кольцо задержки: 1.5 секунды при 60 Гц с запасом на 100 Гц анализа. */
const DELAY_SLOTS = 160;

export class AudioBinding {
  private envelope = 0;
  private smoothed = 0;
  private readonly delayValues = new Float32Array(DELAY_SLOTS);
  private readonly delayTimes = new Float64Array(DELAY_SLOTS);
  private delayIndex = 0;
  private primed = false;

  constructor(readonly spec: BindingSpec) {}

  /** @returns значение параметра на этот кадр. */
  evaluate(features: AudioFeatures, dtSec: number): number {
    const s = this.spec;
    let v = readFeature(features, s.source);

    // Задержка: пишем текущее значение и читаем то, что было delayMs назад.
    if (s.delayMs && s.delayMs > 0) {
      this.delayValues[this.delayIndex] = v;
      this.delayTimes[this.delayIndex] = features.timeMs;
      this.delayIndex = (this.delayIndex + 1) % DELAY_SLOTS;
      const target = features.timeMs - s.delayMs;
      let found = v;
      // Идём от свежих к старым, первое значение не новее цели — наше.
      for (let step = 1; step <= DELAY_SLOTS; step++) {
        const i = (this.delayIndex - step + DELAY_SLOTS) % DELAY_SLOTS;
        const t = this.delayTimes[i];
        if (t === 0) break;
        found = this.delayValues[i];
        if (t <= target) break;
      }
      v = found;
    }

    if (s.invert) v = 1 - v;

    if (s.deadzone && s.deadzone > 0) {
      v = v <= s.deadzone ? 0 : (v - s.deadzone) / (1 - s.deadzone);
    }
    if (s.threshold && s.threshold > 0) {
      v = v <= s.threshold ? 0 : (v - s.threshold) / (1 - s.threshold);
    }

    v = shape(clamp01(v), s.curve ?? 'linear', s.exponent ?? 2);

    // Огибающая с раздельными атакой и спадом.
    if (!this.primed) {
      this.envelope = v;
      this.smoothed = v;
      this.primed = true;
    }
    const tau = v > this.envelope ? (s.attack ?? 0) : (s.release ?? 0);
    this.envelope += (v - this.envelope) * follow(dtSec, tau);

    this.smoothed += (this.envelope - this.smoothed) * follow(dtSec, s.smoothing ?? 0);

    let result = this.smoothed * (s.multiplier ?? 1) + (s.offset ?? 0);
    if (s.clamp) result = Math.min(s.clamp[1], Math.max(s.clamp[0], result));
    return result;
  }

  reset(): void {
    this.primed = false;
    this.delayTimes.fill(0);
  }
}

export function shape(v: number, curve: BindingCurve, exponent: number): number {
  switch (curve) {
    case 'linear': return v;
    // Медленный старт: тихое почти не реагирует, громкое — сильно.
    case 'ease-in': return v * v;
    // Быстрый старт: даже тихий сигнал сразу заметен.
    case 'ease-out': return 1 - (1 - v) * (1 - v);
    case 'smooth': return v * v * (3 - 2 * v);
    case 'pow': return Math.pow(v, exponent);
  }
}

function readFeature(features: AudioFeatures, key: FeatureKey): number {
  const value = features[key];
  // Тренд живёт в -1..1, остальные в 0..1: приводим к общему диапазону.
  return key === 'energyTrend' ? (value + 1) * 0.5 : value;
}

/**
 * Набор именованных привязок одного модуля. Модуль спрашивает значение по
 * имени параметра; если привязки нет — получает запасное значение.
 *
 * Внутри плоские массивы, а не Map: обход Map создаёт итератор на каждом
 * кадре, а цикл по индексу — ничего.
 */
export class BindingSet {
  private readonly names: string[] = [];
  private readonly bindings: AudioBinding[] = [];
  private readonly values: Float32Array;

  constructor(specs: Readonly<Record<string, BindingSpec>>) {
    for (const [name, spec] of Object.entries(specs)) {
      this.names.push(name);
      this.bindings.push(new AudioBinding(spec));
    }
    this.values = new Float32Array(this.names.length);
  }

  update(features: AudioFeatures, dtSec: number): void {
    for (let i = 0; i < this.bindings.length; i++) {
      this.values[i] = this.bindings[i].evaluate(features, dtSec);
    }
  }

  get(name: string, fallback = 0): number {
    const index = this.names.indexOf(name);
    return index < 0 ? fallback : this.values[index];
  }

  /** Для отладочного оверлея: имя и текущее значение каждой привязки. */
  snapshot(): Array<[string, number]> {
    return this.names.map((name, i) => [name, this.values[i]]);
  }
}
