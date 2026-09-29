import { mulberry32, type GeneratorSeed, type Rng } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/**
 * Зеркальный спектр на сцене с отражением.
 *
 * Низ частот в центре, верх — к краям, обе половины зеркальны. Столбцы
 * растут от линии пола вверх, под полом — их отражение, гаснущее книзу:
 * так спектр стоит на сцене, а не висит полосой посреди кадра.
 *
 * Высота — в децибелах и складывается из двух частей. Главная — насколько
 * столбец сейчас громче своего же долгого среднего: так столбцы танцуют на
 * любом материале, а не стоят стеной там, где спектр ровный, и не упираются
 * в потолок басом. Вторая, меньшая — форма спектра относительно скользящего
 * максимума: без неё пропадает, где у трека вес. Всё вместе умножается на
 * общую энергию, поэтому дроп выше куплета.
 *
 * Глитч от скачка flux: блочные сдвиги, выпадение блоков, дубли со
 * смещением цвета и «заедание» кадра на несколько кадров.
 */

const MAX_BARS = 256;
/** Сколько кадров держится замерший кадр спектра при «заедании». */
const FREEZE_FRAMES = 4;
/** Диапазон частот: ниже 35 Гц у динамиков ничего нет, выше 16 кГц — шум. */
const LOW_HZ = 35;
const HIGH_HZ = 16000;
/** Сколько децибел под скользящим максимумом ещё видно. */
const RANGE_DB = 54;
/** Насколько столбец должен превысить своё среднее, чтобы дойти до потолка. */
const SWING_DB = 18;
/** Где стоит столбец, пока он равен своему среднему (0..1). */
const REST_LEVEL = 0.3;
/** Доля абсолютной формы спектра в высоте. */
const SHAPE_SHARE = 0.25;
/** Линия пола — доля высоты кадра. */
const FLOOR = 0.64;

export class SpectrumPrimitive implements DrawPrimitive {
  readonly id = 'spectrum' as const;
  readonly kind = 'draw' as const;

  private readonly values = new Float32Array(MAX_BARS);
  private readonly peaks = new Float32Array(MAX_BARS);
  /** Замороженная копия для эффекта «заедания». */
  private readonly frozen = new Float32Array(MAX_BARS);
  private freezeLeft = 0;
  private rng: Rng = mulberry32(1);
  private width = 1;
  private height = 1;
  private prevFlux = 0;
  private rainbow = true;
  /** Скользящий максимум уровня, дБ. */
  private topDb = -30;
  /** Долгое среднее каждого столбца, дБ; NaN — ещё не набрано. */
  private readonly averageDb = new Float32Array(MAX_BARS).fill(Number.NaN);

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    this.rng = mulberry32(seed.seed ^ 0x5a827999);
    // Радужная раскраска читается как легенда частот, но подходит не всякому
    // треку — seed решает, брать её или палитру.
    this.rainbow = this.rng() < 0.5;
    this.peaks.fill(0);
    this.values.fill(0);
    this.averageDb.fill(Number.NaN);
    this.freezeLeft = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    // Число столбцов на весь экран; на половину — вдвое меньше. Верхняя
    // граница — размер буферов.
    const total = Math.round(tuning.bars * (0.7 + params.density * 0.3));
    const bars = Math.min(MAX_BARS, Math.max(8, Math.round(total / 2)));
    const dt = frame.dtMs / 1000;

    this.sample(mood.spectrum, mood.binHz, bars, dt, mood.energy);
    this.updatePeaks(bars, dt * (1.4 - tuning.peaks));

    // Глитч копится от скачка flux: ровный сигнал его не вызывает.
    const fluxJump = mood.flux - this.prevFlux;
    this.prevFlux = mood.flux;
    const glitch = Math.max(0, Math.min(1, (fluxJump * 3 + mood.flux * params.chaos) * tuning.glitch * 1.6));
    if (glitch > 0.55 && this.freezeLeft <= 0 && this.rng() < 0.25) {
      this.frozen.set(this.values);
      this.freezeLeft = FREEZE_FRAMES;
    }
    const source = this.freezeLeft > 0 ? this.frozen : this.values;
    if (this.freezeLeft > 0) this.freezeLeft--;

    const floorY = this.height * FLOOR;
    const maxHeight = this.height * (0.24 + params.scale * 0.16) * tuning.barHeight;
    const half = this.width / 2;
    const barWidth = half / bars;
    const gap = barWidth * Math.min(0.8, 0.12 + params.sharpness * 0.15 + tuning.gap * 0.45);
    const rainbow = this.rainbow && tuning.rainbow > 0.5;
    const body = (0.2 + mood.energy * 0.25) * weight;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Линия пола: на ней стоят столбцы и от неё начинается отражение.
    ctx.fillStyle = palette.accentAlpha(0.9, 0.35 * weight);
    ctx.fillRect(0, floorY, this.width, Math.max(1, this.height * 0.002));

    for (let i = 0; i < bars; i++) {
      const value = source[i];
      if (value < 0.01) continue;

      const depth = i / bars;
      const height = value * maxHeight;
      const tone = rainbow ? depth : 0.15 + depth * 0.7;
      const colour = rainbow
        ? `hsl(${(200 - depth * 260 + 360) % 360} 90% ${(52 + value * 30).toFixed(0)}%)`
        : palette.accent(tone);

      let shiftX = 0;
      if (glitch > 0.25) {
        // Блочные сдвиги: соседние столбцы уезжают группой, а не поодиночке.
        const block = Math.floor(i / 8);
        const roll = hash(block * 13.7 + Math.floor(frame.timeMs / 90));
        if (roll > 1 - glitch * 0.12) continue;
        if (roll < glitch * 0.35) shiftX = (roll - 0.5) * barWidth * 10;
      }

      // Тело: тусклая заливка снизу и более яркая верхняя треть — столбец
      // светится к вершине, как в студийном анализаторе.
      ctx.fillStyle = withAlpha(colour, body);
      this.mirror(ctx, half, barWidth, gap, i, shiftX, floorY - height, height);
      ctx.fillStyle = withAlpha(colour, Math.min(1, body * 1.6));
      this.mirror(ctx, half, barWidth, gap, i, shiftX, floorY - height, height * 0.35);
      // Вершина: короткий яркий отрезок даёт верхние проценты яркости.
      const tip = Math.min(height, 2 + maxHeight * 0.025);
      ctx.fillStyle = withAlpha(colour, Math.min(1, 0.55 + value * 0.45) * weight);
      this.mirror(ctx, half, barWidth, gap, i, shiftX, floorY - height, tip);

      // Отражение: три ступени затухания, по одной заливке каждая.
      const reflection = height * 0.5;
      const step = reflection / 3;
      for (let k = 0; k < 3; k++) {
        ctx.fillStyle = withAlpha(colour, body * REFLECTION_ALPHA[k]);
        this.mirror(ctx, half, barWidth, gap, i, shiftX, floorY + 2 + k * step, step);
      }

      // Дублирование столбца со смещением и сменой цвета.
      if (glitch > 0.5 && hash(i * 3.1 + Math.floor(frame.timeMs / 70)) < glitch * 0.12) {
        ctx.fillStyle = withAlpha(rainbow ? `hsl(${(200 - depth * 260 + 540) % 360} 95% 65%)`
          : palette.accent((tone + 0.5) % 1), body * 0.7);
        this.mirror(ctx, half, barWidth, gap, i, shiftX + barWidth * 5, floorY - height * 0.8, height * 0.8);
      }
    }

    // Пиковые метки: медленно опадают над столбцами.
    if (tuning.peaks > 0.02) {
      ctx.fillStyle = palette.accentAlpha(0.98, (0.45 + mood.energy * 0.4) * weight);
      const mark = Math.max(1.5, this.height * 0.004);
      for (let i = 0; i < bars; i++) {
        const peak = this.peaks[i];
        if (peak < 0.03) continue;
        this.mirror(ctx, half, barWidth, gap, i, 0, floorY - peak * maxHeight - mark * 2.5, mark);
      }
    }
    ctx.restore();
  }

  /** Столбец рисуется дважды: в правой половине и зеркально в левой. */
  private mirror(
    ctx: CanvasRenderingContext2D,
    half: number,
    barWidth: number,
    gap: number,
    index: number,
    shiftX: number,
    y: number,
    height: number,
  ): void {
    const w = Math.max(1, barWidth - gap);
    const inset = gap / 2;
    ctx.fillRect(half + index * barWidth + inset + shiftX, y, w, height);
    ctx.fillRect(half - (index + 1) * barWidth + inset - shiftX, y, w, height);
  }

  /**
   * Спектр сворачивается в столбцы по логарифму частоты. Там, где столбец
   * уже одного бина (низ спектра), значение интерполируется между соседними
   * бинами — иначе несколько столбцов подряд показывают один и тот же бин
   * и стоят ступенькой.
   */
  private sample(spectrum: Float32Array, binHz: number, bars: number, dt: number, energy: number): void {
    const hz = binHz > 0 ? binHz : 48000 / 2048;
    const last = spectrum.length - 1;
    const ratio = HIGH_HZ / LOW_HZ;
    let frameTop = -120;
    const release = 1 - Math.exp(-dt / 0.14);
    const settle = 1 - Math.exp(-dt / 6);
    const loudness = 0.35 + 0.65 * Math.max(0, Math.min(1, energy));
    for (let i = 0; i < bars; i++) {
      const lowBin = (LOW_HZ * Math.pow(ratio, i / bars)) / hz;
      const highBin = (LOW_HZ * Math.pow(ratio, (i + 1) / bars)) / hz;
      let magnitude: number;
      if (highBin - lowBin < 1) {
        const centre = Math.min(last, (lowBin + highBin) / 2);
        const a = Math.floor(centre);
        const t = centre - a;
        magnitude = spectrum[a] * (1 - t) + spectrum[Math.min(last, a + 1)] * t;
      } else {
        magnitude = 0;
        const end = Math.min(last, Math.ceil(highBin));
        for (let bin = Math.floor(lowBin); bin <= end; bin++) {
          if (spectrum[bin] > magnitude) magnitude = spectrum[bin];
        }
      }
      const db = magnitude > 1e-6 ? 20 * Math.log10(magnitude) : -120;
      if (db > frameTop) frameTop = db;

      // Тишину в среднее не пускаем: после паузы столбцы не должны
      // выстреливать от любого шороха.
      let average = this.averageDb[i];
      if (db > -100) {
        average = Number.isNaN(average) ? db : average + (db - average) * settle;
        this.averageDb[i] = average;
      }
      const swing = Number.isNaN(average) || db <= -100
        ? 0
        : clamp01(REST_LEVEL + ((db - average) / SWING_DB) * (1 - REST_LEVEL));
      const shape = clamp01((db - (this.topDb - RANGE_DB)) / RANGE_DB);
      const level = (swing * (1 - SHAPE_SHARE) + shape * shape * SHAPE_SHARE) * loudness;
      // Атака мгновенная, спад — плавный.
      this.values[i] = level > this.values[i] ? level : this.values[i] + (level - this.values[i]) * release;
    }
    // Максимум догоняет громкое сразу, а тихое — за несколько секунд.
    if (frameTop > -100) {
      const k = frameTop > this.topDb ? 1 - Math.exp(-dt / 0.08) : 1 - Math.exp(-dt / 4);
      this.topDb += (frameTop - this.topDb) * k;
    }
  }

  private updatePeaks(bars: number, dt: number): void {
    for (let i = 0; i < bars; i++) {
      if (this.values[i] > this.peaks[i]) this.peaks[i] = this.values[i];
      else this.peaks[i] = Math.max(0, this.peaks[i] - dt * 0.35);
    }
  }
}

/** Затухание отражения по ступеням сверху вниз. */
const REFLECTION_ALPHA = [0.45, 0.22, 0.09];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Детерминированный псевдослучайный отсчёт: глитч не должен мерцать каждый кадр. */
function hash(value: number): number {
  const x = Math.sin(value * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

function withAlpha(colour: string, alpha: number): string {
  if (colour.startsWith('hsl(')) return colour.replace(')', ` / ${alpha.toFixed(3)})`);
  const match = /rgb\((\d+) (\d+) (\d+)\)/.exec(colour);
  if (!match) return colour;
  return `rgba(${match[1]},${match[2]},${match[3]},${alpha.toFixed(3)})`;
}
