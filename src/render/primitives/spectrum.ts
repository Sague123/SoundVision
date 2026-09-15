import { mulberry32, type GeneratorSeed, type Rng } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/**
 * Зеркальный спектр с глитчем.
 *
 * Столбцов много и они тонкие — это анализатор, а не три толстые полосы.
 * Зеркала по обеим осям дают симметрию, пиковые метки медленно опадают и
 * добавляют «дыхание». Глитч-модификатор идёт от flux: блочные сдвиги,
 * выпадение блоков, дублирование полос со смещением цвета и «заедание»
 * кадра на несколько кадров.
 */

const MAX_BARS = 256;
/** Сколько кадров держится замерший кадр спектра при «заедании». */
const FREEZE_FRAMES = 4;

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
    this.freezeLeft = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    // Верхняя граница — размер буферов: в расширенном режиме ползунок пускает
    // и больше, но буфер значений и пиков от этого не вырастет.
    const bars = Math.min(MAX_BARS, Math.max(8, Math.round(tuning.bars * (0.6 + params.density * 0.4))));

    this.sample(mood.spectrum, bars);
    this.updatePeaks(bars, (frame.dtMs / 1000) * (1.4 - tuning.peaks));

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

    const centreY = this.height * 0.5;
    const halfHeight = this.height * (0.2 + params.scale * 0.26) * tuning.barHeight;
    // Второе зеркало по горизонтали: правая половина повторяет левую.
    const half = this.width / 2;
    const barWidth = half / bars;
    const gap = barWidth * (0.25 + params.sharpness * 0.35 + tuning.gap * 0.4);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < bars; i++) {
      const value = source[i];
      if (value < 0.005) continue;

      // Перспектива: дальние столбцы ниже и тусклее.
      const depth = i / bars;
      const height = value * halfHeight * (1 - depth * 0.25);
      const rainbow = this.rainbow && tuning.rainbow > 0.5;
      const tone = rainbow ? depth : 0.15 + depth * 0.7;
      const colour = rainbow
        ? `hsl(${(depth * 300).toFixed(0)} 90% ${(55 + value * 35).toFixed(0)}%)`
        : palette.accent(tone);

      let shiftX = 0;
      let dropped = false;
      if (glitch > 0.25) {
        // Блочные сдвиги: соседние столбцы уезжают группой, а не поодиночке.
        const block = Math.floor(i / 8);
        const roll = hash(block * 13.7 + Math.floor(frame.timeMs / 90));
        if (roll < glitch * 0.35) shiftX = (roll - 0.5) * barWidth * 14;
        if (roll > 1 - glitch * 0.12) dropped = true;
      }
      if (dropped) continue;

      /*
       * Тело столбца намеренно тусклое: яркость кадра должна набираться
       * вершинами и пиковыми метками, а не площадью столбцов. Двести ярких
       * заливок дают ровно ту мутную середину гистограммы, от которой уходим.
       */
      const alpha = (0.1 + mood.energy * 0.22) * weight;
      ctx.fillStyle = withAlpha(colour, alpha);
      this.mirrorBars(ctx, half, barWidth, gap, i, shiftX, centreY, height);

      // Вершина столбца: короткий яркий отрезок. Он и даёт верхние 2%
      // яркости, при том что площадь его мала.
      const tip = Math.min(height, halfHeight * 0.06 + 2);
      ctx.fillStyle = withAlpha(colour, Math.min(1, alpha * 3.2));
      this.mirrorBars(ctx, half, barWidth, gap, i, shiftX, centreY - height, tip, true);
      this.mirrorBars(ctx, half, barWidth, gap, i, shiftX, centreY + height - tip, tip, true);
      ctx.fillStyle = withAlpha(colour, alpha);

      // Дублирование полосы со смещением и сменой цвета.
      if (glitch > 0.5 && hash(i * 3.1 + Math.floor(frame.timeMs / 70)) < glitch * 0.12) {
        ctx.fillStyle = withAlpha(rainbow ? `hsl(${(depth * 300 + 180) % 360} 95% 65%)`
          : palette.accent((tone + 0.5) % 1), alpha * 0.7);
        this.mirrorBars(ctx, half, barWidth, gap, i, shiftX + barWidth * 5, centreY, height * 0.8);
      }
    }

    // Пиковые метки поверх столбцов.
    ctx.fillStyle = palette.accentAlpha(0.98, (0.3 + mood.energy * 0.4) * weight);
    for (let i = 0; i < bars && tuning.peaks > 0.02; i++) {
      const peak = this.peaks[i];
      if (peak < 0.02) continue;
      const height = peak * halfHeight;
      this.mirrorBars(ctx, half, barWidth, gap, i, 0, centreY - height, 1.5, true);
      this.mirrorBars(ctx, half, barWidth, gap, i, 0, centreY + height, 1.5, true);
    }
    ctx.restore();
  }

  /** Один столбец рисуется четыре раза: два зеркала по вертикали и по горизонтали. */
  private mirrorBars(
    ctx: CanvasRenderingContext2D,
    half: number,
    barWidth: number,
    gap: number,
    index: number,
    shiftX: number,
    y: number,
    height: number,
    flat = false,
  ): void {
    const w = Math.max(1, barWidth - gap);
    const rightX = half + index * barWidth + shiftX;
    const leftX = half - (index + 1) * barWidth - shiftX;
    if (flat) {
      ctx.fillRect(rightX, y, w, height);
      ctx.fillRect(leftX, y, w, height);
      return;
    }
    ctx.fillRect(rightX, y - height, w, height);
    ctx.fillRect(rightX, y, w, height);
    ctx.fillRect(leftX, y - height, w, height);
    ctx.fillRect(leftX, y, w, height);
  }

  /** Спектр сворачивается в столбцы по логарифму частоты. */
  private sample(spectrum: Float32Array, bars: number): void {
    for (let i = 0; i < bars; i++) {
      const low = Math.floor((Math.exp((i / bars) * 5.2) / 182) * spectrum.length);
      const high = Math.max(low + 1,
        Math.floor((Math.exp(((i + 1) / bars) * 5.2) / 182) * spectrum.length));
      let peak = 0;
      for (let bin = low; bin < Math.min(high, spectrum.length); bin++) {
        if (spectrum[bin] > peak) peak = spectrum[bin];
      }
      // Сглаживание только вниз: атака должна быть мгновенной.
      const scaled = Math.min(1, peak * 9);
      this.values[i] = scaled > this.values[i] ? scaled : this.values[i] * 0.82 + scaled * 0.18;
    }
  }

  private updatePeaks(bars: number, dt: number): void {
    for (let i = 0; i < bars; i++) {
      if (this.values[i] > this.peaks[i]) this.peaks[i] = this.values[i];
      else this.peaks[i] = Math.max(0, this.peaks[i] - dt * 0.35);
    }
  }
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
