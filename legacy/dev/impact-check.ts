/**
 * Раскладка искажений: /dev/impact-check.html
 *
 * Каждое искажение применяется к одной и той же тестовой сетке с фиксированной
 * силой. Так видно, что именно делает каждый параметр, и сразу заметно, если
 * шейдер перестал компилироваться или эффект выродился.
 */

import type { Deformation, ImpactState, Light, Memory } from '../src/render/scene.ts';
import { PostPass } from '../src/render/post-pass.ts';

const CELL_WIDTH = 230;
const CELL_HEIGHT = 130;

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');

/** Сетка с кругами: на ней читается и смещение, и кривизна, и разрыв каналов. */
function testPattern(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_WIDTH;
  canvas.height = CELL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D-контекст недоступен');

  ctx.fillStyle = '#0a0f1a';
  ctx.fillRect(0, 0, CELL_WIDTH, CELL_HEIGHT);

  ctx.strokeStyle = '#3f7fd0';
  ctx.lineWidth = 1;
  const step = 14;
  ctx.beginPath();
  for (let x = 0; x <= CELL_WIDTH; x += step) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, CELL_HEIGHT);
  }
  for (let y = 0; y <= CELL_HEIGHT; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(CELL_WIDTH, y + 0.5);
  }
  ctx.stroke();

  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 2;
  for (const radius of [22, 42, 62]) {
    ctx.beginPath();
    ctx.arc(CELL_WIDTH / 2, CELL_HEIGHT / 2, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#ff7ad9';
  ctx.fillRect(CELL_WIDTH / 2 - 4, CELL_HEIGHT / 2 - 4, 8, 8);
  return canvas;
}

function zeroDeformation(): Deformation {
  return { domainWarp: 0, twist: 0, wave: 0, turbulence: 0, melt: 0, fold: 0, time: 4.2 };
}

/** Память выключена: ячейки статичны, обратной связи в них быть не должно. */
function zeroMemory(): Memory {
  return {
    trail: 0, feedbackAmount: 0, feedbackZoom: 1, feedbackRotate: 0,
    feedbackX: 0, feedbackY: 0, smear: 0, ghosts: [], echoDivisions: [],
  };
}

function zeroImpact(): ImpactState {
  return { shockwaves: [], ripples: [], lensPulse: 0, chromaticBurst: 0, slice: 0, pressure: 0 };
}

const cases: Array<{ name: string; deformation: Deformation; impact: ImpactState }> = [
  { name: 'без искажений', deformation: zeroDeformation(), impact: zeroImpact() },
  { name: 'domain warp', deformation: { ...zeroDeformation(), domainWarp: 1 }, impact: zeroImpact() },
  { name: 'twist', deformation: { ...zeroDeformation(), twist: 1 }, impact: zeroImpact() },
  { name: 'wave', deformation: { ...zeroDeformation(), wave: 1 }, impact: zeroImpact() },
  { name: 'turbulence', deformation: { ...zeroDeformation(), turbulence: 1 }, impact: zeroImpact() },
  { name: 'melt', deformation: { ...zeroDeformation(), melt: 1 }, impact: zeroImpact() },
  { name: 'fold', deformation: { ...zeroDeformation(), fold: 1 }, impact: zeroImpact() },
  {
    name: 'lens pulse: бочка',
    deformation: zeroDeformation(),
    impact: { ...zeroImpact(), lensPulse: 0.6 },
  },
  {
    name: 'lens pulse: подушка',
    deformation: zeroDeformation(),
    impact: { ...zeroImpact(), lensPulse: -0.6 },
  },
  {
    name: 'shockwave',
    deformation: zeroDeformation(),
    impact: {
      ...zeroImpact(),
      shockwaves: [{ x: 0.5, y: 0.5, radius: 0.28, strength: 1, width: 0.07, rings: 1 }],
    },
  },
  {
    name: 'ripple (три кольца)',
    deformation: zeroDeformation(),
    impact: {
      ...zeroImpact(),
      ripples: [{ x: 0.5, y: 0.5, radius: 0.4, strength: 1, width: 0.14, rings: 3 }],
    },
  },
  {
    name: 'chromatic burst',
    deformation: zeroDeformation(),
    impact: { ...zeroImpact(), chromaticBurst: 1 },
  },
  { name: 'slice displacement', deformation: zeroDeformation(), impact: { ...zeroImpact(), slice: 1 } },
];

/** Свет нейтрализован: страница показывает только геометрию искажений. */
const NEUTRAL_LIGHT = {
  bloom: 0, bloomThreshold: 0.5, rays: 0, rim: 0,
  lightColour: [1, 1, 1] as [number, number, number],
  rimColour: [1, 1, 1] as [number, number, number],
  whitePoint: 1.6,
};
const NEUTRAL_LIGHT_STATE: Light = {
  angle: 0, intensity: 0.5, flash: 0, warmth: 0.5,
  x: 0.5, y: 0.5, exposure: 1, vignette: 0, flare: 0,
};

const warp = new PostPass();
warp.resize(CELL_WIDTH, CELL_HEIGHT);

const grid = document.createElement('div');
grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:12px;max-width:1040px';
root.append(grid);

const source = testPattern();
let rendered = 0;

for (const item of cases) {
  const cell = document.createElement('div');
  const label = document.createElement('div');
  label.textContent = item.name;
  label.style.cssText = 'margin-bottom:4px;color:#9aa4b8';

  const view = document.createElement('canvas');
  view.width = CELL_WIDTH;
  view.height = CELL_HEIGHT;
  view.style.cssText = 'width:100%;border-radius:6px;display:block';
  const ctx = view.getContext('2d');

  const output = warp.render(source, item.deformation, item.impact, zeroMemory(), NEUTRAL_LIGHT_STATE, NEUTRAL_LIGHT);
  if (ctx) {
    // Варп недоступен — показываем исходник, чтобы отличить «нет эффекта»
    // от «шейдер не собрался».
    ctx.drawImage(output ?? source, 0, 0, CELL_WIDTH, CELL_HEIGHT);
    if (output) rendered++;
  }

  cell.append(label, view);
  grid.append(cell);
}

const status = document.createElement('p');
status.textContent = warp.available
  ? `проход искажения собрался, отрисовано ячеек: ${rendered} из ${cases.length}`
  : 'ПРОХОД ИСКАЖЕНИЯ НЕДОСТУПЕН — показан исходник';
status.style.cssText = `margin-top:14px;color:${warp.available ? '#9dff8f' : '#ff7a7a'}`;
root.append(status);

(window as unknown as { __impactReady: boolean; __impactRendered: number })
  .__impactReady = true;
(window as unknown as { __impactReady: boolean; __impactRendered: number })
  .__impactRendered = rendered;
