/**
 * Жизненный цикл эффекта.
 *
 * Ни один элемент не включается и не выключается щелчком, если только это
 * не намеренный удар. Эффект проходит состояния
 *
 *   dormant → entering → active → cooling → exiting → dormant
 *
 * а его вес плавно едет к цели по заданной кривой. Режиссёр говорит «войди»,
 * «ослабь», «уйди» — а как это выглядит во времени, решает здесь слот.
 *
 * `cooling` — эффект остаётся, но отступает: так режиссёр сбрасывает
 * сложность кадра, не убирая элемент совсем.
 */

export type LifecycleState = 'dormant' | 'entering' | 'active' | 'cooling' | 'exiting' | 'disabled';

export type TransitionCurve = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

export class EffectSlot {
  state: LifecycleState = 'dormant';
  /** Вес прямо сейчас, 0..1. */
  weight = 0;
  /** Уровень, к которому слот стремится в активной фазе. */
  level = 1;
  private from = 0;
  private to = 0;
  private startedAt = 0;
  private durationMs = 1;
  private curve: TransitionCurve = 'ease-in-out';
  /** Задержка перед стартом движения — так делаются переходы с паузой. */
  private delayMs = 0;

  constructor(readonly id: string) {}

  enter(now: number, level: number, durationMs: number, curve: TransitionCurve = 'ease-out', delayMs = 0): void {
    if (this.state === 'disabled') return;
    this.level = level;
    this.start(now, level, durationMs, curve, delayMs);
    this.state = 'entering';
  }

  /** Сменить уровень, не покидая сцену: усилить или ослабить. */
  retarget(now: number, level: number, durationMs: number): void {
    if (this.state === 'disabled' || this.state === 'dormant' || this.state === 'exiting') return;
    if (Math.abs(level - this.level) < 0.01) return;
    const cooling = level < this.level;
    this.level = level;
    this.start(now, level, durationMs, 'ease-in-out', 0);
    this.state = cooling ? 'cooling' : 'entering';
  }

  exit(now: number, durationMs: number, curve: TransitionCurve = 'ease-in', delayMs = 0): void {
    if (this.state === 'dormant' || this.state === 'disabled' || this.state === 'exiting') return;
    this.start(now, 0, durationMs, curve, delayMs);
    this.state = 'exiting';
  }

  /** Выключен пользователем: уходит и больше не входит, пока не разрешат. */
  disable(now: number): void {
    this.start(now, 0, 500, 'ease-in', 0);
    this.state = 'disabled';
  }

  enable(): void {
    if (this.state === 'disabled') this.state = this.weight > 0.001 ? 'exiting' : 'dormant';
  }

  update(now: number): number {
    const elapsed = now - this.startedAt - this.delayMs;
    if (elapsed <= 0) return this.weight;
    const t = Math.min(1, elapsed / this.durationMs);
    this.weight = this.from + (this.to - this.from) * ease(t, this.curve);

    if (t >= 1) {
      if (this.state === 'entering' || this.state === 'cooling') this.state = 'active';
      else if (this.state === 'exiting') this.state = 'dormant';
    }
    return this.weight;
  }

  get alive(): boolean {
    return this.state !== 'dormant' && this.state !== 'disabled';
  }

  private start(now: number, to: number, durationMs: number, curve: TransitionCurve, delayMs: number): void {
    this.from = this.weight;
    this.to = to;
    this.startedAt = now;
    this.durationMs = Math.max(1, durationMs);
    this.curve = curve;
    this.delayMs = delayMs;
  }
}

export function ease(t: number, curve: TransitionCurve): number {
  switch (curve) {
    case 'linear': return t;
    case 'ease-in': return t * t * t;
    case 'ease-out': return 1 - (1 - t) ** 3;
    case 'ease-in-out': return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }
}

/** Набор слотов по идентификатору — заводятся один раз и переиспользуются. */
export class LifecycleManager {
  private readonly slots = new Map<string, EffectSlot>();
  private readonly list: EffectSlot[] = [];

  slot(id: string): EffectSlot {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = new EffectSlot(id);
      this.slots.set(id, slot);
      this.list.push(slot);
    }
    return slot;
  }

  update(now: number): void {
    for (let i = 0; i < this.list.length; i++) this.list[i].update(now);
  }

  get all(): readonly EffectSlot[] {
    return this.list;
  }

  weight(id: string): number {
    return this.slots.get(id)?.weight ?? 0;
  }
}
