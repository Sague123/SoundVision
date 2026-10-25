/**
 * Раскладка палитры: /dev/palette-check.html
 *
 * Строки — тоники по квинтовому кругу, столбцы — гармонические схемы.
 * Видно сразу: соседние по кругу тональности дают соседние цвета, схемы
 * действительно различаются, а мажор и минор отличаются температурой.
 */

import { NOTE_NAMES, type NoteName } from '../src/audio/chroma.ts';
import { idleMood, type MoodVector } from '../src/audio/mood-vector.ts';
import { HARMONY_SCHEMES, PaletteEngine, defaultTuning } from '../src/render/palette.ts';

const SWATCHES = 12;

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');

/** Палитра держит состояние ради миграции, поэтому на каждую ячейку — свой движок. */
function settledPalette(tonic: NoteName, mode: 'major' | 'minor', harmonyId: string) {
  const engine = new PaletteEngine();
  const harmony = HARMONY_SCHEMES.find((scheme) => scheme.id === harmonyId) ?? HARMONY_SCHEMES[0];
  let palette = null as ReturnType<PaletteEngine['build']> | null;

  // Гоняем секунду виртуального времени, чтобы миграция успела завершиться.
  for (let frame = 0; frame < 240; frame++) {
    const mood: MoodVector = {
      ...idleMood(frame * 16.7),
      deltaMs: 16.7,
      silent: false,
      energy: 0.6,
      brightness: 0.55,
      section: 'steady',
      key: { tonic, mode, confidence: 1 },
    };
    palette = engine.build({
      mood,
      tuning: defaultTuning(),
      harmony,
      seedHueShift: 0,
      cover: { url: '', image: null, colors: [] },
      useCover: false,
    });
  }
  return palette!;
}

function ramp(tonic: NoteName, mode: 'major' | 'minor', harmonyId: string): HTMLElement {
  const palette = settledPalette(tonic, mode, harmonyId);
  const strip = document.createElement('div');
  strip.style.cssText = 'display:flex;height:22px;border-radius:4px;overflow:hidden';
  for (let i = 0; i < SWATCHES; i++) {
    const cell = document.createElement('div');
    cell.style.cssText = `flex:1;background:${palette.accent(i / (SWATCHES - 1))}`;
    strip.append(cell);
  }
  return strip;
}

function table(mode: 'major' | 'minor'): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-bottom:22px';

  const title = document.createElement('h3');
  title.textContent = mode === 'major' ? 'Мажор (тёплый сдвиг)' : 'Минор (холодный сдвиг)';
  title.style.cssText = 'margin:0 0 8px;font-size:13px';
  wrap.append(title);

  const grid = document.createElement('div');
  grid.style.cssText =
    `display:grid;grid-template-columns:46px repeat(${HARMONY_SCHEMES.length},1fr);gap:4px;align-items:center`;

  grid.append(cell(''));
  for (const scheme of HARMONY_SCHEMES) grid.append(cell(scheme.name));

  // Порядок строк — по квинтовому кругу: соседние строки должны быть соседними цветами.
  const circleOfFifths = Array.from({ length: 12 }, (_, i) => NOTE_NAMES[(i * 7) % 12]);
  for (const tonic of circleOfFifths) {
    grid.append(cell(tonic));
    for (const scheme of HARMONY_SCHEMES) grid.append(ramp(tonic, mode, scheme.id));
  }
  wrap.append(grid);
  return wrap;
}

function cell(text: string): HTMLElement {
  const element = document.createElement('div');
  element.textContent = text;
  element.style.cssText = 'font-size:11px;color:#9aa4b8';
  return element;
}

root.append(table('major'), table('minor'));
(window as unknown as { __paletteReady: boolean }).__paletteReady = true;
