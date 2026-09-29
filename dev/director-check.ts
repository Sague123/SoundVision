/**
 * Проверки режиссёра без браузера: `npm run check`.
 *
 * Режиссёр живёт на смене музыкальных состояний, поэтому почти все проверки
 * гоняют синтетическую песню (dev/song-sim.ts) через тот же конвейер, что и
 * приложение: признаки → состояние → решения → обучение.
 */

import { idleMood } from '../src/audio/mood-vector.ts';
import { AudioFeatureEngine, emptyFeatures, type AudioFeatures } from '../src/director/audio-features.ts';
import { AudioBinding } from '../src/director/binding.ts';
import { EffectSlot } from '../src/director/lifecycle.ts';
import { PreferenceModel } from '../src/director/learning.ts';
import { MusicalStateMachine, type MusicalState } from '../src/director/musical-state.ts';
import { DirectorRuntime } from '../src/director/runtime.ts';
import { defaultSettings, type Settings } from '../src/settings.ts';
import { DEFAULT_SONG, SongSimulator, type SongSegment } from './song-sim.ts';

// В Node нет localStorage — подкладываем простой, чтобы проверить сохранение памяти.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};

const FRAME_MS = 1000 / 60;
let failures = 0;

function check(name: string, condition: boolean, detail: string): void {
  if (!condition) failures++;
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

interface Trace {
  t: number;
  part: string;
  state: MusicalState;
  scene: string;
  complexity: number;
  target: number;
  typography: number;
  camera: string;
  confidence: number;
  output: boolean;
}

/** Прогон песни через конвейер режиссёра целиком. */
function runSong(
  runtime: DirectorRuntime,
  settings: Settings,
  song: SongSegment[] = DEFAULT_SONG,
  repeat = 1,
): Trace[] {
  const sim = new SongSimulator(song);
  const trace: Trace[] = [];
  const total = sim.durationSec * 1000 * repeat;
  for (let t = 0; t < total; t += FRAME_MS) {
    const local = t % (sim.durationSec * 1000);
    const mood = { ...sim.mood(local, FRAME_MS), timeMs: t };
    const step = runtime.step(mood, settings);
    trace.push({
      t: t / 1000,
      part: sim.partAt(local / 1000).part,
      state: step.state.state,
      scene: step.output?.scene.id ?? '—',
      complexity: step.output?.complexity ?? 0,
      target: step.output?.targetComplexity ?? 0,
      typography: step.output?.typography ?? 0,
      camera: step.output?.camera ?? '—',
      confidence: step.output?.confidence ?? 0,
      output: step.output !== null,
    });
  }
  return trace;
}

function sceneChanges(trace: Trace[]): Array<{ t: number; from: string; to: string }> {
  const out = [];
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].scene !== trace[i - 1].scene) out.push({ t: trace[i].t, from: trace[i - 1].scene, to: trace[i].scene });
  }
  return out;
}

function fresh(): DirectorRuntime {
  store.clear();
  return new DirectorRuntime({ persist: false });
}

// --- 1. Привязки: порог, мёртвая зона, инверсия, огибающая, задержка ---------
{
  const f = emptyFeatures();
  const at = (value: number, t: number): AudioFeatures => ({ ...f, bass: value, timeMs: t });

  const threshold = new AudioBinding({ source: 'bass', threshold: 0.5 });
  check('порог отсекает тихое', threshold.evaluate(at(0.4, 0), 0.016) === 0
    && threshold.evaluate(at(1, 16), 0.016) > 0.99, '0.4 → 0, 1 → 1');

  const dead = new AudioBinding({ source: 'bass', deadzone: 0.1 });
  check('мёртвая зона гасит дрожание у нуля', dead.evaluate(at(0.08, 0), 0.016) === 0, '0.08 → 0');

  const inv = new AudioBinding({ source: 'bass', invert: true });
  check('инверсия', Math.abs(inv.evaluate(at(0.25, 0), 0.016) - 0.75) < 1e-6, '0.25 → 0.75');

  const env = new AudioBinding({ source: 'bass', attack: 0, release: 0.5 });
  env.evaluate(at(1, 0), 0.016);
  let v = 1;
  for (let i = 1; i <= 6; i++) v = env.evaluate(at(0, i * 16), 0.016);
  check('спад плавный: через 0.1 с после обрыва ещё больше половины', v > 0.5 && v < 1, v.toFixed(2));

  const delay = new AudioBinding({ source: 'bass', delayMs: 200 });
  let early = 0;
  let late = 0;
  for (let t = 0; t <= 400; t += 16) {
    const out = delay.evaluate(at(t >= 100 ? 1 : 0, t), 0.016);
    if (t === 208) early = out;
    if (t === 320) late = out;
  }
  check('задержка: реакция приходит через 200 мс', early < 0.01 && late > 0.99,
    `на 208 мс ${early.toFixed(2)}, на 320 мс ${late.toFixed(2)}`);

  const clamp = new AudioBinding({ source: 'bass', multiplier: 3, clamp: [0, 1.5] });
  check('ограничение результата', clamp.evaluate(at(1, 0), 0.016) === 1.5, '3 → 1.5');
}

// --- 2. Признаки: полосы, тишина, стерео, голос --------------------------------
{
  const sim = new SongSimulator();
  const engine = new AudioFeatureEngine();
  const sums: Record<string, { bass: number; treble: number; vocal: number; silence: number; n: number }> = {};
  for (let t = 0; t < sim.durationSec * 1000; t += FRAME_MS) {
    const f = engine.update(sim.mood(t, FRAME_MS));
    const part = sim.partAt(t / 1000);
    // Первые две секунды каждой части — переходный процесс, не считаем.
    if (t / 1000 - part.fromSec < 2) continue;
    const s = (sums[part.part] ??= { bass: 0, treble: 0, vocal: 0, silence: 0, n: 0 });
    s.bass += f.bass; s.treble += f.treble; s.vocal += f.vocalLikelihood; s.silence += f.silenceLevel; s.n++;
  }
  const avg = (part: string, key: 'bass' | 'treble' | 'vocal' | 'silence'): number => sums[part][key] / sums[part].n;

  check('тишина распознаётся как тишина', avg('silence', 'silence') > 0.9 && avg('drop', 'silence') < 0.1,
    `тишина ${avg('silence', 'silence').toFixed(2)}, дроп ${avg('drop', 'silence').toFixed(2)}`);
  check('голос в куплете выше, чем на дропе', avg('vocal', 'vocal') > avg('drop', 'vocal') + 0.3,
    `куплет ${avg('vocal', 'vocal').toFixed(2)}, дроп ${avg('drop', 'vocal').toFixed(2)}`);

  // Полосы на отдельных спектрах: басовый и верхний.
  const bands = new AudioFeatureEngine();
  const spectrumOf = (lowHz: number, highHz: number): Float32Array => {
    const s = new Float32Array(1024);
    for (let b = 0; b < 1024; b++) {
      const hz = b * (48000 / 2048);
      s[b] = hz >= lowHz && hz < highHz ? 0.1 : 0.002;
    }
    return s;
  };
  const drive = (spectrum: Float32Array, from: number): AudioFeatures => {
    let f = emptyFeatures();
    for (let i = 0; i < 90; i++) {
      f = bands.update({ ...idleMood(from + i * FRAME_MS), spectrum, silent: false, energy: 0.6 });
    }
    return { ...f };
  };
  drive(spectrumOf(20, 16000), 0);
  const low = drive(spectrumOf(30, 140), 2000);
  const high = drive(spectrumOf(6500, 15000), 4000);
  check('бас и верх разводятся по полосам', low.bass > low.treble && high.treble > high.bass,
    `басовый: бас ${low.bass.toFixed(2)} / верх ${low.treble.toFixed(2)};`
    + ` верхний: бас ${high.bass.toFixed(2)} / верх ${high.treble.toFixed(2)}`);

  // Стерео: моно против раздвинутых каналов.
  const stereo = new AudioFeatureEngine();
  const l = new Float32Array(2048);
  const r = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) {
    l[i] = Math.sin(i * 0.05) * 0.5;
    r[i] = Math.sin(i * 0.05 + 2) * 0.5;
  }
  let mono = 0;
  let wide = 0;
  for (let i = 0; i < 120; i++) {
    mono = stereo.update({ ...idleMood(i * FRAME_MS), waveform: l, waveformRight: l, stereo: true, silent: false }).stereoWidth;
  }
  for (let i = 0; i < 120; i++) {
    wide = stereo.update({ ...idleMood(2000 + i * FRAME_MS), waveform: l, waveformRight: r, stereo: true, silent: false }).stereoWidth;
  }
  check('ширина стерео: моно узкое, разведённое широкое', mono < 0.05 && wide > 0.4,
    `моно ${mono.toFixed(2)}, широкое ${wide.toFixed(2)}`);
}

// --- 3. Музыкальное состояние на песне ----------------------------------------
{
  const sim = new SongSimulator();
  const engine = new AudioFeatureEngine();
  const machine = new MusicalStateMachine();
  const states: Array<{ t: number; state: MusicalState; part: string }> = [];
  let changes = 0;
  let lastChange = -Infinity;
  let tooFast = 0;
  for (let t = 0; t < sim.durationSec * 1000; t += FRAME_MS) {
    const snap = machine.update(engine.update(sim.mood(t, FRAME_MS)));
    states.push({ t: t / 1000, state: snap.state, part: sim.partAt(t / 1000).part });
    if (snap.changed) {
      changes++;
      // Выход из удара — единственное быстрое переключение, он сам по себе событие.
      if (t - lastChange < 500 && snap.previous !== 'IMPACT') tooFast++;
      lastChange = t;
    }
  }
  const share = (part: string, set: MusicalState[]): number => {
    const inPart = states.filter((s) => s.part === part);
    return inPart.filter((s) => set.includes(s.state)).length / inPart.length;
  };
  const firstIn = (from: number, state: MusicalState): number =>
    states.find((s) => s.t >= from && s.state === state)?.t ?? Infinity;

  check('нарастание читается как BUILD/RISING', share('build', ['BUILD', 'RISING']) > 0.6,
    `${Math.round(share('build', ['BUILD', 'RISING']) * 100)}% времени`);
  const impactAt = firstIn(29.5, 'IMPACT');
  check('дроп даёт IMPACT почти сразу', impactAt - 30 < 0.5, `через ${(impactAt - 30).toFixed(2)} с`);
  const peakAt = firstIn(30, 'PEAK');
  check('дроп устаканивается в PEAK', peakAt - 30 < 5, `через ${(peakAt - 30).toFixed(1)} с`);
  const breakdownAt = firstIn(50, 'BREAKDOWN');
  check('спад распознаётся быстро', breakdownAt - 50 < 1.5, `через ${(breakdownAt - 50).toFixed(1)} с`);
  check('куплет с голосом доходит до VOCAL_FOCUS', share('vocal', ['VOCAL_FOCUS']) > 0.4,
    `${Math.round(share('vocal', ['VOCAL_FOCUS']) * 100)}% куплета`);
  check('гистерезис: состояние не дёргается', tooFast === 0 && changes < 25,
    `${changes} смен за ${sim.durationSec} с, слишком быстрых ${tooFast}`);
}

// --- 4. Жизненный цикл эффекта -------------------------------------------------
{
  const slot = new EffectSlot('x');
  slot.enter(0, 0.8, 1000);
  slot.update(500);
  const mid = { state: slot.state, w: slot.weight };
  slot.update(1100);
  check('вход: плавно до уровня, потом active', mid.state === 'entering' && mid.w > 0 && mid.w < 0.8
    && slot.state === 'active' && Math.abs(slot.weight - 0.8) < 1e-6,
    `на середине ${mid.w.toFixed(2)} (${mid.state}), в конце ${slot.weight.toFixed(2)} (${slot.state})`);
  slot.exit(1200, 400);
  slot.update(1700);
  check('выход до нуля и dormant', slot.state === 'dormant' && slot.weight === 0, slot.state);
  slot.disable(1800);
  slot.enter(1900, 1, 100);
  slot.update(2500);
  check('выключенный пользователем не возвращается сам', slot.state === 'disabled' && slot.weight === 0, slot.state);
}

// --- 5. Режиссёр на песне -----------------------------------------------------
{
  const settings = defaultSettings();
  const runtime = fresh();
  const trace = runSong(runtime, settings);
  const changes = sceneChanges(trace);

  const dropSwitch = changes.find((c) => c.t >= 29.9 && c.t < 32);
  check('на дропе режиссёр меняет сцену в пределах секунды', dropSwitch !== undefined,
    dropSwitch ? `${dropSwitch.from} → ${dropSwitch.to} на ${dropSwitch.t.toFixed(2)} с` : 'смены нет');

  const gaps = changes.slice(1).map((c, i) => c.t - changes[i].t);
  const minGap = gaps.length ? Math.min(...gaps) : Infinity;
  check('сцены не мелькают: между сменами не меньше границы-минимума',
    minGap >= settings.focus.soloMinSec * 0.35 - 0.1,
    `${changes.length} смен, минимальный промежуток ${minGap.toFixed(1)} с`);

  const decisions = runtime.director.decisions.filter((d) => d.transition);
  const transitionGaps = decisions.slice(1).map((d, i) => d.at - decisions[i].at);
  check('переходы не чаще раза в 4 с (и вспышки < 0.25 Гц)',
    transitionGaps.every((g) => g >= 4000), `промежутки ${transitionGaps.map((g) => (g / 1000).toFixed(1)).join(', ') || '—'} с`);

  const inState = (states: MusicalState[]): Trace[] => trace.filter((s) => states.includes(s.state));
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const peak = inState(['PEAK']);
  const quiet = inState(['AMBIENT', 'BREAKDOWN']);
  check('сложность держится около цели',
    mean(peak.map((s) => s.complexity - s.target)) < 0.15 && mean(quiet.map((s) => s.complexity - s.target)) < 0.15,
    `пик ${mean(peak.map((s) => s.complexity)).toFixed(2)}/${mean(peak.map((s) => s.target)).toFixed(2)},`
    + ` тихо ${mean(quiet.map((s) => s.complexity)).toFixed(2)}/${mean(quiet.map((s) => s.target)).toFixed(2)}`);
  check('на пике кадр насыщеннее, чем в тихих частях',
    mean(peak.map((s) => s.complexity)) > mean(quiet.map((s) => s.complexity)) + 0.1,
    `пик ${mean(peak.map((s) => s.complexity)).toFixed(2)}, тихо ${mean(quiet.map((s) => s.complexity)).toFixed(2)}`);

  const vocal = inState(['VOCAL_FOCUS']).slice(120);
  check('в куплете текст выходит вперёд, на пике отступает',
    mean(vocal.map((s) => s.typography)) > mean(peak.map((s) => s.typography)) + 0.3,
    `куплет ${mean(vocal.map((s) => s.typography)).toFixed(2)}, пик ${mean(peak.map((s) => s.typography)).toFixed(2)}`);

  const silentCam = trace.filter((s) => s.state === 'SILENCE' && s.t > 2).map((s) => s.camera);
  const vocalCam = vocal.map((s) => s.camera);
  check('камера: в тишине статична, в куплете не резкая',
    silentCam.every((c) => c === 'static') && vocalCam.every((c) => c !== 'aggressive' && c !== 'impact'),
    `тишина ${[...new Set(silentCam)].join(',')}, куплет ${[...new Set(vocalCam)].join(',')}`);

  const scenesSeen = new Set(trace.map((s) => s.scene));
  check('визуальный язык меняется вместе с музыкой', scenesSeen.size >= 4,
    `${scenesSeen.size} сцен: ${[...scenesSeen].join(', ')}`);
}

// --- 6. Усталость: на однообразной музыке сцена всё же меняется ---------------
{
  const settings = defaultSettings();
  const runtime = fresh();
  // Две минуты ровного ритма без единой границы частей.
  const steady: SongSegment[] = [{ part: 'vocal', fromSec: 0, toSec: 120 }];
  const trace = runSong(runtime, settings, steady);
  const changes = sceneChanges(trace).filter((c) => c.t > 5);
  const gaps = changes.slice(1).map((c, i) => c.t - changes[i].t);
  check('на ровной музыке сцена сменяется от усталости, но не чаще выдержки',
    changes.length >= 1 && gaps.every((g) => g >= settings.focus.soloMinSec - 0.5),
    `${changes.length} смен, промежутки ${gaps.map((g) => g.toFixed(0)).join(', ') || '—'} с`);
}

// --- 7. Выключенный модуль, закреплённая сцена, ручной режим ------------------
{
  const settings = defaultSettings();
  settings.primitives.spectrum.enabled = false;
  const trace = runSong(fresh(), settings);
  check('сцена с выключенным главным модулем не выбирается',
    !trace.some((s) => s.scene === 'spectrum-stage'), [...new Set(trace.map((s) => s.scene))].join(', '));

  const semi = defaultSettings();
  semi.director.mode = 'semi';
  semi.director.lockedScene = 'radial-core';
  const semiTrace = runSong(fresh(), semi).filter((s) => s.t > 8);
  check('полуавтомат держит закреплённую сцену', semiTrace.every((s) => s.scene === 'radial-core'),
    [...new Set(semiTrace.map((s) => s.scene))].join(', '));

  const manual = defaultSettings();
  manual.director.mode = 'manual';
  const manualTrace = runSong(fresh(), manual).slice(0, 600);
  check('в ручном режиме режиссёр молчит', manualTrace.every((s) => !s.output), '');
}

// --- 8. Обучение: контекст, а не «нравится вообще» ----------------------------
{
  let clock = 1_000_000;
  const model = new PreferenceModel(() => [], () => clock);
  const drop = { energy: 0.9, bass: 0.9, transient: 0.8, vocal: 0.1, flux: 0.6 };
  const verse = { energy: 0.3, bass: 0.3, transient: 0.2, vocal: 0.8, flux: 0.2 };
  for (let i = 0; i < 6; i++) {
    clock += 60_000;
    model.record({ timestamp: clock, audioContext: drop, musicalState: 'PEAK', scene: 's',
      effect: 'scene:spectrum-stage', userFeedback: 1, kind: 'explicit', signal: 'проверка' });
    model.record({ timestamp: clock, audioContext: verse, musicalState: 'VOCAL_FOCUS', scene: 's',
      effect: 'scene:spectrum-stage', userFeedback: -1, kind: 'explicit', signal: 'проверка' });
  }
  const onDrop = model.preference('scene:spectrum-stage', 'PEAK', drop);
  const onVerse = model.preference('scene:spectrum-stage', 'VOCAL_FOCUS', verse);
  const unseen = model.preference('scene:spectrum-stage', 'RHYTHMIC', { ...drop, energy: 0.55 });
  check('нравится на дропе, не нравится в куплете', onDrop.value > 0.6 && onVerse.value < -0.6,
    `дроп ${onDrop.value.toFixed(2)}, куплет ${onVerse.value.toFixed(2)}`);
  check('в незнакомом контексте режиссёр не уверен — и спросит', unseen.certainty < 0.2 && onDrop.certainty > 0.6,
    `незнакомый ${unseen.certainty.toFixed(2)}, знакомый ${onDrop.certainty.toFixed(2)}`);

  // Вкус меняется: полугодовой давности наблюдения почти ничего не весят.
  clock += 180 * 24 * 3600 * 1000;
  const old = model.preference('scene:spectrum-stage', 'PEAK', drop);
  check('старые наблюдения забываются', old.certainty < onDrop.certainty * 0.3,
    `уверенность ${onDrop.certainty.toFixed(2)} → ${old.certainty.toFixed(2)} через полгода`);
}

// --- 9. Режиссёр пользуется выученным -----------------------------------------
{
  const settings = defaultSettings();
  const baseline = fresh();
  const plain = sceneChanges(runSong(baseline, settings)).find((c) => c.t >= 29.9 && c.t < 32)?.to;

  // Зритель несколько раз отверг именно эту сцену на дропе.
  const taught = fresh();
  runSong(taught, settings, [{ part: 'drop', fromSec: 0, toSec: 6 }]);
  for (let i = 0; i < 5; i++) taught.director.feedback(`scene:${plain}` as `scene:${string}`, -1, 'explicit', 'проверка');
  const trace = runSong(taught, settings);
  const learned = sceneChanges(trace).find((c) => c.t >= 29.9 && c.t < 32)?.to;
  check('отвергнутую на дропе сцену режиссёр больше не ставит на дроп', plain !== undefined && learned !== plain,
    `без обучения ${plain}, после ${learned ?? 'смены нет'}`);
}

// --- 10. Режим обучения: редко, не на ударе, с учётом ответа -------------------
{
  const settings = defaultSettings();
  settings.director.training = true;
  settings.director.trainingIntervalSec = 30;
  const runtime = fresh();
  const sim = new SongSimulator();
  let asked = 0;
  let duringImpact = 0;
  let previous: object | null = null;
  const opened: number[] = [];
  const recordedBefore = runtime.model.observationCount;
  for (let t = 0; t < sim.durationSec * 1000 * 2; t += FRAME_MS) {
    const local = t % (sim.durationSec * 1000);
    const step = runtime.step({ ...sim.mood(local, FRAME_MS), timeMs: t }, settings);
    const q = step.question;
    if (q && q !== previous) {
      asked++;
      opened.push(t);
      if (q.state === 'IMPACT') duringImpact++;
      // Отвечаем на каждый второй вопрос, остальные пропускаем.
      if (asked % 2 === 1) runtime.coach.answer(0, t);
    }
    previous = q;
  }
  const gaps = opened.slice(1).map((t, i) => (t - opened[i]) / 1000);
  check('вопросы редкие и не на ударе',
    asked >= 1 && duringImpact === 0 && gaps.every((g) => g >= settings.director.trainingIntervalSec),
    `${asked} вопросов за ${(sim.durationSec * 2).toFixed(0)} с, промежутки ${gaps.map((g) => g.toFixed(0)).join(', ') || '—'} с`);
  check('ответ записывается в память', runtime.model.observationCount > recordedBefore,
    `наблюдений ${runtime.model.observationCount}`);

  const off = defaultSettings();
  let offAsked = 0;
  const quiet = fresh();
  for (let t = 0; t < 60000; t += FRAME_MS) {
    if (quiet.step({ ...sim.mood(t, FRAME_MS), timeMs: t }, off).question) offAsked++;
  }
  check('без режима обучения вопросов нет', offAsked === 0, `${offAsked}`);
}

// --- 11. Сюрприз: редкий, заметный и отключаемый -----------------------------
{
  /*
   * Прежняя версия этой проверки проходила вхолостую: за 400 секунд песни не
   * случилось ни одного сюрприза — и с включёнными, и с выключенными, — так
   * что «выключенные дают ноль» ничего не доказывало. Сюрпризу нужна сцена,
   * простоявшая дольше 25 секунд к моменту удара, а в обычной песне каждый
   * удар приходится на смену сцены. Здесь условия созданы явно: долгий ровный
   * участок без усталостных смен и затем удар.
   */
  const song: SongSegment[] = [
    { part: 'intro', fromSec: 0, toSec: 140 },
    { part: 'drop', fromSec: 140, toSec: 150 },
  ];
  const run = (surprise: boolean): { count: number; peak: number; sceneDuring: number; sceneAfter: number } => {
    const settings = defaultSettings();
    settings.director.surprise = surprise;
    // Без усталостных смен: сцена стоит с начала и до удара.
    settings.focus.soloMaxSec = 600;
    const runtime = fresh();
    const sim = new SongSimulator(song);
    let at = -1;
    let peak = 0;
    let sceneDuring = 1;
    let sceneAfter = 0;
    for (let t = 0; t < sim.durationSec * 1000; t += FRAME_MS) {
      const step = runtime.step(sim.mood(t, FRAME_MS), settings);
      const out = step.output!;
      if (out.surprise && at < 0) at = t;
      if (at >= 0 && t - at < 500) {
        // Пока длится сюрприз: одна яркая форма, всё остальное почти погасло.
        const layers = out.scene.layers.map((l) => out.weights.get(l.primitive) ?? 0);
        const others = [...out.weights.entries()]
          .filter(([id]) => !out.scene.layers.some((l) => l.primitive === id))
          .map(([, w]) => w);
        peak = Math.max(peak, ...others);
        // Вся середина сюрприза, а не его начало: раньше сцена возвращалась
        // досрочно, и проверка по первой четверти этого не видела.
        if (t - at > 200) sceneDuring = Math.max(sceneDuring === 1 ? 0 : sceneDuring, Math.max(...layers));
      }
      // Сразу после сюрприза, но до того, как режиссёр мог сменить сцену
      // (удар держится 1.4 с): сцена должна вернуться на место.
      if (at >= 0 && t - at > 1000 && t - at < 1100) {
        sceneAfter = Math.max(...out.scene.layers.map((l) => out.weights.get(l.primitive) ?? 0));
      }
    }
    const count = runtime.director.decisions.filter((d) => d.reason === 'сюрприз на ударе').length;
    return { count, peak, sceneDuring, sceneAfter };
  };
  const on = run(true);
  const off = run(false);
  check('сюрприз случается на сильном ударе после долгой сцены', on.count === 1,
    `сюрпризов ${on.count}`);
  check('сюрприз: одна яркая форма, сцена почти гаснет, потом возвращается',
    on.peak > 0.8 && on.sceneDuring < 0.15 && on.sceneAfter > 0.5,
    `форма ${on.peak.toFixed(2)}, сцена во время ${on.sceneDuring.toFixed(2)}, после ${on.sceneAfter.toFixed(2)}`);
  check('сюрпризы выключаются настройкой', off.count === 0, `с выключенными ${off.count}`);
}

// --- 12. Память переживает перезапуск ----------------------------------------
{
  store.clear();
  const first = new DirectorRuntime();
  runSong(first, defaultSettings(), [{ part: 'drop', fromSec: 0, toSec: 3 }]);
  first.like();
  first.like();
  first.flush();
  const second = new DirectorRuntime();
  check('выученное сохраняется и читается при запуске', second.model.observationCount === first.model.observationCount
    && first.model.observationCount >= 2,
    `до ${first.model.observationCount}, после перезапуска ${second.model.observationCount}`);
  const exported = JSON.parse(second.model.export()) as { events: unknown[]; profile: object };
  check('память выгружается в JSON', Array.isArray(exported.events) && typeof exported.profile === 'object', '');
}

// --- 13. Каждая привязка сцены до чего-то доходит ------------------------------
{
  /*
   * Привязка `warp` была описана во всех сценах, но режиссёр её не читал —
   * мёртвый конфиг, который ни одна проверка не ловила. Здесь каждая
   * объявленная привязка обязана менять выход режиссёра хоть как-то.
   */
  const settings = defaultSettings();
  const runtime = fresh();
  const sim = new SongSimulator([{ part: 'drop', fromSec: 0, toSec: 20 }]);
  const seen = { primaryPulse: false, glow: false, particleBoost: false, cameraKick: false, warp: false };
  let prev: { bloom: number; density: number; camera: number; warp: number; primary: number } | null = null;
  for (let t = 0; t < 20000; t += FRAME_MS) {
    const out = runtime.step(sim.mood(t, FRAME_MS), settings).output!;
    const primary = out.scene.layers.find((l) => l.role === 'primary')!.primitive;
    const now = {
      bloom: out.bloom, density: out.particleDensity, camera: out.cameraAmount,
      warp: out.modifiers.warp, primary: out.weights.get(primary) ?? 0,
    };
    if (prev && t > 3000) {
      if (Math.abs(now.primary - prev.primary) > 1e-4) seen.primaryPulse = true;
      if (Math.abs(now.bloom - prev.bloom) > 1e-4) seen.glow = true;
      if (now.density - prev.density > 1e-3) seen.particleBoost = true;
      if (Math.abs(now.camera - prev.camera) > 1e-4) seen.cameraKick = true;
      if (now.warp > 0.01) seen.warp = true;
    }
    prev = now;
  }
  const dead = Object.entries(seen).filter(([, v]) => !v).map(([k]) => k);
  check('каждая привязка сцены меняет выход режиссёра', dead.length === 0, dead.length ? `мёртвые: ${dead.join(', ')}` : 'все пять живые');
}

console.log(failures === 0 ? '\nрежиссёр: всё сошлось' : `\nрежиссёр: проблем ${failures}`);
process.exit(failures === 0 ? 0 : 1);
