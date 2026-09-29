/**
 * Панель режиссёра и карточка вопроса обучения.
 *
 * Инструмент, а не игрушка: тёмная, узкая, без карточек и неона. Показывает
 * то, что нужно, чтобы понимать, почему картинка сейчас такая — в каком
 * состоянии музыка, насколько режиссёр уверен, какая сцена и что в ней
 * активно, что он решил последним.
 *
 * DOM строится один раз; обновление — только текст и ширины, не чаще десяти
 * раз в секунду. Перестраивать узлы на каждом кадре — лишняя работа для
 * вёрстки в самом горячем месте.
 */

import type { DirectorStep } from '../director/runtime.ts';
import type { VisualProfile } from '../director/learning.ts';
import { QUESTION_TIMEOUT_MS } from '../director/training.ts';
import type { Settings } from '../settings.ts';

const UPDATE_MS = 100;
/** Какие черты профиля показывать — самые наглядные из тринадцати. */
const DNA: Array<[keyof VisualProfile, string]> = [
  ['complexity', 'Сложность'], ['motion', 'Движение'], ['darkness', 'Темнота'],
  ['particlePreference', 'Частицы'], ['geometryPreference', 'Геометрия'], ['glitchPreference', 'Глитч'],
];
const ACTIVE_ROWS = 5;
const STATE_LABELS: Record<string, string> = {
  IDLE: 'Ожидание', SILENCE: 'Тишина', AMBIENT: 'Фон', BUILD: 'Нарастание', RISING: 'Подъём',
  IMPACT: 'Удар', PEAK: 'Пик', RHYTHMIC: 'Ритм', VOCAL_FOCUS: 'Голос', BREAKDOWN: 'Спад',
  TRANSITION: 'Переход', CHAOTIC: 'Хаос',
};

interface Bar {
  fill: HTMLElement;
  value: HTMLElement;
  mark?: HTMLElement;
}

export class DirectorHud {
  readonly element = document.createElement('aside');
  readonly questionElement = document.createElement('div');
  private readonly mode = document.createElement('span');
  private readonly training = document.createElement('span');
  private readonly state = document.createElement('div');
  private readonly ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  private readonly ringValue = document.createElement('span');
  private readonly scene = document.createElement('div');
  private readonly decision = document.createElement('div');
  private readonly bars = new Map<string, Bar>();
  private readonly active: Array<{ row: HTMLElement; name: HTMLElement; fill: HTMLElement }> = [];
  private readonly dna = new Map<keyof VisualProfile, { fill: HTMLElement; value: HTMLElement }>();
  private readonly lessons = document.createElement('span');
  private readonly questionPrompt = document.createElement('div');
  private readonly questionOptions = document.createElement('div');
  private readonly questionTimer = document.createElement('div');
  private lastUpdate = -Infinity;
  private renderedQuestion: object | null = null;

  constructor(private readonly onAnswer: (index: number) => void, private readonly onReject: () => void) {
    this.element.className = 'director director--hidden';
    this.element.innerHTML = '';

    const head = el('div', 'director__head');
    const title = el('div', 'director__title', 'Visual Director');
    this.mode.className = 'director__badge';
    this.training.className = 'director__badge director__badge--dim';
    head.append(title, this.mode, this.training);

    const core = el('div', 'director__core');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 44 44');
    svg.classList.add('director__ring');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const c of [track, this.ring]) {
      c.setAttribute('cx', '22');
      c.setAttribute('cy', '22');
      c.setAttribute('r', '19');
    }
    track.setAttribute('class', 'director__ring-track');
    this.ring.setAttribute('class', 'director__ring-fill');
    this.ring.setAttribute('stroke-dasharray', String(2 * Math.PI * 19));
    svg.append(track, this.ring);
    const ringBox = el('div', 'director__ring-box');
    this.ringValue.className = 'director__ring-value';
    ringBox.append(svg, this.ringValue);
    const stateBox = el('div', 'director__state-box');
    stateBox.append(el('div', 'director__label', 'Состояние'), this.state);
    this.state.className = 'director__state';
    core.append(ringBox, stateBox);

    const bars = el('div', 'director__bars');
    for (const [key, label] of [
      ['energy', 'Энергия'], ['bass', 'Бас'], ['transient', 'Атака'], ['vocal', 'Голос'], ['complexity', 'Сложность'],
    ] as const) {
      const row = el('div', 'director__bar');
      const name = el('span', 'director__bar-name', label);
      const track = el('span', 'director__bar-track');
      const fill = el('span', 'director__bar-fill');
      track.append(fill);
      let mark: HTMLElement | undefined;
      if (key === 'complexity') {
        mark = el('span', 'director__bar-mark');
        track.append(mark);
      }
      const value = el('span', 'director__bar-value');
      row.append(name, track, value);
      bars.append(row);
      this.bars.set(key, { fill, value, mark });
    }

    const sceneBox = el('div', 'director__section');
    sceneBox.append(el('div', 'director__label', 'Сцена'), this.scene);
    this.scene.className = 'director__scene';

    const activeBox = el('div', 'director__section');
    activeBox.append(el('div', 'director__label', 'Активно'));
    for (let i = 0; i < ACTIVE_ROWS; i++) {
      const row = el('div', 'director__active');
      const name = el('span', 'director__active-name');
      const track = el('span', 'director__bar-track');
      const fill = el('span', 'director__bar-fill');
      track.append(fill);
      row.append(name, track);
      activeBox.append(row);
      this.active.push({ row, name, fill });
    }

    // Визуальная ДНК: профиль вкуса, который режиссёр выучил. По нему видно,
    // что обучение вообще идёт, а не просто копит нажатия.
    const dnaBox = el('div', 'director__section');
    const dnaHead = el('div', 'director__label');
    dnaHead.append('Визуальная ДНК ', this.lessons);
    this.lessons.className = 'director__lessons';
    dnaBox.append(dnaHead);
    for (const [key, label] of DNA) {
      const row = el('div', 'director__bar');
      const name = el('span', 'director__bar-name', label);
      const track = el('span', 'director__bar-track');
      const fill = el('span', 'director__bar-fill director__bar-fill--dna');
      track.append(fill);
      const value = el('span', 'director__bar-value');
      row.append(name, track, value);
      dnaBox.append(row);
      this.dna.set(key, { fill, value });
    }

    const decisionBox = el('div', 'director__section');
    decisionBox.append(el('div', 'director__label', 'Последнее решение'), this.decision);
    this.decision.className = 'director__decision';

    const keys = el('div', 'director__keys',
      'N — другая сцена · L — нравится · X — не то · T — обучение · H — скрыть');

    this.element.append(head, core, bars, sceneBox, activeBox, dnaBox, decisionBox, keys);

    // Карточка вопроса.
    this.questionElement.className = 'director-question director-question--hidden';
    this.questionPrompt.className = 'director-question__prompt';
    this.questionOptions.className = 'director-question__options';
    this.questionTimer.className = 'director-question__timer';
    const reject = el('button', 'director-question__none', '0 — ни один');
    (reject as HTMLButtonElement).type = 'button';
    reject.addEventListener('click', () => this.onReject());
    const label = el('div', 'director-question__label', 'Обучение режиссёра');
    this.questionElement.append(label, this.questionPrompt, this.questionOptions, reject, this.questionTimer);
  }

  setVisible(visible: boolean): void {
    this.element.classList.toggle('director--hidden', !visible);
  }

  update(step: DirectorStep | null, settings: Settings, nowMs: number): void {
    this.updateQuestion(step, nowMs);
    if (this.element.classList.contains('director--hidden')) return;
    if (nowMs - this.lastUpdate < UPDATE_MS) return;
    this.lastUpdate = nowMs;

    const d = settings.director;
    this.mode.textContent = { auto: 'Авто', semi: 'Полуавто', manual: 'Вручную' }[d.mode];
    this.training.textContent = d.training ? 'Обучение: вкл' : 'Обучение: выкл';
    this.training.classList.toggle('director__badge--dim', !d.training);

    if (!step) {
      this.state.textContent = 'Нет звука';
      return;
    }
    const out = step.output;
    this.state.textContent = STATE_LABELS[step.state.state] ?? step.state.state;

    const confidence = out ? out.confidence : step.state.confidence;
    const circumference = 2 * Math.PI * 19;
    this.ring.setAttribute('stroke-dashoffset', String(circumference * (1 - confidence)));
    this.ringValue.textContent = `${Math.round(confidence * 100)}%`;

    const f = step.features;
    this.setBar('energy', f.energy);
    this.setBar('bass', f.bass);
    this.setBar('transient', f.transientStrength);
    this.setBar('vocal', f.vocalLikelihood);
    this.setBar('complexity', out?.complexity ?? 0, out?.targetComplexity);

    this.scene.textContent = out ? out.scene.name : 'Режиссёр выключен';
    this.element.classList.toggle('director--surprise', Boolean(out?.surprise));
  }

  /** Активные эффекты, профиль и последнее решение — их отдаёт сам режиссёр. */
  updateDetails(
    effects: Array<{ id: string; weight: number }>,
    decision: string,
    profile?: VisualProfile,
    lessons = 0,
  ): void {
    if (profile) {
      for (const [key] of DNA) {
        const bar = this.dna.get(key);
        if (!bar) continue;
        const v = profile[key];
        bar.fill.style.width = `${Math.round(v * 100)}%`;
        bar.value.textContent = `${Math.round(v * 100)}`;
      }
      this.lessons.textContent = lessons > 0 ? `· уроков ${lessons}` : '· пока не учился';
    }
    for (let i = 0; i < ACTIVE_ROWS; i++) {
      const slot = this.active[i];
      const effect = effects[i];
      slot.row.hidden = !effect;
      if (!effect) continue;
      slot.name.textContent = effect.id.replace(/^prim:/, '');
      slot.fill.style.width = `${Math.round(effect.weight * 100)}%`;
    }
    this.decision.textContent = decision || '—';
  }

  private setBar(key: string, value: number, target?: number): void {
    const bar = this.bars.get(key);
    if (!bar) return;
    const v = Math.max(0, Math.min(1, value));
    bar.fill.style.width = `${Math.round(v * 100)}%`;
    bar.value.textContent = `${Math.round(v * 100)}`;
    if (bar.mark && target !== undefined) bar.mark.style.left = `${Math.round(target * 100)}%`;
  }

  private updateQuestion(step: DirectorStep | null, nowMs: number): void {
    const q = step?.question ?? null;
    this.questionElement.classList.toggle('director-question--hidden', !q);
    if (!q) {
      this.renderedQuestion = null;
      return;
    }
    if (this.renderedQuestion !== q) {
      this.renderedQuestion = q;
      this.questionPrompt.textContent = q.prompt;
      this.questionOptions.replaceChildren();
      q.options.forEach((option, index) => {
        const button = el('button', 'director-question__option', `${index + 1} — ${option.label}`) as HTMLButtonElement;
        button.type = 'button';
        button.addEventListener('click', () => this.onAnswer(index));
        this.questionOptions.append(button);
      });
    }
    [...this.questionOptions.children].forEach((child, index) => {
      child.classList.toggle('director-question__option--showing', index === q.showing);
    });
    const left = 1 - Math.min(1, (nowMs - q.openedAt) / QUESTION_TIMEOUT_MS);
    this.questionTimer.style.transform = `scaleX(${left.toFixed(3)})`;
  }
}

function el(tag: string, className: string, text = ''): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
