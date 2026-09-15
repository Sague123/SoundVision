/**
 * Проверка сцены и цвета без браузера: `npm run check`.
 *
 * Здесь проверяется то, что на глаз в потоке кадров не поймать — что эхо
 * приходит ровно в доли такта, что палитра мигрирует, а не прыгает, и что
 * оттенок действительно ходит по квинтовому кругу.
 */

import { idleMood, type MoodVector } from '../src/audio/mood-vector.ts';
import { tonicHue } from '../src/render/color/harmony.ts';
import { findHarmony } from '../src/render/palette.ts';
import { PaletteEngine, defaultTuning } from '../src/render/palette.ts';
import { Generator } from '../src/render/generator.ts';
import { Scene } from '../src/render/scene.ts';
import { defaultSettings } from '../src/settings.ts';
import { makeSeed } from '../src/render/seed.ts';
import type { NoteName } from '../src/audio/chroma.ts';

const FRAME_MS = 1000 / 60;
let failures = 0;

function check(name: string, condition: boolean, detail: string): void {
  if (!condition) failures++;
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function moodAt(timeMs: number, overrides: Partial<MoodVector> = {}): MoodVector {
  return { ...idleMood(timeMs), deltaMs: FRAME_MS, silent: false, ...overrides };
}

// --- 1. Память: эхо приходит через 1/4 и 1/2 такта ---------------------------
{
  const scene = new Scene();
  scene.reseed(makeSeed('проверка эха'));

  const bpm = 120; // такт = 4 доли по 500 мс = 2000 мс
  const barMs = (60000 / bpm) * 4;
  const births: Array<{ atMs: number; echo: boolean }> = [];
  let seen = 0;

  for (let frame = 0; frame < 200; frame++) {
    const timeMs = frame * FRAME_MS;
    // Один сильный удар в самом начале, дальше тишина.
    const mood = moodAt(timeMs, {
      bpm,
      onset: frame === 0,
      onsetStrength: frame === 0 ? 0.9 : 0,
      energy: 0.5,
    });
    const state = scene.update(mood, 1);
    for (const impulse of state.impulses) {
      if (impulse.id > seen) {
        seen = impulse.id;
        births.push({ atMs: timeMs, echo: impulse.echo });
      }
    }
  }

  const originals = births.filter((b) => !b.echo);
  const echoes = births.filter((b) => b.echo);
  check('один удар — один исходный импульс', originals.length === 1, `их ${originals.length}`);
  check('память дала два эха', echoes.length === 2, `их ${echoes.length}`);

  if (echoes.length === 2) {
    const expected = [barMs * 0.25, barMs * 0.5].sort((a, b) => a - b);
    const actual = echoes.map((e) => e.atMs).sort((a, b) => a - b);
    for (let i = 0; i < 2; i++) {
      const error = Math.abs(actual[i] - expected[i]);
      check(
        `эхо ${i + 1} в доле такта`,
        error <= FRAME_MS * 1.5,
        `ожидали ${expected[i].toFixed(0)} мс, пришло ${actual[i].toFixed(0)} мс`,
      );
    }
  }
}

// --- 2. Вещество: ось непрерывна, без скачков --------------------------------
{
  const scene = new Scene();
  scene.reseed(makeSeed('проверка вещества'));

  let previous = scene.update(moodAt(0, { noisiness: 0, brightness: 0 }), 1).substance.axis;
  let worstJump = 0;

  for (let frame = 1; frame < 240; frame++) {
    // Резко переключаем звук с тихого чистого на шумный яркий и обратно.
    const loud = frame > 60 && frame < 180;
    const state = scene.update(
      moodAt(frame * FRAME_MS, {
        noisiness: loud ? 0.95 : 0.02,
        brightness: loud ? 0.9 : 0.05,
        energy: loud ? 0.9 : 0.05,
        section: loud ? 'drop' : 'calm',
      }),
      1,
    );
    worstJump = Math.max(worstJump, Math.abs(state.substance.axis - previous));
    previous = state.substance.axis;
  }
  check(
    'ось вещества движется непрерывно',
    worstJump < 0.02,
    `самый резкий шаг за кадр ${worstJump.toFixed(4)}`,
  );
}

// --- 3. Цвет: тоника по квинтовому кругу -------------------------------------
{
  const distance = (a: NoteName, b: NoteName): number => {
    const diff = Math.abs(tonicHue(a) - tonicHue(b)) % 360;
    return diff > 180 ? 360 - diff : diff;
  };
  check('до и соль — соседние цвета', distance('C', 'G') === 30, `${distance('C', 'G')}°`);
  check('до и фа — соседние цвета', distance('C', 'F') === 30, `${distance('C', 'F')}°`);
  check('до и фа-диез — противоположные', distance('C', 'F#') === 180, `${distance('C', 'F#')}°`);
  const hues = new Set(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    .map((note) => tonicHue(note as NoteName)));
  check('все двенадцать тоник дают разные оттенки', hues.size === 12, `различных ${hues.size}`);
}

// --- 4. Цвет: миграция, а не скачок ------------------------------------------
{
  const engine = new PaletteEngine();
  const harmony = findHarmony('analogous');
  const base = {
    tuning: defaultTuning(),
    harmony,
    seedHueShift: 0,
    cover: { url: '', image: null, colors: [] },
    useCover: false,
  };

  // Сначала стабилизируемся в до мажоре.
  for (let frame = 0; frame < 180; frame++) {
    engine.build({ ...base, mood: moodAt(frame * FRAME_MS, { key: { tonic: 'C', mode: 'major', confidence: 1 } }) });
  }
  const before = engine.build({
    ...base,
    mood: moodAt(180 * FRAME_MS, { key: { tonic: 'C', mode: 'major', confidence: 1 } }),
  }).hue;

  // Резкая смена тональности на противоположную по кругу.
  const hues: number[] = [];
  for (let frame = 181; frame < 181 + 180; frame++) {
    hues.push(engine.build({
      ...base,
      mood: moodAt(frame * FRAME_MS, { key: { tonic: 'F#', mode: 'major', confidence: 1 } }),
    }).hue);
  }

  const step = Math.abs(hues[0] - before);
  const wrappedStep = step > 180 ? 360 - step : step;
  check('смена тональности не даёт скачка', wrappedStep < 6, `первый кадр сдвинул на ${wrappedStep.toFixed(2)}°`);

  // Цель — не голый оттенок тоники: поверх него лежит температурный сдвиг лада.
  // Поэтому сравниваем с установившимся значением, а не с tonicHue('F#').
  let settled = 0;
  for (let frame = 0; frame < 900; frame++) {
    settled = engine.build({
      ...base,
      mood: moodAt((400 + frame) * FRAME_MS, { key: { tonic: 'F#', mode: 'major', confidence: 1 } }),
    }).hue;
  }
  const temperatureShift = Math.abs(((settled - tonicHue('F#') + 540) % 360) - 180);
  check('температура лада сдвигает оттенок', temperatureShift > 8, `сдвиг ${temperatureShift.toFixed(1)}°`);

  const after1_5s = hues[Math.round(1500 / FRAME_MS)];
  const remaining = Math.abs(((after1_5s - settled + 540) % 360) - 180);
  check('за 1.5 с палитра доезжает до новой тональности', remaining < 12, `осталось ${remaining.toFixed(1)}°`);
}

// --- 5. Вещество выбирает примитивы -----------------------------------------
{
  // Нужен seed, в пуле которого есть и «туманный», и «плазменный» примитив.
  let salt = 0;
  let seed = makeSeed('проверка оси', salt);
  while (!(seed.pool.includes('flow-field') && seed.pool.includes('raymarch')) && salt < 200) {
    seed = makeSeed('проверка оси', ++salt);
  }

  const leaderFor = (quiet: boolean): string => {
    const generator = new Generator('проверка оси');
    // Reshuffle до того же пула, что нашли выше.
    for (let i = 0; i < salt; i++) generator.reshuffle();

    const scene = new Scene();
    scene.reseed(generator.seed);
    const settings = defaultSettings();
    settings.generator.mode = 'auto';

    let weights = new Map<string, number>();
    for (let frame = 0; frame < 900; frame++) {
      const mood = moodAt(frame * FRAME_MS, quiet
        ? { noisiness: 0.02, brightness: 0.05, energy: 0.12, section: 'calm' }
        : { noisiness: 0.95, brightness: 0.9, energy: 0.9, section: 'drop' });
      const state = generator.update(mood, settings, scene.update(mood, 1));
      weights = state.weights as Map<string, number>;
    }
    return [...weights.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  const quietLeader = leaderFor(true);
  const loudLeader = leaderFor(false);
  check('в тишине ведёт «туманный» примитив', quietLeader === 'flow-field', `ведёт ${quietLeader}`);
  check('на шумном пике ведёт «плазменный»', loudLeader === 'raymarch', `ведёт ${loudLeader}`);
}

console.log(failures === 0 ? '\nвсё сошлось' : `\nпроблем: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
