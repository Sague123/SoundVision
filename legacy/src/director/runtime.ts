/**
 * Режиссёр целиком: звук → признаки → музыкальное состояние → решения →
 * вопросы обучения. Приложение вызывает `step` раз в кадр и получает всё,
 * что нужно рендеру и панели.
 *
 * Собран в один класс не ради удобства проводки, а чтобы проверки гоняли
 * ровно тот же конвейер, что и живое приложение, — без браузера.
 */

import type { MoodVector } from '../audio/mood-vector.ts';
import type { Settings } from '../settings.ts';
import { AudioFeatureEngine, type AudioFeatures } from './audio-features.ts';
import { VisualDirector, type DirectorConfig, type DirectorOutput } from './director.ts';
import { PreferenceModel, type ItemId } from './learning.ts';
import { MusicalStateMachine, type MusicalStateSnapshot } from './musical-state.ts';
import { SCENES, type VisualTrait } from './scenes.ts';
import { TrainingCoach, type TrainingQuestion } from './training.ts';

export interface DirectorStep {
  features: AudioFeatures;
  state: MusicalStateSnapshot;
  /** null — режиссёр выключен (ручной режим). */
  output: DirectorOutput | null;
  question: TrainingQuestion | null;
  /** Сколько заняли анализ признаков и решение, мс — для отладки. */
  audioMs: number;
  directorMs: number;
}

/** Черты элемента — по ним обучение двигает профиль зрителя. */
function traitsOf(item: ItemId): VisualTrait[] {
  const [kind, id] = item.split(':');
  if (kind === 'scene') return SCENES.find((s) => s.id === id)?.traits ?? [];
  if (kind === 'transition') {
    if (id === 'glitch' || id === 'fragment') return ['glitch'];
    if (id === 'explosion' || id === 'zoom') return ['impact'];
    if (id === 'fade' || id === 'dissolve') return ['minimal'];
    return ['organic'];
  }
  if (kind === 'particle') return ['particles'];
  return [];
}

export class DirectorRuntime {
  readonly features = new AudioFeatureEngine();
  readonly states = new MusicalStateMachine();
  readonly model: PreferenceModel;
  readonly director: VisualDirector;
  readonly coach: TrainingCoach;
  private lastTime: number | null = null;

  constructor(options: { persist?: boolean; clock?: () => number } = {}) {
    this.model = new PreferenceModel(traitsOf, options.clock);
    if (options.persist !== false) this.model.load();
    this.director = new VisualDirector(this.model);
    this.coach = new TrainingCoach(this.director);
  }

  step(mood: MoodVector, settings: Settings): DirectorStep {
    const t0 = performance.now();
    const features = this.features.update(mood);
    const state = this.states.update(features);
    const t1 = performance.now();

    const dt = this.lastTime === null ? mood.deltaMs / 1000 : Math.max(0.001, (mood.timeMs - this.lastTime) / 1000);
    this.lastTime = mood.timeMs;

    const d = settings.director;
    let output: DirectorOutput | null = null;
    let question: TrainingQuestion | null = null;
    if (d.mode !== 'manual') {
      output = this.director.update(features, state, this.config(settings), Math.min(0.1, dt));
      question = this.coach.update(mood.timeMs, state, d.training, d.trainingIntervalSec);
    }
    const t2 = performance.now();
    this.model.save();

    return {
      features, state, output, question,
      audioMs: t1 - t0,
      directorMs: t2 - t1,
    };
  }

  config(settings: Settings): DirectorConfig {
    const d = settings.director;
    return {
      mode: d.mode,
      lockedScene: d.lockedScene,
      isDisabled: (id) => settings.primitives[id]?.enabled === false,
      allowSurprise: d.surprise,
      complexityBias: d.complexityBias,
      minSceneSec: settings.focus.soloMinSec,
      maxSceneSec: Math.max(settings.focus.soloMinSec + 1, settings.focus.soloMaxSec),
    };
  }

  // --- обратная связь из интерфейса -----------------------------------------

  /** Зритель попросил другую сцену: текущая получает минус. */
  skip(now: number): string | null {
    const previous = this.director.currentScene.id;
    this.director.feedback(`scene:${previous}`, -0.7, 'implicit', 'пропуск сцены');
    void now;
    return this.director.skipScene();
  }

  like(): void {
    this.director.feedback(`scene:${this.director.currentScene.id}`, 1, 'explicit', 'нравится');
  }

  /** «Не то» — минус и сразу смена. */
  reject(now: number): string | null {
    this.director.feedback(`scene:${this.director.currentScene.id}`, -1, 'explicit', 'не нравится');
    void now;
    return this.director.skipScene();
  }

  /** Пользователь выключил или включил модуль в панели. */
  effectToggled(id: string, enabled: boolean): void {
    this.director.feedback(`effect:${id}`, enabled ? 0.5 : -1, 'implicit', enabled ? 'включил эффект' : 'выключил эффект');
  }

  /** Пользователь сдвинул ползунок интенсивности. */
  intensityChanged(delta: number): void {
    if (Math.abs(delta) < 0.02) return;
    const value = Math.max(-0.4, Math.min(0.4, delta * 2));
    this.director.feedback(`scene:${this.director.currentScene.id}`, value, 'implicit',
      delta > 0 ? 'добавил интенсивности' : 'убавил интенсивность');
  }

  presetSwitched(): void {
    this.director.feedback(`scene:${this.director.currentScene.id}`, -0.3, 'implicit', 'сменил пресет');
  }

  flush(): void {
    this.model.save(true);
  }
}
