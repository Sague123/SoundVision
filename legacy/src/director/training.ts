/**
 * Режим обучения: редкие вопросы в неуверенные моменты.
 *
 * Спрашивать постоянно — значит мешать смотреть. Поэтому вопрос появляется,
 * только если одновременно:
 *   - режиссёр не уверен в своём решении (уверенность ниже 0.55);
 *   - момент устойчивый — не удар, не тишина, не смена части;
 *   - с прошлого вопроса прошло не меньше полутора минут.
 *
 * По мере обучения уверенность растёт сама — модель предпочтений даёт всё
 * больший отрыв лучшей сцены, — и вопросы редеют без отдельной логики.
 *
 * Вопрос без показа бессмыслен: пока карточка открыта, варианты по очереди
 * показываются на экране, и зритель выбирает то, что видел, а не название.
 */

import type { ItemId } from './learning.ts';
import type { MusicalState, MusicalStateSnapshot } from './musical-state.ts';
import type { VisualDirector } from './director.ts';
import type { CameraStyle } from './scenes.ts';
import type { TransitionType } from './transitions.ts';

export type QuestionKind = 'scene' | 'intensity' | 'camera' | 'transition';

export interface TrainingOption {
  label: string;
  item: ItemId;
  show(): void;
}

export interface TrainingQuestion {
  kind: QuestionKind;
  prompt: string;
  options: TrainingOption[];
  /** Какой вариант показывается сейчас. */
  showing: number;
  openedAt: number;
  state: MusicalState;
}

const ASK_BELOW = 0.55;
const PREVIEW_MS = 3500;
export const QUESTION_TIMEOUT_MS = 26000;
/** Не донимать сразу после запуска: пусть сначала что-то зазвучит. */
const WARMUP_MS = 20000;
const UNSTABLE: ReadonlySet<MusicalState> = new Set(['IMPACT', 'SILENCE', 'IDLE', 'TRANSITION']);
const ORDER: QuestionKind[] = ['scene', 'intensity', 'camera', 'transition'];
const CAMERA_LABELS: Partial<Record<CameraStyle, string>> = {
  static: 'Статичная', smooth: 'Плавная', aggressive: 'Резкая',
};
const TRANSITION_LABELS: Partial<Record<TransitionType, string>> = {
  morph: 'Перетекание', glitch: 'Глитч', explosion: 'Взрыв',
};

export class TrainingCoach {
  private question: TrainingQuestion | null = null;
  private lastClosedAt = -Infinity;
  private startedAt: number | null = null;
  private turn = 0;
  private asked = 0;
  private answered = 0;

  constructor(private readonly director: VisualDirector) {}

  get current(): TrainingQuestion | null {
    return this.question;
  }

  get stats(): { asked: number; answered: number } {
    return { asked: this.asked, answered: this.answered };
  }

  update(now: number, snap: MusicalStateSnapshot, enabled: boolean, minIntervalSec: number): TrainingQuestion | null {
    if (this.startedAt === null) this.startedAt = now;
    if (!enabled) {
      if (this.question) this.close(now, null);
      return null;
    }

    const q = this.question;
    if (q) {
      if (now - q.openedAt > QUESTION_TIMEOUT_MS) {
        // Не ответили — не учимся: молчание не значит «оба плохи».
        this.close(now, null);
        return null;
      }
      const index = Math.floor((now - q.openedAt) / PREVIEW_MS) % q.options.length;
      if (index !== q.showing) {
        q.showing = index;
        q.options[index].show();
      }
      return q;
    }

    const confident = this.director.decisions.length > 0
      ? this.director.decisions[this.director.decisions.length - 1].confidence
      : 1;
    const ready = now - this.startedAt > WARMUP_MS
      && now - this.lastClosedAt > minIntervalSec * 1000
      && confident < ASK_BELOW
      && !UNSTABLE.has(snap.state)
      && snap.heldMs > 3000;
    if (!ready) return null;

    const question = this.build(ORDER[this.turn % ORDER.length], now, snap.state);
    this.turn++;
    if (!question) return null;
    this.question = question;
    this.asked++;
    question.options[0].show();
    return question;
  }

  /** Ответ: выбранное — плюс, остальные показанные — минус послабее. */
  answer(index: number, now: number): void {
    const q = this.question;
    if (!q || index < 0 || index >= q.options.length) return;
    const chosen = q.options[index];
    this.director.feedback(chosen.item, 1, 'explicit', `обучение: ${q.kind}`);
    for (const [i, option] of q.options.entries()) {
      if (i !== index) this.director.feedback(option.item, -0.5, 'explicit', `обучение: отвергнут ${q.kind}`);
    }
    this.answered++;
    this.close(now, chosen);
  }

  /** «Ни один не подошёл» — все показанные варианты получают минус. */
  rejectAll(now: number): void {
    const q = this.question;
    if (!q) return;
    for (const option of q.options) {
      this.director.feedback(option.item, -0.6, 'explicit', `обучение: ни один (${q.kind})`);
    }
    this.answered++;
    this.close(now, null);
  }

  dismiss(now: number): void {
    this.close(now, null);
  }

  private close(now: number, chosen: TrainingOption | null): void {
    const kind = this.question?.kind;
    this.question = null;
    this.lastClosedAt = now;
    // Предпросмотр снимаем: дальше интенсивность и камеру ведёт уже профиль,
    // в который ответ только что записан.
    this.director.setPreview(null);
    // Выбранная сцена остаётся на экране — иначе ответ ничего бы не изменил.
    if (chosen && kind === 'scene') chosen.show();
  }

  private build(kind: QuestionKind, now: number, state: MusicalState): TrainingQuestion | null {
    const d = this.director;
    const base = { kind, showing: 0, openedAt: now, state };
    switch (kind) {
      case 'scene': {
        const [a, b] = d.candidates(2);
        if (!a || !b) return null;
        return {
          ...base,
          prompt: 'Какая картинка лучше подходит этому моменту?',
          options: [a, b].map((c, i) => ({
            label: `${i === 0 ? 'A' : 'B'} — ${c.scene.name}`,
            item: `scene:${c.scene.id}` as ItemId,
            show: () => d.forceScene(c.scene.id, 'fade'),
          })),
        };
      }
      case 'intensity':
        return {
          ...base,
          prompt: 'Насколько насыщенно?',
          options: [25, 50, 75, 100].map((level) => ({
            label: `${level}%`,
            item: `intensity:${level}` as ItemId,
            show: () => d.setPreview({ intensity: level / 100 }),
          })),
        };
      case 'camera':
        return {
          ...base,
          prompt: 'Какая камера?',
          options: (['static', 'smooth', 'aggressive'] as CameraStyle[]).map((camera) => ({
            label: CAMERA_LABELS[camera] ?? camera,
            item: `camera:${camera}` as ItemId,
            show: () => d.setPreview({ camera }),
          })),
        };
      case 'transition':
        return {
          ...base,
          prompt: 'Какой переход?',
          options: (['morph', 'glitch', 'explosion'] as TransitionType[]).map((type) => ({
            label: TRANSITION_LABELS[type] ?? type,
            item: `transition:${type}` as ItemId,
            show: () => d.pulseTransition(type),
          })),
        };
    }
  }
}
