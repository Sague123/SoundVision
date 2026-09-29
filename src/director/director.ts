/**
 * Визуальный режиссёр.
 *
 * Не визуализатор «бас → всё больше», а режиссёр: музыка сменилась — сменился
 * визуальный язык. Решения принимаются 2-10 раз в секунду, а не в каждом
 * кадре; между решениями кадр ведут жизненные циклы эффектов и привязки к
 * звуку, так что всё движется плавно.
 *
 * Что решается:
 *  - какая сцена ведёт кадр и когда её сменить;
 *  - каким переходом;
 *  - какой вес у каждого слоя в текущем музыкальном состоянии;
 *  - какая сложность кадра уместна и что приглушить, если перебор;
 *  - как агрессивна камера, сколько частиц, выходит ли вперёд текст;
 *  - когда позволить себе редкий сюрприз.
 *
 * Выбор сцены — это оценка по формуле из §10:
 *   уместность в состоянии + совместимость со звуком + вкус зрителя
 *   + новизна − недавнее использование − перегрузка кадра.
 */

import { mulberry32 } from '../render/seed.ts';
import type { ParticleType } from '../render/particles.ts';
import { ALL_PRIMITIVE_IDS, type PrimitiveId } from '../render/primitives/types.ts';
import { clamp01, follow, type AudioFeatures, type FeatureKey } from './audio-features.ts';
import { BindingSet } from './binding.ts';
import { LifecycleManager, type TransitionCurve } from './lifecycle.ts';
import { summarize, type ItemId, type PreferenceModel, type VisualProfile } from './learning.ts';
import type { MusicalState, MusicalStateSnapshot } from './musical-state.ts';
import {
  PRIMITIVE_COMPLEXITY, SCENES, TARGET_COMPLEXITY, findScene,
  type CameraStyle, type LayerRole, type SceneDef, type VisualTrait,
} from './scenes.ts';
import {
  TRANSITION_FITS, TRANSITION_TYPES, TransitionEngine,
  type FrameModifiers, type TransitionType,
} from './transitions.ts';

export type DirectorMode = 'auto' | 'semi' | 'manual';

/** Что показывается зрителю в предпросмотре вопроса обучения. */
export interface Preview {
  camera?: CameraStyle;
  /** 0..1 — 25/50/75/100%. */
  intensity?: number;
}

export interface DirectorConfig {
  mode: DirectorMode;
  /** В полуавтомате сцену держит пользователь; null — режиссёр свободен. */
  lockedScene: string | null;
  isDisabled(id: PrimitiveId): boolean;
  allowSurprise: boolean;
  /** Ручной сдвиг желаемой сложности, -0.3..0.3. */
  complexityBias: number;
  /** Сколько сцена держится минимум и максимум, секунды. */
  minSceneSec: number;
  maxSceneSec: number;
}

export interface VisualDecision {
  at: number;
  state: MusicalState;
  scene: string;
  activate: string[];
  strengthen: string[];
  weaken: string[];
  exit: string[];
  transition: TransitionType | null;
  camera: CameraStyle;
  globalEnergy: number;
  confidence: number;
  reason: string;
}

export interface SceneCandidate {
  scene: SceneDef;
  score: number;
}

/** Всё, что рендер читает у режиссёра в каждом кадре. Объект переиспользуется. */
export interface DirectorOutput {
  weights: Map<PrimitiveId, number>;
  particles: ParticleType[];
  particleDensity: number;
  bloom: number;
  rays: number;
  rim: number;
  camera: CameraStyle;
  /** Множитель к амплитуде камеры из настроек: пользовательский потолок сохраняется. */
  cameraAmount: number;
  shake: boolean;
  feedback: number;
  /** Насколько вперёд выходит текст песни, 0..1. */
  typography: number;
  modifiers: FrameModifiers;
  complexity: number;
  targetComplexity: number;
  scene: SceneDef;
  confidence: number;
  surprise: boolean;
  /** Гармоническая схема, которую выбрала вариация сцены. */
  harmonyId: string | null;
  params: BindingSet;
}

/** Акценты слоёв по состоянию: так дроп и куплет выглядят по-разному в одной сцене. */
interface Emphasis {
  primary: number;
  secondary: number;
  background: number;
  particles: number;
  typography: number;
}

const EMPHASIS: Record<MusicalState, Emphasis> = {
  IDLE: { primary: 0.4, secondary: 0, background: 0.2, particles: 0.1, typography: 0.5 },
  SILENCE: { primary: 0.4, secondary: 0, background: 0.2, particles: 0.1, typography: 0.5 },
  AMBIENT: { primary: 0.8, secondary: 0.4, background: 0.6, particles: 0.35, typography: 0.7 },
  BUILD: { primary: 0.9, secondary: 0.5, background: 0.4, particles: 0.55, typography: 0.5 },
  RISING: { primary: 0.95, secondary: 0.55, background: 0.35, particles: 0.75, typography: 0.35 },
  IMPACT: { primary: 1, secondary: 0.6, background: 0.3, particles: 0.9, typography: 0.1 },
  PEAK: { primary: 1, secondary: 0.6, background: 0.3, particles: 0.85, typography: 0.15 },
  RHYTHMIC: { primary: 1, secondary: 0.6, background: 0.3, particles: 0.6, typography: 0.4 },
  VOCAL_FOCUS: { primary: 0.55, secondary: 0.3, background: 0.6, particles: 0.3, typography: 1 },
  BREAKDOWN: { primary: 0.7, secondary: 0.3, background: 0.5, particles: 0.25, typography: 0.8 },
  TRANSITION: { primary: 0.9, secondary: 0.5, background: 0.4, particles: 0.5, typography: 0.4 },
  CHAOTIC: { primary: 1, secondary: 0.8, background: 0.4, particles: 0.9, typography: 0.1 },
};

const CAMERA_AMOUNT: Record<CameraStyle, number> = {
  static: 0.06, smooth: 0.35, orbit: 0.55, forward: 0.6, aggressive: 0.85, impact: 1,
};

/** Переходы не чаще — это и фокус, и безопасность вспышек (< 0.25 Гц). */
const TRANSITION_COOLDOWN_MS = 4000;
const DECISION_INTERVAL_MS = 250;
const FATIGUE_WINDOW_MS = 15000;
const DECISION_LOG = 12;

/** Границы частей трека, на которых смена сцены особенно уместна. */
function isSectionBoundary(from: MusicalState, to: MusicalState): boolean {
  const drop = (from === 'BUILD' || from === 'RISING') && (to === 'IMPACT' || to === 'PEAK');
  const fall = (from === 'PEAK' || from === 'IMPACT') && (to === 'BREAKDOWN' || to === 'AMBIENT');
  const voice = to === 'VOCAL_FOCUS';
  const wake = (from === 'SILENCE' || from === 'IDLE') && to !== 'SILENCE' && to !== 'IDLE';
  return drop || fall || voice || wake;
}

export class VisualDirector {
  private readonly lifecycle = new LifecycleManager();
  private readonly transitions = new TransitionEngine();
  private scene: SceneDef = findScene('deep-minimal');
  private sceneSince = 0;
  private lastTransitionAt = -Infinity;
  private lastDecisionAt = -Infinity;
  private lastState: MusicalState = 'IDLE';
  /** Когда каждая сцена была видна в последний раз. */
  private readonly lastUsed = new Map<string, number>();
  private readonly recentTransitions: TransitionType[] = [];
  private readonly log: VisualDecision[] = [];
  private activations = 0;
  private rng = mulberry32(0x5eed);
  private particleDensity = 0;
  /** Сколько частиц оставляет контроль сложности, 0.45..1. */
  private particleTrim = 1;
  private typography = 0.5;
  private camera: CameraStyle = 'static';
  private surpriseBudget = 0.5;
  private surpriseUntil = 0;
  private lastSurpriseAt = -Infinity;
  private surprisePrimitive: PrimitiveId | null = null;
  private confidence = 0.5;
  private started = false;
  private harmonyId: string | null = null;
  private lastDwellCreditAt = 0;
  /** Время на одно решение, мс — для отладочного оверлея. */
  lastTickMs = 0;
  private preview: Preview | null = null;

  private readonly out: DirectorOutput;

  constructor(private readonly model: PreferenceModel) {
    this.out = {
      weights: new Map(ALL_PRIMITIVE_IDS.map((id) => [id, 0])),
      particles: [],
      particleDensity: 0,
      bloom: 0.45, rays: 0.1, rim: 0.1,
      camera: 'static', cameraAmount: 0.1, shake: false,
      feedback: 0.1,
      typography: 0.5,
      modifiers: this.transitions.modifiers(0),
      complexity: 0, targetComplexity: 0.3,
      scene: this.scene,
      confidence: 0.5,
      surprise: false,
      harmonyId: null,
      params: new BindingSet(this.scene.bindings),
    };
  }

  get currentScene(): SceneDef {
    return this.scene;
  }

  get decisions(): readonly VisualDecision[] {
    return this.log;
  }

  get sceneHeldMs(): number {
    return this.lastNow - this.sceneSince;
  }

  private lastNow = 0;
  private lastFeatures: AudioFeatures | null = null;
  private lastSnapshot: MusicalStateSnapshot | null = null;

  /**
   * Шаг режиссёра на кадре. Решения — не чаще четырёх раз в секунду и
   * сразу при смене музыкального состояния; всё остальное время кадр ведут
   * жизненные циклы и привязки.
   */
  update(features: AudioFeatures, snap: MusicalStateSnapshot, config: DirectorConfig, dtSec: number): DirectorOutput {
    const now = features.timeMs;
    this.lastNow = now;
    this.lastFeatures = features;
    this.lastSnapshot = snap;

    if (!this.started) {
      this.started = true;
      this.sceneSince = now;
      this.activate(this.scene, now, snap.state, null);
    }

    const due = now - this.lastDecisionAt >= DECISION_INTERVAL_MS;
    if (snap.changed || due) {
      const started = performance.now();
      this.decide(features, snap, config, now);
      this.lastTickMs = performance.now() - started;
      this.lastDecisionAt = now;
    }

    this.surpriseBudget = Math.min(1, this.surpriseBudget
      + dtSec * (0.2 + this.model.profile.surpriseTolerance * 0.8) / 150);

    this.lifecycle.update(now);
    this.out.params.update(features, dtSec);
    return this.compose(features, snap, now, dtSec);
  }

  /**
   * Предпросмотр варианта в режиме обучения: вопрос без показа бессмыслен,
   * зритель должен увидеть оба варианта, прежде чем выбрать. Пока предпросмотр
   * задан, он перекрывает собственные решения режиссёра по этому параметру.
   */
  setPreview(preview: Preview | null): void {
    this.preview = preview;
  }

  /** Показать переход на текущей сцене — для вопроса о переходах. */
  pulseTransition(type: TransitionType): void {
    this.transitions.start(type, this.lastNow);
  }

  /** Лучшие сцены на текущий момент — для вопросов в режиме обучения. */
  candidates(limit = 2): SceneCandidate[] {
    if (!this.lastFeatures || !this.lastSnapshot) return [];
    return this.rank(this.lastFeatures, this.lastSnapshot.state, this.lastConfig)
      .slice(0, limit);
  }

  /** Явный выбор сцены: ответ в режиме обучения или ручное переключение. */
  forceScene(id: string, transition: TransitionType = 'fade'): void {
    if (!this.lastSnapshot) return;
    const scene = findScene(id);
    if (scene.id === this.scene.id) return;
    this.switchTo(scene, this.lastNow, this.lastSnapshot.state, transition, 'выбор зрителя', 1);
  }

  /** Следующая сцена по рейтингу — зритель попросил сменить. */
  skipScene(): string | null {
    if (!this.lastFeatures || !this.lastSnapshot) return null;
    const next = this.rank(this.lastFeatures, this.lastSnapshot.state, this.lastConfig)
      .find((c) => c.scene.id !== this.scene.id);
    if (!next) return null;
    this.switchTo(next.scene, this.lastNow, this.lastSnapshot.state, 'glitch', 'пропуск зрителем', this.confidence);
    return next.scene.id;
  }

  /** Сигнал обратной связи в текущем контексте. */
  feedback(item: ItemId, value: number, kind: 'explicit' | 'implicit', signal: string): void {
    if (!this.lastFeatures || !this.lastSnapshot) return;
    this.model.record({
      timestamp: Date.now(),
      audioContext: summarize(this.lastFeatures),
      musicalState: this.lastSnapshot.state,
      scene: this.scene.id,
      effect: item,
      parameters: { complexity: Number(this.out.complexity.toFixed(3)), camera: this.camera },
      userFeedback: value,
      kind,
      signal,
    });
  }

  private lastConfig: DirectorConfig = {
    mode: 'auto', lockedScene: null, isDisabled: () => false, allowSurprise: true,
    complexityBias: 0, minSceneSec: 8, maxSceneSec: 45,
  };

  // --- решения ---------------------------------------------------------------

  private decide(f: AudioFeatures, snap: MusicalStateSnapshot, config: DirectorConfig, now: number): void {
    this.lastConfig = config;
    const state = snap.state;
    const decision: VisualDecision = {
      at: now, state, scene: this.scene.id, activate: [], strengthen: [], weaken: [], exit: [],
      transition: null, camera: this.camera, globalEnergy: f.energy, confidence: this.confidence,
      reason: '',
    };

    // Сюрприз — в первую очередь: он живёт полсекунды и не ждёт очереди.
    if (this.surprisePrimitive && now >= this.surpriseUntil) this.endSurprise(now, state);
    if (snap.changed && state === 'IMPACT' && this.maySurprise(config, now)) {
      this.startSurprise(now);
      decision.reason = 'сюрприз на ударе';
      decision.activate.push(`prim:${this.surprisePrimitive}`);
      this.push(decision);
      this.lastState = state;
      return;
    }
    /*
     * Пока идёт сюрприз, режиссёр не трогает ни сцену, ни акценты, ни
     * сложность. Иначе на следующем тике он применял акценты удара и за
     * 250 мс возвращал сцену на полную — сюрприз обрывался, не успев
     * случиться. Акценты текущего состояния восстановит конец сюрприза.
     */
    if (this.surprisePrimitive) {
      this.lastState = state;
      return;
    }

    // Выбор сцены.
    const ranked = this.rank(f, state, config);
    const best = ranked[0];
    const second = ranked[1];
    const current = ranked.find((c) => c.scene.id === this.scene.id);
    const margin = best && second ? best.score - second.score : 1;
    const certainty = best
      ? this.model.preference(`scene:${best.scene.id}`, state, summarize(f)).certainty
      : 0;
    this.confidence = clamp01(0.35 + 0.45 * clamp01(margin / 0.5) + 0.2 * certainty);
    decision.confidence = this.confidence;

    const held = now - this.sceneSince;
    const boundary = snap.changed && isSectionBoundary(snap.previous, state);
    const canTransition = now - this.lastTransitionAt >= TRANSITION_COOLDOWN_MS;
    // На границе части сцену можно сменить раньше: дроп не должен ждать,
    // пока истечёт выдержка, выставленная для спокойной смены.
    const minHold = config.minSceneSec * 1000 * (boundary ? 0.35 : 1);
    const tooLong = held > config.maxSceneSec * 1000;
    const lockedHere = config.mode === 'semi' && config.lockedScene !== null;

    let reason = '';
    let switched = false;
    if (lockedHere && config.lockedScene !== this.scene.id && canTransition) {
      this.switchTo(findScene(config.lockedScene!), now, state, 'fade', 'сцена закреплена', this.confidence);
      switched = true;
    } else if (!lockedHere && config.mode !== 'manual' && best && canTransition && held >= minHold
      && best.scene.id !== this.scene.id) {
      const beatsCurrent = !current || best.score > current.score + (boundary ? 0.05 : 0.2);
      // Полуавтомат меняет сцену только на границе части: пользователь
      // правит картинку сам и не хочет, чтобы она уезжала из-под рук.
      // Удар — событие, а не часть трека: сцену на нём меняем только если это
      // дроп (граница «нарастание → удар»). Иначе один случайный скачок
      // энергии уводил в сцену для удара, которая через секунду уже не к месту.
      const free = config.mode === 'auto' && state !== 'IMPACT';
      if (boundary && beatsCurrent) reason = `граница части: ${snap.previous} → ${state}`;
      else if (free && tooLong) reason = 'сцена приелась';
      else if (free && beatsCurrent && best.score > (current?.score ?? 0) + 0.35) reason = 'другая сцена заметно уместнее';
      if (reason) {
        const transition = this.chooseTransition(f, state);
        // switchTo сам пишет решение в журнал — здесь его не дублируем.
        this.switchTo(best.scene, now, state, transition, reason, this.confidence);
        switched = true;
      }
    }

    // Акценты слоёв под текущее состояние — даже если сцена та же.
    if (snap.changed || this.lastState !== state) {
      this.applyEmphasis(now, state, decision);
      this.lastState = state;
    }

    this.controlComplexity(now, state, config, decision);
    this.chooseCamera(state, decision);
    this.creditDwell(now, config);

    if (!decision.reason) decision.reason = switched ? '' : snap.changed ? `состояние ${state}` : '';
    if (!switched && (decision.reason || decision.weaken.length || decision.strengthen.length)) {
      this.push(decision);
    }
  }

  /** Оценка всех сцен в текущем контексте, по убыванию. */
  private rank(f: AudioFeatures, state: MusicalState, config: DirectorConfig): SceneCandidate[] {
    const audio = summarize(f);
    const profile = this.model.profile;
    const target = this.targetComplexity(state, config);
    const now = f.timeMs;
    const held = now - this.sceneSince;

    const out: SceneCandidate[] = [];
    for (const scene of SCENES) {
      const primary = scene.layers.find((l) => l.role === 'primary');
      if (!primary || config.isDisabled(primary.primitive)) continue;

      const fit = scene.fits[state] ?? 0.15;
      const compat = audioCompat(scene, f);
      const pref = this.model.preference(`scene:${scene.id}`, state, audio);
      const traitBias = traitsBias(scene.traits, profile);
      const lastSeen = this.lastUsed.get(scene.id);
      const novelty = lastSeen === undefined ? 1 : clamp01((now - lastSeen) / 90000);
      const isCurrent = scene.id === this.scene.id;
      // Усталость: текущая сцена со временем теряет очки, недавно показанная —
      // тоже, пока не пройдёт окно в 15 секунд.
      const fatigue = isCurrent
        ? clamp01((held - config.minSceneSec * 1000) / Math.max(1, (config.maxSceneSec - config.minSceneSec) * 1000))
        : lastSeen !== undefined && now - lastSeen < FATIGUE_WINDOW_MS ? 0.6 : 0;
      const overload = Math.max(0, scene.complexity - target);

      const score = fit * 1.0
        + compat * 0.5
        + pref.value * (0.3 + pref.certainty * 0.7) * 0.8
        + traitBias
        + (isCurrent ? 0.25 : novelty * 0.35)
        - fatigue * 0.8
        - overload * 0.9;
      out.push({ scene, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  private chooseTransition(f: AudioFeatures, state: MusicalState): TransitionType {
    const audio = summarize(f);
    const profile = this.model.profile;
    let best: TransitionType = 'fade';
    let bestScore = -Infinity;
    for (const type of TRANSITION_TYPES) {
      if (type === 'blackout') continue;
      let score = TRANSITION_FITS[type][state] ?? 0.2;
      const pref = this.model.preference(`transition:${type}`, state, audio);
      score += pref.value * (0.3 + pref.certainty * 0.7) * 0.6;
      if (type === 'glitch' || type === 'fragment') score += (profile.glitchPreference - 0.5) * 0.6;
      if (type === 'explosion' || type === 'zoom') score += (profile.impactPreference - 0.5) * 0.4;
      if (type === 'fade' || type === 'dissolve') score += (profile.minimalism - 0.5) * 0.4;
      // Не повторяем недавние переходы: одинаковый переход дважды подряд
      // сразу выдаёт механику.
      if (this.recentTransitions.includes(type)) score -= 0.35;
      // Немного случайности — иначе в одном и том же контексте всегда одно.
      score += this.rng() * 0.15;
      if (score > bestScore) {
        bestScore = score;
        best = type;
      }
    }
    return best;
  }

  private switchTo(
    scene: SceneDef, now: number, state: MusicalState, transition: TransitionType, reason: string, confidence: number,
  ): void {
    const previous = this.scene;
    this.lastUsed.set(previous.id, now);
    const handover = this.transitions.start(transition, now);
    const curve: TransitionCurve = transition === 'explosion' || transition === 'glitch' ? 'linear' : 'ease-in-out';

    // Слои старой сцены, которых нет в новой, уходят; общие — остаются и
    // лишь меняют вес. Так движение не рвётся: общая волна не гаснет и не
    // зажигается заново только потому, что сменилась сцена.
    const keep = new Set(scene.layers.map((l) => l.primitive));
    for (const layer of previous.layers) {
      if (!keep.has(layer.primitive)) {
        this.lifecycle.slot(`prim:${layer.primitive}`).exit(now, handover.exitMs, curve, handover.exitDelayMs);
      }
    }

    this.scene = scene;
    this.sceneSince = now;
    this.lastTransitionAt = now;
    this.particleTrim = 1;
    this.recentTransitions.push(transition);
    if (this.recentTransitions.length > 2) this.recentTransitions.shift();
    this.activate(scene, now, state, { ms: handover.enterMs, delay: handover.enterDelayMs, curve });
    this.push({
      at: now, state, scene: scene.id,
      activate: scene.layers.map((l) => `prim:${l.primitive}`),
      strengthen: [], weaken: [], exit: previous.layers.filter((l) => !keep.has(l.primitive)).map((l) => `prim:${l.primitive}`),
      transition, camera: this.camera, globalEnergy: this.lastFeatures?.energy ?? 0,
      confidence, reason,
    });
  }

  /** Вход сцены: каждый слой — со своим весом под текущее состояние. */
  private activate(
    scene: SceneDef, now: number, state: MusicalState,
    timing: { ms: number; delay: number; curve: TransitionCurve } | null,
  ): void {
    this.activations++;
    // Вариация: у каждого показа сцены свои частицы и своя гармония. Сцена
    // узнаётся, но не повторяется кадр в кадр.
    this.rng = mulberry32((hash(scene.id) ^ (this.activations * 0x9e3779b1)) >>> 0);
    const shift = Math.floor(this.rng() * scene.particles.length);
    this.out.particles = scene.particles.slice(shift).concat(scene.particles.slice(0, shift));
    const harmonies = ['analogous', 'complementary', 'split-complementary', 'triadic'];
    this.harmonyId = harmonies[Math.floor(this.rng() * harmonies.length)];
    this.out.params = new BindingSet(scene.bindings);

    const emphasis = EMPHASIS[state];
    for (const layer of scene.layers) {
      const level = layer.weight * emphasisFor(emphasis, layer.role);
      const slot = this.lifecycle.slot(`prim:${layer.primitive}`);
      if (timing) slot.enter(now, level, timing.ms, timing.curve, timing.delay);
      else slot.enter(now, level, 1200);
    }
  }

  private applyEmphasis(now: number, state: MusicalState, decision: VisualDecision): void {
    const emphasis = EMPHASIS[state];
    // На ударе веса перестраиваются почти мгновенно, в спокойной музыке — медленно.
    const ms = state === 'IMPACT' ? 250 : state === 'PEAK' || state === 'RISING' ? 700 : 1600;
    for (const layer of this.scene.layers) {
      const slot = this.lifecycle.slot(`prim:${layer.primitive}`);
      const level = layer.weight * emphasisFor(emphasis, layer.role);
      if (level > slot.level + 0.02) decision.strengthen.push(`prim:${layer.primitive}`);
      else if (level < slot.level - 0.02) decision.weaken.push(`prim:${layer.primitive}`);
      slot.retarget(now, level, ms);
    }
  }

  private targetComplexity(state: MusicalState, config: DirectorConfig): number {
    const p = this.model.profile;
    return clamp01(TARGET_COMPLEXITY[state] + config.complexityBias
      + (p.complexity - 0.5) * 0.3 - (p.minimalism - 0.5) * 0.2);
  }

  /**
   * Не даём кадру перегрузиться. Если сложность выше цели — сначала
   * приглушается фон, потом второстепенный слой, потом частицы. Главный
   * слой не трогаем: он и есть фокус. Если кадр пустоват — возвращаем.
   */
  private controlComplexity(now: number, state: MusicalState, config: DirectorConfig, decision: VisualDecision): void {
    const target = this.targetComplexity(state, config);
    const complexity = this.measureComplexity();
    this.out.complexity = complexity;
    this.out.targetComplexity = target;
    const emphasis = EMPHASIS[state];

    if (complexity > target + 0.08) {
      for (const role of ['background', 'secondary'] as LayerRole[]) {
        const layer = this.scene.layers.find((l) => l.role === role);
        if (!layer) continue;
        const id = `prim:${layer.primitive}`;
        // Только что усиленное тем же решением не трогаем: иначе один и тот
        // же слой в одном тике и растёт, и гаснет.
        if (decision.strengthen.includes(id)) continue;
        const slot = this.lifecycle.slot(id);
        if (slot.level > 0.05) {
          slot.retarget(now, slot.level * 0.6, 900);
          decision.weaken.push(id);
          return;
        }
      }
      /*
       * Частицы ужимаются через цель, а не через текущее значение. Если
       * срезать само значение, следующий кадр тянет его обратно к цели, и
       * режиссёр режет его снова каждые 250 мс — вечная борьба.
       */
      if (this.particleTrim > 0.45) {
        this.particleTrim = Math.max(0.45, this.particleTrim * 0.8);
        decision.weaken.push('particles');
      }
    } else if (complexity < target - 0.12) {
      this.particleTrim = Math.min(1, this.particleTrim + 0.1);
      for (const layer of this.scene.layers) {
        if (layer.role === 'primary') continue;
        const slot = this.lifecycle.slot(`prim:${layer.primitive}`);
        const full = layer.weight * emphasisFor(emphasis, layer.role);
        if (slot.level < full - 0.03) {
          slot.retarget(now, Math.min(full, slot.level + 0.15), 1200);
          decision.strengthen.push(`prim:${layer.primitive}`);
          return;
        }
      }
    }
  }

  private measureComplexity(): number {
    let total = 0;
    for (const id of ALL_PRIMITIVE_IDS) {
      total += this.lifecycle.weight(`prim:${id}`) * PRIMITIVE_COMPLEXITY[id];
    }
    total += this.particleDensity * 0.25;
    total += (CAMERA_AMOUNT[this.camera] ?? 0) * 0.1;
    total += this.typography * 0.08;
    return clamp01(total);
  }

  private chooseCamera(state: MusicalState, decision: VisualDecision): void {
    let camera: CameraStyle = this.scene.camera;
    if (state === 'IMPACT') camera = 'impact';
    else if (state === 'SILENCE' || state === 'IDLE') camera = 'static';
    else if (state === 'RISING' && camera !== 'static') camera = 'forward';
    // В тихих частях камера не бывает резкой, какой бы ни была сцена: удар
    // камерой под куплет выглядит как ошибка.
    else if ((state === 'VOCAL_FOCUS' || state === 'AMBIENT' || state === 'BREAKDOWN')
      && (camera === 'aggressive' || camera === 'impact' || camera === 'forward')) camera = 'smooth';
    // Зритель, которого укачивает, агрессивной камеры не получает.
    if (this.model.profile.motion < 0.3 && (camera === 'aggressive' || camera === 'impact')) camera = 'smooth';
    if (camera !== this.camera) decision.camera = camera;
    this.camera = camera;
  }

  /**
   * Неявный сигнал «оставил как есть»: сцена полминуты на экране, а зритель
   * её не пропустил. Слабый — в автомате зритель мог и не смотреть.
   */
  private creditDwell(now: number, config: DirectorConfig): void {
    if (config.mode === 'manual') return;
    const held = now - this.sceneSince;
    if (held > 30000 && now - this.lastDwellCreditAt > 30000) {
      this.lastDwellCreditAt = now;
      this.feedback(`scene:${this.scene.id}`, 0.1, 'implicit', 'досмотрел');
    }
  }

  // --- сюрприз ---------------------------------------------------------------

  private maySurprise(config: DirectorConfig, now: number): boolean {
    return config.allowSurprise
      && config.mode === 'auto'
      && this.surpriseBudget >= 1
      && now - this.sceneSince > 25000
      && now - this.lastSurpriseAt > 60000;
  }

  /**
   * Редкий слом привычного: кадр почти гаснет, на полсекунды выходит одна
   * яркая форма, потом всё возвращается. Бюджет копится минутами — чаще
   * сюрприз перестаёт быть сюрпризом.
   */
  private startSurprise(now: number): void {
    const inScene = new Set(this.scene.layers.map((l) => l.primitive));
    const pool: PrimitiveId[] = ['radial-waveform', 'raymarch', 'oscilloscope'];
    const pick = pool.find((id) => !inScene.has(id) && !this.lastConfig.isDisabled(id)) ?? pool[0];
    this.surprisePrimitive = pick;
    this.surpriseUntil = now + 500;
    this.lastSurpriseAt = now;
    this.surpriseBudget -= 1;
    for (const layer of this.scene.layers) {
      this.lifecycle.slot(`prim:${layer.primitive}`).retarget(now, 0.03, 150);
    }
    this.lifecycle.slot(`prim:${pick}`).enter(now, 1, 120, 'ease-out');
  }

  private endSurprise(now: number, state: MusicalState): void {
    if (!this.surprisePrimitive) return;
    const inScene = this.scene.layers.some((l) => l.primitive === this.surprisePrimitive);
    if (!inScene) this.lifecycle.slot(`prim:${this.surprisePrimitive}`).exit(now, 300);
    this.surprisePrimitive = null;
    const emphasis = EMPHASIS[state];
    for (const layer of this.scene.layers) {
      this.lifecycle.slot(`prim:${layer.primitive}`)
        .retarget(now, layer.weight * emphasisFor(emphasis, layer.role), 450);
    }
  }

  // --- выход -----------------------------------------------------------------

  private compose(f: AudioFeatures, snap: MusicalStateSnapshot, now: number, dtSec: number): DirectorOutput {
    const out = this.out;
    const emphasis = EMPHASIS[snap.state];
    const params = out.params;
    const pulse = params.get('primaryPulse', 1);
    const primary = this.scene.layers.find((l) => l.role === 'primary')?.primitive;

    for (const id of ALL_PRIMITIVE_IDS) {
      let w = this.lifecycle.weight(`prim:${id}`);
      if (id === primary && !this.surprisePrimitive) w *= pulse;
      out.weights.set(id, Math.min(1, w));
    }

    // Частицы и текст едут к цели плавно, а удар подбрасывает частицы сразу.
    const densityTarget = this.surprisePrimitive
      ? 0
      : this.scene.particleDensity * emphasis.particles * this.particleTrim;
    this.particleDensity += (densityTarget - this.particleDensity) * follow(dtSec, 0.4);
    const profile = this.model.profile;
    const typoTarget = this.scene.typography * emphasis.typography
      * (0.5 + profile.typographyPreference);
    this.typography += (clamp01(typoTarget) - this.typography) * follow(dtSec, 0.6);

    const mods = this.transitions.modifiers(now);
    // Привязка сцены «деформация ← звук» ложится поверх волны перехода. Без
    // этой строки привязка `warp` в описаниях сцен была мёртвым конфигом.
    mods.warp = Math.min(1, mods.warp + params.get('warp', 0));
    out.modifiers = mods;
    out.particleDensity = clamp01(this.particleDensity + params.get('particleBoost', 0) * 0.5 + mods.particleBurst * 0.6);
    out.typography = this.typography;

    const glow = params.get('glow', 1);
    out.bloom = clamp01(this.scene.lighting.bloom * glow + mods.flash * 0.5 + (this.surprisePrimitive ? 0.3 : 0));
    out.rays = clamp01(this.scene.lighting.rays * glow);
    out.rim = this.scene.lighting.rim;
    out.feedback = clamp01(this.scene.feedback + mods.smear * 0.4);

    const camera = this.preview?.camera ?? this.camera;
    out.camera = camera;
    const motion = 0.4 + profile.motion * 1.2;
    out.cameraAmount = clamp01(CAMERA_AMOUNT[camera] * motion + params.get('cameraKick', 0) * 0.15);
    out.shake = camera === 'impact' || camera === 'aggressive';

    // Интенсивность в предпросмотре масштабирует всё, что делает кадр
    // насыщеннее: частицы, свечение, камеру.
    const intensity = this.preview?.intensity;
    if (intensity !== undefined) {
      const k = 0.35 + intensity * 0.9;
      out.particleDensity = clamp01(out.particleDensity * k);
      out.bloom = clamp01(out.bloom * k);
      out.cameraAmount = clamp01(out.cameraAmount * k);
    }

    out.scene = this.scene;
    out.confidence = this.confidence;
    out.surprise = this.surprisePrimitive !== null;
    out.harmonyId = this.harmonyId;
    void f;
    return out;
  }

  private push(decision: VisualDecision): void {
    decision.weaken = [...new Set(decision.weaken)];
    decision.strengthen = [...new Set(decision.strengthen)];
    this.log.push(decision);
    if (this.log.length > DECISION_LOG) this.log.shift();
  }

  /** Активные эффекты и их веса — для панели режиссёра. */
  activeEffects(): Array<{ id: string; weight: number; state: string }> {
    return this.lifecycle.all
      .filter((slot) => slot.weight > 0.02)
      .map((slot) => ({ id: slot.id, weight: slot.weight, state: slot.state }))
      .sort((a, b) => b.weight - a.weight);
  }
}

function emphasisFor(e: Emphasis, role: LayerRole): number {
  return role === 'primary' ? e.primary : role === 'secondary' ? e.secondary : e.background;
}

/** Совместимость сцены со звуком: взвешенная сумма признаков, к которым она тянется. */
function audioCompat(scene: SceneDef, f: AudioFeatures): number {
  let sum = 0;
  let weight = 0;
  for (const [key, w] of Object.entries(scene.affinity) as Array<[FeatureKey, number]>) {
    const v = key === 'energyTrend' ? (f.energyTrend + 1) / 2 : f[key];
    // Отрицательный вес — сцена тянется к противоположному.
    sum += w >= 0 ? w * v : -w * (1 - v);
    weight += Math.abs(w);
  }
  return weight > 0 ? sum / weight - 0.4 : 0;
}

/** Черты профиля сдвигают оценку сцены: любителю частиц — сцены с частицами. */
function traitsBias(traits: VisualTrait[], p: VisualProfile): number {
  let bias = 0;
  for (const t of traits) {
    const v = t === 'particles' ? p.particlePreference
      : t === 'geometry' ? p.geometryPreference
        : t === 'organic' ? p.organicPreference
          : t === 'glitch' ? p.glitchPreference
            : t === 'typography' ? p.typographyPreference
              : t === 'minimal' ? p.minimalism
                : t === 'impact' ? p.impactPreference
                  : p.darkness;
    bias += (v - 0.5) * 0.4;
  }
  return bias;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
