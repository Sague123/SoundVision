/**
 * Проверка текста песни на худшем фоне: /dev/lyrics-check.html
 *
 * Читаемость проверяется именно на плотном дропе, а не на спокойном участке —
 * там текст теряется, а не на тихом. Заодно страница показывает, в каких
 * гарнитурах реально есть кириллица: список из спецификации проверяется
 * измерением, а не берётся на веру.
 */

import '../src/style.css';
import { idleMood, type MoodVector } from '../src/audio/mood-vector.ts';
import { Compositor } from '../src/render/compositor.ts';
import { defaultSettings } from '../src/settings.ts';
import { loadFonts, FONT_CHOICES, type FontReport } from '../src/ui/fonts.ts';
import { LyricsOverlay } from '../src/ui/lyrics-overlay.ts';
import type { LyricsPosition } from '../src/lyrics/sync-engine.ts';

interface LyricsReport {
  done: boolean;
  fonts: FontReport[];
  /**
   * Задуманный контраст: цвет из палитры против фона под плашкой.
   *
   * Это проверка логики подбора цвета, а не того, что реально нарисовалось.
   * Настоящий контраст меряется по пикселям снаружи (см. README): один раз
   * эта страница уже показывала 6.9:1 там, где на экране было 1.5:1, потому
   * что заливку глифов перекрывала обводка.
   */
  contrast: number;
  textLuminance: number;
  backdropLuminance: number;
  errors: string[];
}

const report: LyricsReport = {
  done: false, fonts: [], contrast: 0, textLuminance: 0, backdropLuminance: 0, errors: [],
};
(window as unknown as { __lyrics: LyricsReport }).__lyrics = report;
window.addEventListener('error', (event) => report.errors.push(String(event.message)));

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');

const canvas = document.createElement('canvas');
canvas.className = 'stage';
root.append(canvas);

const overlay = new LyricsOverlay();
root.append(overlay.element);

const panel = document.createElement('pre');
panel.style.cssText =
  'position:absolute;top:12px;left:12px;margin:0;padding:10px 12px;border-radius:10px;'
  + 'background:rgba(4,6,10,0.8);color:#cfe3ff;font:11px/1.6 ui-monospace,monospace;z-index:5';
root.append(panel);

const compositor = new Compositor(canvas);
compositor.resize(window.innerWidth, window.innerHeight, 1);

const settings = defaultSettings();
settings.generator.mode = 'manual';
// Самый плотный из примитивов плюс всё включённое: худший случай для текста.
settings.generator.manual = ['voronoi', 'cellular'];
settings.lyrics.readability = 'auto';
// Настройки выставлены наружу: проверка снаружи переключает режим читаемости.
// Через класс это делать бесполезно — рендер возвращает его на каждом кадре.
(window as unknown as { __settings: typeof settings }).__settings = settings;

// Русская строка с потаймингом по словам — проверяются и глифы, и караоке.
const WORDS = ['Щедрый', 'вечер,', 'добрый', 'вечер,', 'людям', 'на', 'здоровье'];
const line = {
  timeMs: 0,
  text: WORDS.join(' '),
  words: WORDS.map((text, index) => ({ timeMs: index * 420, text })),
};

function synthesize(timeMs: number): MoodVector {
  const t = timeMs / 1000;
  const bpm = 140;
  return {
    ...idleMood(timeMs),
    deltaMs: 16.7,
    silent: false,
    energy: 0.9,
    brightness: 0.85,
    noisiness: 0.8,
    flux: 0.6,
    bands: { low: 0.7, mid: 0.8, high: 0.9 },
    bpm,
    beatPhase: (t * (bpm / 60)) % 1,
    beatConfidence: 0.9,
    section: 'drop',
    key: { tonic: 'D', mode: 'major', confidence: 0.8 },
  };
}

function position(timeMs: number): LyricsPosition {
  const inLine = timeMs % 3200;
  let wordIndex = -1;
  for (let i = 0; i < line.words.length; i++) if (line.words[i].timeMs <= inLine) wordIndex = i;
  return {
    line,
    lineIndex: Math.floor(timeMs / 3200),
    previous: null,
    next: null,
    lineProgress: inLine / 3200,
    wordIndex,
    sinceLineMs: inLine,
  };
}

/** Относительная яркость WCAG — она же используется в формуле контраста. */
function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function parseRgb(value: string): [number, number, number] {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
}

let frame = 0;
function tick(timestamp: number): void {
  const mood = synthesize(timestamp);
  const stats = compositor.render(mood, settings, { url: '', image: null, colors: [] });
  overlay.update(position(timestamp), settings, stats.palette, mood, stats.meanLuminance);

  frame++;
  if (frame === 150) measure(stats.meanLuminance);
  if (frame < 400) requestAnimationFrame(tick);
}

function measure(meanLuminance: number): void {
  const style = getComputedStyle(overlay.element);
  const textColour = parseRgb(style.getPropertyValue('--lyrics-color'));
  const textLuma = relativeLuminance(...textColour);

  // Фон замеряем ровно под плашкой текста — там, где он и мешает.
  const rect = overlay.element.querySelector('.lyrics__plate')!.getBoundingClientRect();
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 12;
  const ctx = probe.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, rect.left, rect.top, rect.width, rect.height, 0, 0, 32, 12);
  const data = ctx.getImageData(0, 0, 32, 12).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += relativeLuminance(data[i], data[i + 1], data[i + 2]);
  const backdrop = sum / (data.length / 4);

  const lighter = Math.max(textLuma, backdrop);
  const darker = Math.min(textLuma, backdrop);
  report.textLuminance = textLuma;
  report.backdropLuminance = backdrop;
  report.contrast = (lighter + 0.05) / (darker + 0.05);
  report.done = true;

  panel.textContent = [
    `средняя яркость кадра  ${meanLuminance.toFixed(3)}`,
    `яркость текста         ${textLuma.toFixed(3)}`,
    `яркость фона под ним   ${backdrop.toFixed(3)}`,
    `задуманный контраст    ${report.contrast.toFixed(2)}:1`,
    '(реальный меряется по пикселям снаружи)',
    '',
    ...report.fonts.map((font) => {
      const choice = FONT_CHOICES.find((item) => item.id === font.id);
      const state = font.cyrillic ? 'кириллица есть' : font.loaded ? 'БЕЗ КИРИЛЛИЦЫ' : 'не загрузился';
      return `${font.name.padEnd(16)} ${state}${choice?.variable ? ' (variable)' : ''}`;
    }),
  ].join('\n');
}

void loadFonts().then((fonts) => {
  report.fonts = fonts;
  requestAnimationFrame(tick);
});
