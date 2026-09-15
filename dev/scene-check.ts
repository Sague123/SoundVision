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
import { FlowField } from '../src/render/flow-field.ts';
import { Generator } from '../src/render/generator.ts';
import { ParticleSystem } from '../src/render/particles.ts';
import {
  Scene, classifyImpulse, defaultSceneConfig, type ImpulseKind,
} from '../src/render/scene.ts';
import { PostPass } from '../src/render/post-pass.ts';
import {
  MAX_SAFE_FLASH_HZ, PRESET_PROFILES, defaultSettings, mergeSettings,
} from '../src/settings.ts';
import { ALL_PRIMITIVE_IDS } from '../src/render/primitives/types.ts';
import { PRIMITIVE_PARAMS, resolvePrimitiveParams } from '../src/render/primitives/tuning.ts';
import { exportPresets } from '../src/ui/presets.ts';
import { makeSeed } from '../src/render/seed.ts';
import type { NoteName } from '../src/audio/chroma.ts';
import type { BandProfile } from '../src/audio/features.ts';

const FRAME_MS = 1000 / 60;
/** Все эффекты разрешены на полную: проверки смотрят механику, а не вкус. */
const SCENE_CONFIG = { ...defaultSceneConfig(), intensity: 1, deformation: 1 };
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
  // Рисунок эха выбирает seed трека, поэтому ожидаемые моменты берём у сцены,
  // а не зашиваем: проверяем механику, а не конкретный рисунок.
  const divisions = [...scene.update(moodAt(0, { bpm }), SCENE_CONFIG).memory.echoDivisions];
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
    const state = scene.update(mood, SCENE_CONFIG);
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
  check('память дала эхо на каждую долю рисунка', echoes.length === divisions.length,
    `рисунок ${divisions.join('/')}, эх ${echoes.length}`);

  if (echoes.length === divisions.length) {
    const expected = divisions.map((d) => barMs * d).sort((a, b) => a - b);
    const actual = echoes.map((e) => e.atMs).sort((a, b) => a - b);
    for (let i = 0; i < expected.length; i++) {
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

  let previous = scene.update(moodAt(0, { noisiness: 0, brightness: 0 }), SCENE_CONFIG).substance.axis;
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
      SCENE_CONFIG,
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
  // Порядок примитивов по оси вещества: от тумана к плазме.
  const SUBSTANCE_ORDER = [
    'flow-field', 'waveform-terrain', 'l-system', 'wave-mesh', 'metaballs',
    'radial-waveform', 'oscilloscope', 'voronoi', 'cellular', 'kaleidoscope',
    'spectrum', 'raymarch',
  ];

  // Нужен seed, в пуле которого есть и «туманный», и «плазменный» примитив.
  let salt = 0;
  let seed = makeSeed('проверка оси', salt);
  while (!(seed.pool.includes('flow-field') && seed.pool.includes('raymarch')) && salt < 200) {
    seed = makeSeed('проверка оси', ++salt);
  }

  /**
   * Соло меняется только на границе секции и не чаще, чем раз в 22 секунды,
   * поэтому прогон обязан содержать смены секции — иначе соло так и останется
   * тем, с которым генератор стартовал.
   */
  const leaderFor = (quiet: boolean): string => {
    const generator = new Generator('проверка оси');
    for (let i = 0; i < salt; i++) generator.reshuffle();

    const scene = new Scene();
    scene.reseed(generator.seed);
    const settings = defaultSettings();
    settings.generator.mode = 'auto';

    let solo = '';
    for (let frame = 0; frame < 60 * 200; frame++) {
      const timeMs = frame * FRAME_MS;
      // Секция дёргается каждые 25 секунд: даём системе фокуса возможность
      // сменить соло, но не чаще её собственного лимита.
      const flip = Math.floor(timeMs / 25_000) % 2 === 1;
      const mood = moodAt(timeMs, quiet
        ? { noisiness: 0.02, brightness: 0.05, energy: 0.12, section: flip ? 'calm' : 'steady' }
        : { noisiness: 0.95, brightness: 0.9, energy: 0.9, section: flip ? 'drop' : 'buildup' });
      solo = generator.update(mood, settings, scene.update(mood, SCENE_CONFIG)).focus.solo;
    }
    return solo;
  };

  const quietLeader = leaderFor(true);
  const loudLeader = leaderFor(false);
  check('в тишине соло уходит к «туманному» краю оси',
    SUBSTANCE_ORDER.indexOf(quietLeader) < SUBSTANCE_ORDER.indexOf(loudLeader),
    `тишина ${quietLeader}, пик ${loudLeader}`);
}

// --- 6. Классификация удара по частотному профилю ----------------------------
{
  const cases: Array<[string, BandProfile, ImpulseKind]> = [
    ['бочка', { low: 1, mid: 0.3, high: 0.1 }, 'bass'],
    ['снейр', { low: 0.3, mid: 1, high: 0.5 }, 'snare'],
    ['хай-хэт', { low: 0.1, mid: 0.4, high: 1 }, 'hat'],
    ['широкополосный', { low: 0.9, mid: 1, high: 0.95 }, 'broad'],
  ];
  for (const [name, profile, expected] of cases) {
    const actual = classifyImpulse(profile);
    check(`профиль «${name}»`, actual === expected, `ожидали ${expected}, получили ${actual}`);
  }
}

// --- 7. Лестница эффектов по силе удара --------------------------------------
{
  /**
   * Прогоняет один удар заданной силы и возвращает, что успело сработать.
   *
   * `substance` прогревает вещество до нужного места на оси: рябь по спеке —
   * отклик именно жидкого вещества, на тумане её быть не должно.
   * Flux держим постоянным: его скачок — самостоятельный источник импульса,
   * и он бы перебил ту силу удара, которую мы here проверяем.
   */
  const fire = (
    strength: number,
    profile: BandProfile,
    drop: boolean,
    substance: Partial<MoodVector> = {},
  ) => {
    const scene = new Scene();
    scene.reseed(makeSeed(`лестница ${strength}`));
    // Прогрев: 4 секунды, чтобы ось вещества успела доехать (её постоянная 1.6 с).
    for (let frame = 0; frame < 240; frame++) {
      scene.update(moodAt(frame * FRAME_MS, { energy: 0.4, flux: 0.2, ...substance }), SCENE_CONFIG);
    }

    let peak = {
      shockwaves: 0, ripples: 0, lens: 0, chromatic: 0, slice: 0, pressure: 0, shake: 0,
    };
    for (let frame = 240; frame < 290; frame++) {
      const hit = frame === 241;
      const state = scene.update(moodAt(frame * FRAME_MS, {
        energy: drop ? 0.9 : 0.4,
        flux: 0.4,
        ...substance,
        onset: hit,
        onsetStrength: hit ? strength : 0,
        onsetProfile: hit ? profile : { low: 0, mid: 0, high: 0 },
        section: drop ? 'drop' : 'steady',
      }), SCENE_CONFIG);
      peak = {
        shockwaves: Math.max(peak.shockwaves, state.impact.shockwaves.length),
        ripples: Math.max(peak.ripples, state.impact.ripples.length),
        lens: Math.max(peak.lens, Math.abs(state.impact.lensPulse)),
        chromatic: Math.max(peak.chromatic, state.impact.chromaticBurst),
        slice: Math.max(peak.slice, state.impact.slice),
        pressure: Math.max(peak.pressure, state.impact.pressure),
        shake: Math.max(peak.shake, Math.abs(state.camera.x) + Math.abs(state.camera.y)),
      };
    }
    return peak;
  };

  const bass: BandProfile = { low: 1, mid: 0.2, high: 0.05 };
  const weak = fire(0.18, bass, false);
  check('слабый удар двигает камеру', weak.shake > 0, `сдвиг ${weak.shake.toFixed(4)}`);
  check(
    'слабый удар не запускает тяжёлые эффекты',
    weak.shockwaves === 0 && weak.chromatic === 0 && weak.lens === 0,
    `волн ${weak.shockwaves}, RGB ${weak.chromatic.toFixed(2)}, линза ${weak.lens.toFixed(2)}`,
  );

  const strong = fire(0.85, bass, false);
  check('сильный бас даёт ударную волну', strong.shockwaves > 0, `волн ${strong.shockwaves}`);
  check('сильный удар даёт линзу и разлёт каналов',
    strong.lens > 0 && strong.chromatic > 0,
    `линза ${strong.lens.toFixed(2)}, RGB ${strong.chromatic.toFixed(2)}`);

  const drop = fire(0.9, bass, true);
  check('дроп добавляет волну давления', drop.pressure > 0, `давление ${drop.pressure.toFixed(2)}`);

  // Само существование лестницы: чем сильнее удар, тем больше эффектов разом.
  const countActive = (p: typeof weak): number =>
    (p.shockwaves > 0 ? 1 : 0) + (p.ripples > 0 ? 1 : 0) + (p.lens > 0 ? 1 : 0)
    + (p.chromatic > 0 ? 1 : 0) + (p.slice > 0 ? 1 : 0) + (p.pressure > 0 ? 1 : 0);
  const ladder = [countActive(weak), countActive(strong), countActive(drop)];
  check(
    'число одновременных эффектов растёт с силой удара',
    ladder[0] < ladder[1] && ladder[1] <= ladder[2],
    `слабый ${ladder[0]} → сильный ${ladder[1]} → дроп ${ladder[2]}`,
  );

  // Рябь — отклик жидкого вещества на средний удар, а не баса и не на тумане.
  const liquid = { noisiness: 0.3, brightness: 0.35, energy: 0.45 };
  const mid = fire(0.6, { low: 0.2, mid: 1, high: 0.4 }, false, liquid);
  check('средний удар на жидком веществе даёт рябь, а не ударную волну',
    mid.ripples > 0 && mid.shockwaves === 0,
    `ряби ${mid.ripples}, волн ${mid.shockwaves}`);

  const fog = { noisiness: 0.02, brightness: 0.05, energy: 0.15 };
  const midOnFog = fire(0.6, { low: 0.2, mid: 1, high: 0.4 }, false, fog);
  check('на тумане ряби нет', midOnFog.ripples === 0, `ряби ${midOnFog.ripples}`);
}

// --- 8. Направление тряски от частотного профиля -----------------------------
{
  /**
   * Тряска берёт случайность из отдельного seed-потока, поэтому прогон
   * воспроизводим. Дрейф и орбита в обоих прогонах одни и те же, так что
   * разница с выключенной тряской — это ровно она сама.
   */
  const shakeOnly = (profile: BandProfile): { x: number; y: number } => {
    const run = (shake: boolean): { x: number; y: number } => {
      const scene = new Scene();
      scene.reseed(makeSeed('тряска'));
      // Бюджет обязательно снят: он ужимает движение по суммарной нагрузке,
      // а она у прогонов с тряской и без неё разная — база перестала бы быть чистой.
      const config = { ...SCENE_CONFIG, shake, budget: 0 };
      let x = 0;
      let y = 0;
      for (let frame = 0; frame < 600; frame++) {
        const hit = frame % 12 === 0;
        const state = scene.update(moodAt(frame * FRAME_MS, {
          energy: 0.6,
          flux: 0.3,
          onset: hit,
          onsetStrength: hit ? 0.9 : 0,
          onsetProfile: hit ? profile : { low: 0, mid: 0, high: 0 },
        }), config);
        x += Math.abs(state.camera.x);
        y += Math.abs(state.camera.y);
      }
      return { x, y };
    };
    const on = run(true);
    const off = run(false);
    return { x: Math.abs(on.x - off.x), y: Math.abs(on.y - off.y) };
  };

  const low = shakeOnly({ low: 1, mid: 0.2, high: 0.05 });
  const high = shakeOnly({ low: 0.05, mid: 0.3, high: 1 });
  // Сравниваем оси напрямую, а не отношение отношений: у баса горизонтальная
  // составляющая близка к нулю, и частное от неё скачет на порядки.
  check(
    'бас трясёт по вертикали сильнее верха',
    low.y > high.y * 1.25,
    `низ ${low.y.toFixed(2)} против верха ${high.y.toFixed(2)}`,
  );
  check(
    'верх трясёт по горизонтали сильнее баса',
    high.x > low.x * 3,
    `верх ${high.x.toFixed(2)} против низа ${low.x.toFixed(2)}`,
  );
}

// --- 9. Punch zoom возвращается упруго ---------------------------------------
{
  const scene = new Scene();
  scene.reseed(makeSeed('наезд'));
  const zooms: number[] = [];
  for (let frame = 0; frame < 120; frame++) {
    // Смена секции на дроп — единственный триггер наезда.
    const state = scene.update(moodAt(frame * FRAME_MS, {
      energy: 0.85,
      onset: frame === 30,
      onsetStrength: frame === 30 ? 0.9 : 0,
      onsetProfile: frame === 30 ? { low: 1, mid: 0.4, high: 0.2 } : { low: 0, mid: 0, high: 0 },
      section: frame >= 30 ? 'drop' : 'steady',
    }), SCENE_CONFIG);
    if (frame >= 30) zooms.push(state.camera.zoom);
  }
  // Упругий возврат = немонотонность: наезд, перелёт и откат обратно.
  let rises = 0;
  let falls = 0;
  for (let i = 1; i < zooms.length; i++) {
    if (zooms[i] > zooms[i - 1] + 1e-5) rises++;
    if (zooms[i] < zooms[i - 1] - 1e-5) falls++;
  }
  check('наезд возвращается упруго, а не просто нарастает',
    rises > 0 && falls > 0, `рост ${rises} кадров, откат ${falls} кадров`);
}

// --- 10. Деформации: постоянный фон и рост на пиках --------------------------
{
  const sample = (overrides: Partial<MoodVector>, deformation: number) => {
    const scene = new Scene();
    scene.reseed(makeSeed('деформации'));
    const config = { ...SCENE_CONFIG, deformation };
    let last = scene.update(moodAt(0, overrides), config).deformation;
    for (let frame = 1; frame < 300; frame++) {
      last = scene.update(moodAt(frame * FRAME_MS, overrides), config).deformation;
    }
    return last;
  };

  const quiet = sample({ energy: 0.1, noisiness: 0.05, brightness: 0.1, section: 'calm' }, 1);
  check(
    'базовые деформации активны даже в тишине',
    quiet.domainWarp > 0 && quiet.twist > 0 && quiet.wave > 0 && quiet.turbulence > 0,
    `warp ${quiet.domainWarp.toFixed(3)}, twist ${quiet.twist.toFixed(3)}`,
  );

  const loud = sample({ energy: 0.95, noisiness: 0.9, brightness: 0.85, flux: 0.7, section: 'drop' }, 1);
  check('на пике деформации усиливаются',
    loud.domainWarp > quiet.domainWarp && loud.turbulence > quiet.turbulence,
    `warp ${quiet.domainWarp.toFixed(3)} → ${loud.domainWarp.toFixed(3)}`);

  const off = sample({ energy: 0.9, noisiness: 0.9 }, 0);
  check('выключенные деформации действительно нулевые',
    off.domainWarp === 0 && off.twist === 0 && off.fold === 0, `warp ${off.domainWarp}`);

  // Стекание и складки условны по спеке: одно — про медленный минор, другое — про кристалл.
  const melting = sample(
    { energy: 0.12, bpm: 72, noisiness: 0.35, brightness: 0.3, key: { tonic: 'A', mode: 'minor', confidence: 1 } },
    1,
  );
  // Порог не «больше нуля»: стекание должно быть видно, а не существовать формально.
  check('стекание заметно на медленном миноре', melting.melt > 0.1, `melt ${melting.melt.toFixed(3)}`);
  const major = sample(
    { energy: 0.6, bpm: 150, key: { tonic: 'C', mode: 'major', confidence: 1 } },
    1,
  );
  check('на быстром мажоре стекания нет', major.melt < 0.01, `melt ${major.melt.toFixed(3)}`);

  const crystal = sample({ energy: 0.8, noisiness: 0.95, brightness: 0.95, section: 'drop' }, 1);
  check('складки появляются на кристаллической части оси', crystal.fold > 0, `fold ${crystal.fold.toFixed(3)}`);
}

// --- 11. Варп пропускается, когда искажать нечего ----------------------------
{
  const scene = new Scene();
  scene.reseed(makeSeed('покой'));
  // «Нечего искажать» — это и про деформации, и про память.
  const config = { ...SCENE_CONFIG, deformation: 0, feedback: 0, smear: 0 };
  let state = scene.update(moodAt(0, {}), config);
  for (let frame = 1; frame < 120; frame++) state = scene.update(moodAt(frame * FRAME_MS, {}), config);
  const noLight = {
    bloom: 0, bloomThreshold: 0.5, rays: 0, rim: 0, whitePoint: 1.6,
    lightColour: [1, 1, 1] as [number, number, number],
    rimColour: [1, 1, 1] as [number, number, number],
  };
  check('без деформаций, ударов и света пост-конвейер пропускается',
    PostPass.isIdle(state.deformation, state.impact, state.memory, noLight),
    'конвейер всё ещё считает себя нужным');
}

// --- 12. Камера: поле зрения, склейки, долли -------------------------------
{
  const settle = (overrides: Partial<MoodVector>, frames = 300) => {
    const scene = new Scene();
    scene.reseed(makeSeed('камера'));
    let state = scene.update(moodAt(0, overrides), SCENE_CONFIG);
    for (let frame = 1; frame < frames; frame++) {
      state = scene.update(moodAt(frame * FRAME_MS, overrides), SCENE_CONFIG);
    }
    return state.camera;
  };

  const buildup = settle({ energy: 0.7, section: 'buildup' });
  const drop = settle({ energy: 0.9, section: 'drop' });
  check('на билд-апе поле зрения сужается', buildup.fov < 0.9, `fov ${buildup.fov.toFixed(3)}`);
  check('на дропе поле зрения раскрывается', drop.fov > 1.15, `fov ${drop.fov.toFixed(3)}`);

  // Плотное вещество тянет камеру вперёд, разреженное — назад.
  const dense = settle({ energy: 0.85, noisiness: 0.9, brightness: 0.9, section: 'drop' });
  const sparse = settle({ energy: 0.1, noisiness: 0.02, brightness: 0.05, section: 'calm' });
  check('долли идёт вперёд на плотном веществе и назад на разреженном',
    dense.dolly > 0 && sparse.dolly < 0,
    `плотное ${dense.dolly.toFixed(2)}, разреженное ${sparse.dolly.toFixed(2)}`);

  // Точка интереса блуждает, но не улетает за кадр.
  const scene = new Scene();
  scene.reseed(makeSeed('фокус'));
  let minX = 1;
  let maxX = 0;
  for (let frame = 0; frame < 3600; frame++) {
    const camera = scene.update(moodAt(frame * FRAME_MS, { energy: 0.5 }), SCENE_CONFIG).camera;
    minX = Math.min(minX, camera.focusX);
    maxX = Math.max(maxX, camera.focusX);
  }
  check('точка интереса блуждает', maxX - minX > 0.05, `размах ${(maxX - minX).toFixed(3)}`);
  check('точка интереса не уходит за кадр', minX > 0.2 && maxX < 0.8,
    `диапазон ${minX.toFixed(2)}..${maxX.toFixed(2)}`);
}

// --- 13. Склейки: только на границах частей и не чаще лимита ----------------
{
  const countCuts = (enabled: boolean): { cuts: number; minGapMs: number } => {
    const scene = new Scene();
    scene.reseed(makeSeed('склейки'));
    const config = { ...SCENE_CONFIG, cut: enabled };
    let previousId = 0;
    let lastAtMs = -Infinity;
    let cuts = 0;
    let minGapMs = Infinity;

    // Секция дёргается каждые 2 секунды — куда чаще, чем лимит склеек.
    for (let frame = 0; frame < 60 * 120; frame++) {
      const timeMs = frame * FRAME_MS;
      const phase = Math.floor(timeMs / 2000) % 3;
      const section = phase === 0 ? 'steady' : phase === 1 ? 'drop' : 'calm';
      const camera = scene.update(moodAt(timeMs, { energy: 0.7, section }), config).camera;
      if (camera.cutId !== previousId) {
        previousId = camera.cutId;
        cuts++;
        minGapMs = Math.min(minGapMs, timeMs - lastAtMs);
        lastAtMs = timeMs;
      }
    }
    return { cuts, minGapMs };
  };

  const on = countCuts(true);
  const off = countCuts(false);
  check('склейки выключаются настройкой', off.cuts === 0, `склеек ${off.cuts}`);
  check('склейки происходят', on.cuts > 0, `склеек ${on.cuts} за 2 минуты`);
  check('склейки не чаще раза в 16 секунд', on.minGapMs >= 16000,
    `самый короткий промежуток ${(on.minGapMs / 1000).toFixed(1)} с`);
}

// --- 14. Свет: позиция от полосы, виньетка от секции -------------------------
{
  const settleLight = (overrides: Partial<MoodVector>, frames = 300) => {
    const scene = new Scene();
    scene.reseed(makeSeed('свет'));
    let state = scene.update(moodAt(0, overrides), SCENE_CONFIG);
    for (let frame = 1; frame < frames; frame++) {
      state = scene.update(moodAt(frame * FRAME_MS, overrides), SCENE_CONFIG);
    }
    return state.light;
  };

  const bassy = settleLight({ bands: { low: 1, mid: 0.3, high: 0.05 }, energy: 0.6 });
  const trebly = settleLight({ bands: { low: 0.05, mid: 0.3, high: 1 }, energy: 0.6 });
  // y растёт вниз: бас должен светить снизу, верх — сверху.
  check('бас опускает источник света вниз', bassy.y > 0.6, `y ${bassy.y.toFixed(3)}`);
  check('верх поднимает источник света вверх', trebly.y < 0.4, `y ${trebly.y.toFixed(3)}`);

  const buildup = settleLight({ energy: 0.7, section: 'buildup' });
  const drop = settleLight({ energy: 0.9, section: 'drop' });
  check('виньетка поджимается на билд-апе', buildup.vignette > 0.7, `${buildup.vignette.toFixed(2)}`);
  check('виньетка раскрывается на дропе', drop.vignette < 0.2, `${drop.vignette.toFixed(2)}`);

  // Экспозиция дышит, но остаётся дыханием: это не стробоскоп.
  const scene = new Scene();
  scene.reseed(makeSeed('экспозиция'));
  let minExposure = Infinity;
  let maxExposure = 0;
  const bpm = 128;
  for (let frame = 0; frame < 600; frame++) {
    const timeMs = frame * FRAME_MS;
    // Фазу доли считаем сами: idleMood держит её нулевой, а дыхание идёт именно от неё.
    const beatPhase = ((timeMs / 1000) * (bpm / 60)) % 1;
    const light = scene.update(
      moodAt(timeMs, { energy: 0.9, bpm, beatPhase }), SCENE_CONFIG,
    ).light;
    minExposure = Math.min(minExposure, light.exposure);
    maxExposure = Math.max(maxExposure, light.exposure);
  }
  check('экспозиция дышит', maxExposure - minExposure > 0.02,
    `размах ${(maxExposure - minExposure).toFixed(3)}`);
  check('дыхание экспозиции не превращается в строб', maxExposure - minExposure < 0.35,
    `размах ${(maxExposure - minExposure).toFixed(3)}`);
}

// --- 15. Частицы: набор по настроению ---------------------------------------
{
  const activeFor = (overrides: Partial<MoodVector>): string[] => {
    const seed = makeSeed('частицы');
    const field = new FlowField();
    field.reseed(seed);
    const particles = new ParticleSystem(field);
    particles.resize(1280, 720);
    particles.reseed(seed, field);

    const scene = new Scene();
    scene.reseed(seed);
    const config = {
      enabled: true, mode: 'auto' as const, manual: [], density: 0.6,
      life: 1, speed: 1, size: 1,
    };

    let debug = { active: [] as string[], count: 0 };
    for (let frame = 0; frame < 600; frame++) {
      const mood = moodAt(frame * FRAME_MS, overrides);
      debug = particles.update(mood, scene.update(mood, SCENE_CONFIG), config, FRAME_MS);
    }
    return debug.active;
  };

  const noisy = activeFor({ noisiness: 0.95, energy: 0.8, section: 'drop', flux: 0.6 });
  check('на шумном материале включаются осколки или искры',
    noisy.includes('shards') || noisy.includes('sparks'), `активны: ${noisy.join(', ')}`);

  const quiet = activeFor({ noisiness: 0.03, energy: 0.1, brightness: 0.1, section: 'calm' });
  check('в тишине включается взвесь', quiet.includes('dust'), `активны: ${quiet.join(', ')}`);

  const trebly = activeFor({
    bands: { low: 0.05, mid: 0.2, high: 1 }, energy: 0.6, brightness: 0.9, section: 'steady',
  });
  check('на плотном верхе включается дождь', trebly.includes('streaks'), `активны: ${trebly.join(', ')}`);

  // Плотность действительно управляет количеством.
  const countFor = (density: number): number => {
    const seed = makeSeed('плотность');
    const field = new FlowField();
    field.reseed(seed);
    const particles = new ParticleSystem(field);
    particles.resize(1280, 720);
    particles.reseed(seed, field);
    const scene = new Scene();
    scene.reseed(seed);
    const config = {
      enabled: true, mode: 'manual' as const, manual: ['dust' as const], density,
      life: 1, speed: 1, size: 1,
    };
    let count = 0;
    for (let frame = 0; frame < 300; frame++) {
      const mood = moodAt(frame * FRAME_MS, { energy: 0.5, section: 'calm' });
      count = particles.update(mood, scene.update(mood, SCENE_CONFIG), config, FRAME_MS).count;
    }
    return count;
  };
  const sparse = countFor(0.2);
  const dense = countFor(1);
  check('плотность управляет количеством частиц', dense > sparse * 1.5,
    `${sparse} против ${dense}`);
}

// --- 16. Бюджет интенсивности ------------------------------------------------
{
  /** Прогон «всё на полную»: каждая группа просит максимум. */
  const runWith = (budget: number) => {
    const scene = new Scene();
    scene.reseed(makeSeed('бюджет'));
    const config = { ...SCENE_CONFIG, budget };
    let state = scene.update(moodAt(0, {}), config);
    for (let frame = 1; frame < 600; frame++) {
      const timeMs = frame * FRAME_MS;
      const hit = frame % 10 === 0;
      state = scene.update(moodAt(timeMs, {
        energy: 0.95, noisiness: 0.95, brightness: 0.9, flux: 0.8, section: 'drop',
        beatPhase: ((timeMs / 1000) * 2) % 1,
        onset: hit,
        onsetStrength: hit ? 0.95 : 0,
        onsetProfile: hit ? { low: 1, mid: 0.6, high: 0.3 } : { low: 0, mid: 0, high: 0 },
      }), config);
    }
    return state;
  };

  const unlimited = runWith(0);
  check('без лимита нагрузка превышает бюджет', unlimited.budget.load > 2.4,
    `нагрузка ${unlimited.budget.load.toFixed(2)}`);
  check('без лимита ничего не ужимается', unlimited.budget.scale.impact === 1, 'ужатие есть');

  const limited = runWith(2);
  const scales = limited.budget.scale;
  check('бюджет ужимает эффекты',
    scales.deformation < 1 || scales.impact < 1 || scales.memory < 1 || scales.motion < 1,
    `деф ${scales.deformation.toFixed(2)} удар ${scales.impact.toFixed(2)}`
    + ` пам ${scales.memory.toFixed(2)} движ ${scales.motion.toFixed(2)}`);

  // Суммарная нагрузка после ужатия действительно укладывается в лимит.
  const after = (limited.deformation.domainWarp + limited.deformation.twist
    + limited.deformation.wave + limited.deformation.turbulence
    + limited.deformation.melt + limited.deformation.fold) / 2.2
    + Math.abs(limited.impact.lensPulse) + limited.impact.chromaticBurst + limited.impact.slice
    + (limited.impact.shockwaves.length + limited.impact.ripples.length) * 0.25
    + limited.memory.feedbackAmount + limited.memory.smear
    + (Math.abs(limited.camera.x) + Math.abs(limited.camera.y)) * 6
    + Math.abs(limited.camera.roll) * 5 + Math.abs(limited.camera.zoom - 1) * 2.5;
  check('после ужатия нагрузка укладывается в лимит', after <= 2.05,
    `осталось ${after.toFixed(2)} при лимите 2`);

  // Удары уместнее прочего в момент удара, поэтому ужимаются меньше.
  check('в момент ударов импакт ужимается слабее деформаций',
    scales.impact >= scales.deformation,
    `удар ${scales.impact.toFixed(2)} против деф ${scales.deformation.toFixed(2)}`);
}

// --- 17. Мастер амплитуды движения -------------------------------------------
{
  const motionLoad = (motion: number): number => {
    const scene = new Scene();
    scene.reseed(makeSeed('амплитуда'));
    const config = { ...SCENE_CONFIG, motion, budget: 0 };
    let total = 0;
    for (let frame = 0; frame < 600; frame++) {
      const hit = frame % 10 === 0;
      const camera = scene.update(moodAt(frame * FRAME_MS, {
        energy: 0.9, section: 'drop',
        onset: hit,
        onsetStrength: hit ? 0.9 : 0,
        onsetProfile: hit ? { low: 1, mid: 0.5, high: 0.2 } : { low: 0, mid: 0, high: 0 },
      }), config).camera;
      total += Math.abs(camera.x) + Math.abs(camera.y) + Math.abs(camera.roll);
    }
    return total;
  };

  const full = motionLoad(1);
  const calm = motionLoad(0.35);
  check('мастер амплитуды гасит движение камеры', calm < full * 0.75,
    `полная ${full.toFixed(1)}, спокойная ${calm.toFixed(1)}`);
}

// --- 18. Соло-режим панели ---------------------------------------------------
{
  // Соло-режим нужен ровно для подбора параметров: на экране должен остаться
  // один примитив, иначе настраивать его вслепую.
  const settings = defaultSettings();
  settings.generator.solo = 'spectrum';

  const generator = new Generator('соло');
  const scene = new Scene();
  scene.reseed(makeSeed('соло'));
  let state = generator.update(moodAt(0), settings, scene.update(moodAt(0), SCENE_CONFIG));
  for (let frame = 1; frame < 400; frame++) {
    const mood = moodAt(frame * FRAME_MS, { energy: 0.6, section: 'steady' });
    state = generator.update(mood, settings, scene.update(mood, SCENE_CONFIG));
  }

  const others = [...state.weights.entries()]
    .filter(([id]) => id !== 'spectrum' && id !== 'kaleidoscope')
    .reduce((sum, [, weight]) => sum + weight, 0);
  check('соло-режим оставляет на экране один примитив',
    (state.weights.get('spectrum') ?? 0) > 0.9 && others < 0.02,
    `спектр ${(state.weights.get('spectrum') ?? 0).toFixed(2)}, остальные ${others.toFixed(3)}`);
}

// --- 19. Роль, назначенная вручную, сильнее автоматики ------------------------
{
  const settings = defaultSettings();
  settings.primitives['oscilloscope'].role = 'solo';

  const generator = new Generator('роль');
  const scene = new Scene();
  scene.reseed(makeSeed('роль'));
  let state = generator.update(moodAt(0), settings, scene.update(moodAt(0), SCENE_CONFIG));
  for (let frame = 1; frame < 600; frame++) {
    // Секции меняются: автоматика получает все поводы сменить соло.
    const section = frame % 200 < 100 ? 'calm' : 'drop';
    const mood = moodAt(frame * FRAME_MS, { energy: section === 'drop' ? 0.9 : 0.2, section });
    state = generator.update(mood, settings, scene.update(mood, SCENE_CONFIG));
  }
  check('ручная роль «соло» держится вопреки сменам секций',
    state.focus.solo === 'oscilloscope', `соло ${state.focus.solo}`);
}

// --- 20. Выключенный примитив не попадает на экран ----------------------------
{
  const settings = defaultSettings();
  const generator = new Generator('выключение');
  const scene = new Scene();
  scene.reseed(makeSeed('выключение'));

  // Выключаем всё, кроме одного: пул должен сузиться именно до него.
  for (const id of ALL_PRIMITIVE_IDS) settings.primitives[id].enabled = id === 'wave-mesh';

  let state = generator.update(moodAt(0), settings, scene.update(moodAt(0), SCENE_CONFIG));
  for (let frame = 1; frame < 400; frame++) {
    const mood = moodAt(frame * FRAME_MS, { energy: 0.5, section: 'steady' });
    state = generator.update(mood, settings, scene.update(mood, SCENE_CONFIG));
  }
  const banned = [...state.weights.entries()]
    .filter(([id]) => settings.primitives[id].enabled === false && id !== 'kaleidoscope')
    .reduce((sum, [, weight]) => sum + weight, 0);
  check('выключенные примитивы остаются в нуле', banned < 0.02, `суммарный вес ${banned.toFixed(3)}`);
}

// --- 21. Параметры примитивов: дефолты, границы и расширенный режим -----------
{
  // Каждый параметр, который читает примитив, обязан быть в состоянии
  // генератора: обращение к отсутствующему ключу дало бы NaN в геометрии.
  const settings = defaultSettings();
  const generator = new Generator('параметры');
  const scene = new Scene();
  scene.reseed(makeSeed('параметры'));
  const state = generator.update(moodAt(0), settings, scene.update(moodAt(0), SCENE_CONFIG));

  let missing = 0;
  for (const id of ALL_PRIMITIVE_IDS) {
    const tuning = state.tunings.get(id);
    for (const spec of PRIMITIVE_PARAMS[id]) {
      if (typeof tuning?.[spec.key] !== 'number') missing++;
    }
  }
  check('у каждого примитива заполнены все его параметры', missing === 0, `пропусков ${missing}`);

  // Обычный режим обязан обрезать значение из расширенного: иначе выключение
  // расширенного режима оставило бы ломающее значение жить дальше.
  const spec = PRIMITIVE_PARAMS['wave-mesh'][0];
  const wide = resolvePrimitiveParams('wave-mesh', { [spec.key]: 400 }, true);
  const narrow = resolvePrimitiveParams('wave-mesh', { [spec.key]: 400 }, false);
  check('расширенный режим снимает границу, обычный — возвращает',
    wide[spec.key] > spec.max && narrow[spec.key] === spec.max,
    `расширенный ${wide[spec.key]}, обычный ${narrow[spec.key]}`);
}

// --- 22. Пресеты: снимок, экспорт и импорт -----------------------------------
{
  // Экспорт нужен ровно для переноса: то, что ушло в файл, должно вернуться
  // тем же. Проверяем на снимке, а не на хранилище — localStorage тут нет.
  const settings = defaultSettings();
  settings.light.bloom = 0.13;
  settings.primitives.spectrum.params.bars = 96;

  const json = exportPresets([{ name: 'Проверка', settings, savedAt: 1 }]);
  const parsed = JSON.parse(json) as { app: string; presets: Array<{ settings: unknown }> };
  const restored = mergeSettings(parsed.presets[0].settings);
  check('пресет переживает экспорт и обратное слияние',
    parsed.app === 'soundvision'
      && restored.light.bloom === 0.13
      && restored.primitives.spectrum.params.bars === 96,
    `bloom ${restored.light.bloom}, столбцов ${restored.primitives.spectrum.params.bars}`);

  // Лимит вспышек не должен подниматься ничем: ни пресетом, ни импортом.
  const unsafe = mergeSettings({ ...settings, transients: { ...settings.transients, maxFlashHz: 30 } });
  check('импорт не поднимает лимит вспышек выше безопасного',
    unsafe.transients.maxFlashHz <= MAX_SAFE_FLASH_HZ,
    `${unsafe.transients.maxFlashHz} Гц`);
}

// --- 23. Встроенные пресеты собираются и остаются валидными -------------------
{
  let broken = 0;
  const names: string[] = [];
  for (const preset of PRESET_PROFILES) {
    const settings = defaultSettings();
    preset.apply(settings);
    names.push(preset.name);
    // Слияние поверх дефолтов — то же, что делает загрузка: пресет обязан
    // пережить её без потерь и без выхода за диапазоны.
    const merged = mergeSettings(settings);
    if (merged.transients.maxFlashHz > MAX_SAFE_FLASH_HZ) broken++;
    for (const id of ALL_PRIMITIVE_IDS) {
      for (const spec of PRIMITIVE_PARAMS[id]) {
        const value = merged.primitives[id].params[spec.key];
        if (!Number.isFinite(value) || value < spec.min || value > spec.max) broken++;
      }
    }
  }
  check('все встроенные пресеты валидны после загрузки', broken === 0,
    `${names.length} шт.: ${names.join(', ')}`);
}

console.log(failures === 0 ? '\nвсё сошлось' : `\nпроблем: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
