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
/** Заглушка на случай, когда 2D-контекст для замера недоступен. */
const EMPTY_METRICS: FrameMetrics = {
  width: 0, height: 0, fill: 0, floor: 0, median: 0, top2: 0, contrast: 0, midMass: 0, bright: 0,
};
/** Сколько кадров держим каждую пару «примитив × секция». */
const FRAMES_PER_STAGE = 45;

/**
 * Метрики кадра из §8. Считаются по холсту в его физическом размере: именно
 * так видно и пикселизацию, и мутность — на масштабированном снимке обе
 * пропадают.
 */
export interface FrameMetrics {
  /** Физический размер холста: подтверждение, что замер не по CSS-пикселям. */
  width: number;
  height: number;
  /** Доля пикселей ярче фона. На спокойных участках должна быть ниже 30%. */
  fill: number;
  /** Яркость фона: четверть самых тёмных пикселей. Правило §2 — ниже 0.08. */
  floor: number;
  median: number;
  /** Порог верхних 2% яркости. */
  top2: number;
  /** Отношение верхних 2% к медиане: у референсов оно очень высокое. */
  contrast: number;
  /** Масса в средних тонах — прямой признак мутной картинки. */
  midMass: number;
  /** Доля очень ярких пикселей: их должно быть 2-3%, а не половина кадра. */
  bright: number;
}

interface SmokeReport {
  done: boolean;
  frames: number;
  /** В скольких кадрах реально отработал пост-конвейер. */
  warpFrames: number;
  errors: string[];
  stages: Array<{
    primitive: PrimitiveId;
    section: Section;
    avgFrameMs: number;
    rendered: string[];
    metrics: FrameMetrics;
  }>;
  /** Типы частиц, живые в последнем кадре. */
  particleTypes: string[];
  /** Метрики текущего кадра — их читает внешний прогон в режиме `?only=`. */
  metrics: FrameMetrics | null;
  /** Снимок холста в нативном разрешении, data URL. */
  snapshot(): string;
}

const report: SmokeReport = {
  done: false, frames: 0, warpFrames: 0, errors: [], stages: [],
  metrics: null,
  particleTypes: [],
  snapshot: () => canvas.toDataURL('image/png'),
};
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
// Настройки наружу: без них нельзя выяснить, кто именно нарисовал деталь в
// кадре — примитив, частицы или свет. А это первый вопрос при разборе.
(window as unknown as { __settings: typeof settings }).__settings = settings;


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

/**
 * Синтетический сигнал: осциллограмма, её правый канал и спектр.
 *
 * Без него аудио-примитивы меряются на тишине: `idleMood` отдаёт нулевые
 * массивы, оscilloscope рисует точку, а ландшафт из волны — стопку прямых.
 * Метрики в таком прогоне ничего не говорят о примитиве, поэтому харнесс
 * обязан кормить их тем же, чем кормит рендер живой звук.
 */
const WAVE_LENGTH = 2048;
const SPECTRUM_BINS = 1024;
const signalLeft = new Float32Array(WAVE_LENGTH);
const signalRight = new Float32Array(WAVE_LENGTH);
const signalSpectrum = new Float32Array(SPECTRUM_BINS);
/** Сдвиг правого канала по фазе — иначе XY-режим осциллографа вырождается в диагональ. */
const STEREO_PHASE = 0.42;

function synthesizeSignal(t: number, energy: number, beatPhase: number): void {
  // Удар: короткая экспонента после доли, она же даёт «дыхание» амплитуды.
  const hit = Math.exp(-beatPhase * 9);
  const level = 0.25 + energy * 0.6;
  // Основной тон и две гармоники — этого хватает, чтобы волна была узнаваемо
  // музыкальной, а не синусоидой.
  const f0 = 2.2 + energy * 1.8;

  for (let i = 0; i < WAVE_LENGTH; i++) {
    const u = (i / WAVE_LENGTH) * Math.PI * 2;
    const noise = (Math.sin(i * 12.9898 + t * 78.233) * 43758.5453) % 1;
    const body = Math.sin(u * f0)
      + Math.sin(u * f0 * 2 + t * 0.7) * 0.45
      + Math.sin(u * f0 * 3.01 + t * 1.3) * 0.22;
    const attack = Math.sin(u * f0 * 8 + t) * hit * 0.35;
    const value = (body * 0.5 + attack + noise * 0.12 * energy) * level;
    signalLeft[i] = Math.max(-1, Math.min(1, value));

    const v = u + STEREO_PHASE;
    const bodyR = Math.sin(v * f0)
      + Math.sin(v * f0 * 2 + t * 0.7) * 0.45
      + Math.sin(v * f0 * 3.01 + t * 1.3) * 0.22;
    signalRight[i] = Math.max(-1, Math.min(1, (bodyR * 0.5 + attack * 0.8) * level));
  }

  /*
   * Спектр: спад по частоте плюс несколько подвижных пиков.
   *
   * Масштаб здесь не произвольный. Анализатор отдаёт линейную магнитуду
   * `10^(dB/20)`, и у реальной музыки это примерно 0.01..0.15 с редкими
   * пиками до 0.3 — единица означала бы 0 dB на одном бине. Примитивы уже
   * умножают спектр на свои коэффициенты в расчёте на этот масштаб, поэтому
   * харнесс обязан его повторять: спектр «от нуля до единицы» насыщал бы все
   * столбцы до потолка и врал бы в метриках.
   */
  const SPECTRUM_SCALE = 0.13;
  for (let bin = 0; bin < SPECTRUM_BINS; bin++) {
    const f = bin / SPECTRUM_BINS;
    const tilt = Math.exp(-f * 4.5);
    const peaks = Math.abs(Math.sin(f * 40 + t * 0.9)) * 0.35
      + Math.abs(Math.sin(f * 7 + t * 0.3)) * 0.4;
    const kick = f < 0.08 ? hit * 0.6 : 0;
    signalSpectrum[bin] = Math.min(1, (tilt * (0.5 + peaks) + kick) * level * SPECTRUM_SCALE);
  }
}

/** Правдоподобный mood vector: энергия дышит, удары идут в темпе. */
function synthesize(timeMs: number, section: Section): MoodVector {
  const t = timeMs / 1000;
  const bpm = 128;
  const beatPhase = (t * (bpm / 60)) % 1;
  const base = idleMood(timeMs);
  const energy = section === 'calm' ? 0.2 : section === 'drop' ? 0.9 : 0.55;
  synthesizeSignal(t, energy, beatPhase);

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
    waveform: signalLeft,
    waveformRight: signalRight,
    spectrum: signalSpectrum,
    stereo: true,
    timeMs,
    deltaMs: 16.7,
  };
}

/**
 * Замер кадра. Холст копируется как есть, без масштабирования: снимок в
 * нативном разрешении — единственный способ увидеть пикселизацию, а по нему
 * же считаются заполненность, контраст и форма гистограммы.
 */
const probe = document.createElement('canvas');
const probeCtx = probe.getContext('2d', { willReadFrequently: true });

function measure(): FrameMetrics | null {
  if (!probeCtx) return null;
  probe.width = canvas.width;
  probe.height = canvas.height;
  probeCtx.drawImage(canvas, 0, 0);

  const data = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
  const total = data.length / 4;
  const lumas = new Float32Array(total);
  // Гистограмма на 64 корзины: по ней видно, двугорбая картинка или мутная.
  const bins = new Uint32Array(64);
  let lit = 0;
  let bright = 0;

  for (let i = 0, n = 0; i < data.length; i += 4, n++) {
    const luma = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
    lumas[n] = luma;
    bins[Math.min(63, Math.floor(luma * 64))]++;
    // 0.06 — порог «ярче фона»: ниже него лежит и чёрный, и остаточная дымка.
    if (luma > 0.06) lit++;
    if (luma > 0.75) bright++;
  }

  lumas.sort();
  const at = (share: number): number => lumas[Math.min(total - 1, Math.floor(total * share))];
  let mid = 0;
  for (let i = 12; i < 40; i++) mid += bins[i];

  const median = at(0.5);
  const top2 = at(0.98);
  return {
    width: probe.width,
    height: probe.height,
    fill: lit / total,
    floor: at(0.25),
    median,
    top2,
    contrast: top2 / Math.max(1e-4, median),
    midMass: mid / total,
    bright: bright / total,
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
    report.particleTypes = stats.transient.particleTypes;
    for (const id of stats.activePrimitives) renderedInStage.add(id);
  } catch (err) {
    report.errors.push(`${stage.primitive}/${stage.section}: ${(err as Error).message}`);
    frameInStage = FRAMES_PER_STAGE; // не молотим один и тот же падающий кадр
  }

  report.frames++;
  frameInStage++;
  // Мерить каждый кадр дорого и незачем: метрика нужна на прогретой стадии.
  if (frameInStage === framesPerStage || (held && frameInStage % 60 === 0)) {
    report.metrics = measure();
  }
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
      metrics: report.metrics ?? measure() ?? EMPTY_METRICS,
    });
    stageIndex++;
    frameInStage = 0;
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
