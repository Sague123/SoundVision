/**
 * Дев-страница для прогона рендера без звука.
 *
 * Гоняет каждый примитив по всем секциям на синтетическом mood vector:
 * так видно и что ничего не падает, и насколько примитивы вообще отличаются
 * друг от друга (пункт «с проверкой на разнообразие» из плана).
 *
 * Открывается на `npm run dev` по адресу /dev/smoke.html.
 * `?only=voronoi&section=drop` — держать одну пару бесконечно, чтобы
 * разглядеть конкретный примитив.
 * `?plain=1` — снять весь пост-конвейер и память: видно, что рисует сам
 * примитив, без свечения, лучей и обратной связи.
 * В прод-сборку не попадает: Vite собирает только index.html.
 */

import '../src/style.css';
import { idleMood, type MoodVector } from '../src/audio/mood-vector.ts';
import { Compositor } from '../src/render/compositor.ts';
import { ALL_PRIMITIVE_IDS, type PrimitiveId } from '../src/render/primitives/types.ts';
import { defaultSettings } from '../src/settings.ts';
import type { Section } from '../src/audio/features.ts';

const SECTIONS: Section[] = ['calm', 'steady', 'buildup', 'drop'];
/** Сколько кадров держим каждую пару «примитив × секция». */
const FRAMES_PER_STAGE = 45;

interface SmokeReport {
  done: boolean;
  frames: number;
  /** В скольких кадрах реально отработал пост-конвейер. */
  warpFrames: number;
  errors: string[];
  stages: Array<{ primitive: PrimitiveId; section: Section; avgFrameMs: number; rendered: string[] }>;
}

const report: SmokeReport = { done: false, frames: 0, warpFrames: 0, errors: [], stages: [] };
(window as unknown as { __smoke: SmokeReport }).__smoke = report;

window.addEventListener('error', (event) => report.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => report.errors.push(String(event.reason)));

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');

const canvas = document.createElement('canvas');
canvas.className = 'stage';
root.append(canvas);

const label = document.createElement('div');
label.style.cssText = 'position:absolute;top:12px;left:12px;font:13px monospace;color:#fff;z-index:5';
root.append(label);

const compositor = new Compositor(canvas);
compositor.resize(window.innerWidth, window.innerHeight, 1);

const settings = defaultSettings();
settings.generator.mode = 'manual';


const params = new URLSearchParams(window.location.search);
// Режим «как есть»: только геометрия примитива, без пост-обработки.
// Нужен, чтобы понимать, кто именно засветил кадр — примитив или конвейер.
if (params.get('plain') === '1') {
  settings.light.bloom = 0;
  settings.light.rays = 0;
  settings.light.rim = 0;
  settings.light.flare = false;
  settings.memory.feedback = 0;
  settings.memory.smear = 0;
  settings.deformation.enabled = false;
  settings.layers.transient.enabled = false;
  settings.layers.base.enabled = false;
}

const only = params.get('only') as PrimitiveId | null;
const onlySection = (params.get('section') as Section | null) ?? 'steady';
/** В режиме `?only=` стадия одна и живёт бесконечно — это ручной осмотр. */
const held = only !== null && ALL_PRIMITIVE_IDS.includes(only);
/** `?frames=20` укорачивает прогон: с полным пост-конвейером он заметно дольше. */
const requestedFrames = Number(params.get('frames'));
const stageFrames = Number.isFinite(requestedFrames) && requestedFrames > 0
  ? Math.round(requestedFrames)
  : FRAMES_PER_STAGE;
const framesPerStage = held ? Number.POSITIVE_INFINITY : stageFrames;

const stages: Array<{ primitive: PrimitiveId; section: Section }> = [];
if (held && only) {
  stages.push({ primitive: only, section: onlySection });
} else {
  for (const primitive of ALL_PRIMITIVE_IDS) {
    for (const section of SECTIONS) stages.push({ primitive, section });
  }
}

let stageIndex = 0;
let frameInStage = 0;
let frameMsTotal = 0;
let renderedInStage = new Set<string>();

/** Правдоподобный mood vector: энергия дышит, удары идут в темпе. */
function synthesize(timeMs: number, section: Section): MoodVector {
  const t = timeMs / 1000;
  const bpm = 128;
  const beatPhase = (t * (bpm / 60)) % 1;
  const base = idleMood(timeMs);
  const energy = section === 'calm' ? 0.2 : section === 'drop' ? 0.9 : 0.55;

  return {
    ...base,
    energy: Math.min(1, energy + Math.sin(t * 0.7) * 0.15),
    brightness: 0.35 + Math.sin(t * 0.31) * 0.3,
    noisiness: 0.3 + Math.cos(t * 0.23) * 0.25,
    flux: Math.abs(Math.sin(t * 2.1)) * 0.6,
    onset: beatPhase < 0.06,
    onsetStrength: beatPhase < 0.06 ? 0.7 : 0,
    bpm,
    beatPhase,
    beatConfidence: 0.8,
    key: { tonic: 'A', mode: section === 'calm' ? 'minor' : 'major', confidence: 0.7 },
    section,
    energySlope: section === 'buildup' ? 0.4 : 0,
    silent: false,
    timeMs,
    deltaMs: 16.7,
  };
}

/**
 * Виртуальные часы вместо реального времени.
 *
 * Под софтверным рендером кадры идут неровно, и на реальных часах настроение
 * в момент замера каждый раз разное — метрики скачут и сравнивать прогоны
 * нельзя. С фиксированным шагом прогон полностью воспроизводим.
 */
const VIRTUAL_STEP_MS = 1000 / 60;

function frame(): void {
  const timestamp = report.frames * VIRTUAL_STEP_MS;
  const stage = stages[stageIndex];
  if (!stage) {
    report.done = true;
    label.textContent = `готово: ${report.frames} кадров, ошибок ${report.errors.length}`;
    return;
  }

  if (frameInStage === 0) {
    settings.generator.manual = stage.primitive === 'kaleidoscope'
      // Калейдоскоп ничего не рисует сам — ему нужен источник.
      ? ['flow-field', 'kaleidoscope']
      : [stage.primitive];
    compositor.setTrack('smoke', `${stage.primitive}-${stage.section}`);
    renderedInStage = new Set();
    frameMsTotal = 0;
  }

  try {
    const stats = compositor.render(synthesize(timestamp, stage.section), settings, {
      url: '', image: null, colors: [],
    });
    frameMsTotal += stats.frameMs;
    if (stats.postActive) report.warpFrames++;
    for (const id of stats.activePrimitives) renderedInStage.add(id);
  } catch (err) {
    report.errors.push(`${stage.primitive}/${stage.section}: ${(err as Error).message}`);
    frameInStage = FRAMES_PER_STAGE; // не молотим один и тот же падающий кадр
  }

  report.frames++;
  frameInStage++;
  label.textContent = held
    ? `${stage.primitive} / ${stage.section} — кадр ${frameInStage}`
    : `${stage.primitive} / ${stage.section} — ${frameInStage}/${stageFrames}`;
  // В режиме осмотра отмечаемся «готовы» после прогрева, но рисовать продолжаем.
  if (held && frameInStage > 40) report.done = true;

  if (frameInStage >= framesPerStage) {
    report.stages.push({
      primitive: stage.primitive,
      section: stage.section,
      avgFrameMs: frameMsTotal / Math.max(1, frameInStage),
      rendered: [...renderedInStage],
    });
    stageIndex++;
    frameInStage = 0;
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
