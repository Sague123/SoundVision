/**
 * Проверка аудио-анализа на синтетических сигналах — без захвата экрана.
 *
 * Нужна для калибровки: сюда подаётся сигнал с заранее известной тональностью
 * и темпом, и видно, что именно отвечает детектор. Открывается на `npm run dev`
 * по адресу /dev/audio-check.html.
 */

import { FFT_SIZE } from '../src/audio/capture.ts';
import { MoodEngine, DEFAULT_MOOD_CONFIG, type MoodVector } from '../src/audio/mood-vector.ts';

interface CheckResult {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

interface CheckReport {
  done: boolean;
  results: CheckResult[];
}

const report: CheckReport = { done: false, results: [] };
(window as unknown as { __audioCheck: CheckReport }).__audioCheck = report;

const out = document.getElementById('out') as HTMLPreElement;

function log(line: string): void {
  out.textContent += `${line}\n`;
}

/** Ноты равномерного строя от A4 = 440 Гц. */
function hz(semitonesFromA4: number): number {
  return 440 * Math.pow(2, semitonesFromA4 / 12);
}

function buildGraph(): { context: AudioContext; analyser: AnalyserNode } {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -10;
  return { context, analyser };
}

/** Прогон движка в реальном времени: анализатору нужен настоящий поток сэмплов. */
async function run(
  analyser: AnalyserNode,
  context: AudioContext,
  durationMs: number,
): Promise<MoodVector> {
  const engine = new MoodEngine({ context, analyser });
  const started = performance.now();
  let last: MoodVector = engine.update(started, DEFAULT_MOOD_CONFIG);

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      last = engine.update(now, DEFAULT_MOOD_CONFIG);
      if (now - started >= durationMs) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return last;
}

/** Аккорд из трёх синусов: чистая проверка chroma и Krumhansl-Schmuckler. */
async function checkChord(name: string, semitones: number[], expected: string, durationMs: number): Promise<void> {
  const { context, analyser } = buildGraph();
  await context.resume();

  const master = context.createGain();
  master.gain.value = 0.25;
  master.connect(analyser);

  for (const semitone of semitones) {
    const osc = context.createOscillator();
    osc.type = 'triangle'; // немного обертонов, ближе к реальному инструменту
    osc.frequency.value = hz(semitone);
    osc.connect(master);
    osc.start();
  }

  const mood = await run(analyser, context, durationMs);
  const actual = `${mood.key.tonic} ${mood.key.mode}`;
  report.results.push({ name, expected, actual, pass: actual === expected });
  log(`${name}: ожидали ${expected}, получили ${actual} (conf ${mood.key.confidence.toFixed(2)})`);
  await context.close();
}

/** Клик-трек с известным темпом: проверка onset-детектора и автокорреляции. */
async function checkTempo(bpm: number, durationMs: number): Promise<void> {
  const { context, analyser } = buildGraph();
  await context.resume();

  const gain = context.createGain();
  gain.gain.value = 0;
  gain.connect(analyser);

  const osc = context.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 180;
  osc.connect(gain);
  osc.start();

  // Короткие щелчки строго в темпе: каждый даёт всплеск spectral flux.
  const beatSeconds = 60 / bpm;
  const beats = Math.ceil(durationMs / 1000 / beatSeconds) + 2;
  for (let i = 0; i < beats; i++) {
    const at = context.currentTime + 0.1 + i * beatSeconds;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.9, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
  }

  const mood = await run(analyser, context, durationMs);
  const error = Math.abs(mood.bpm - bpm);
  report.results.push({
    name: `темп ${bpm} BPM`,
    expected: `${bpm} ± 6`,
    actual: mood.bpm.toFixed(1),
    pass: error <= 6,
  });
  log(`темп: ожидали ${bpm}, получили ${mood.bpm.toFixed(1)} (отклонение ${error.toFixed(1)}, conf ${mood.beatConfidence.toFixed(2)})`);
  await context.close();
}

async function main(): Promise<void> {
  log('Проверка аудио-анализа на синтетике. Это занимает около 30 секунд.\n');
  // A minor: A C E. C major: C E G.
  await checkChord('тональность A minor', [0, 3, 7], 'A minor', 7000);
  await checkChord('тональность C major', [3, 7, 10], 'C major', 7000);
  await checkTempo(128, 14000);

  report.done = true;
  const passed = report.results.filter((result) => result.pass).length;
  log(`\nитог: ${passed} из ${report.results.length}`);
}

void main();
