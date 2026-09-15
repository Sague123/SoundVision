import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/**
 * Осциллограф с послесвечением.
 *
 * Два режима: обычная развёртка по времени и XY (фигуры Лиссажу) из левого и
 * правого каналов. XY даёт живые петли и читается безошибочно «аудиошно».
 *
 * При моно-источнике каналы совпадают, и XY выродился бы в диагональ —
 * поэтому там вместо второго канала берётся тот же сигнал с временной
 * задержкой: петли получаются из фазового сдвига, как на настоящем приборе.
 */

const TRACE_POINTS = 900;
/** Сдвиг для моно-режима в отсчётах: около четверти периода средних частот. */
const MONO_DELAY = 24;

export class OscilloscopePrimitive implements DrawPrimitive {
  readonly id = 'oscilloscope' as const;
  readonly kind = 'draw' as const;

  /** Холст послесвечения: он не очищается полностью, а гаснет. */
  private phosphor: HTMLCanvasElement | null = null;
  private phosphorCtx: CanvasRenderingContext2D | null = null;
  private width = 1;
  private height = 1;
  private xyMode = true;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const canvas = this.phosphor ?? document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    this.phosphor = canvas;
    this.phosphorCtx = canvas.getContext('2d');
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0xc761c23c);
    this.xyMode = rng() < 0.6;
    if (this.phosphorCtx) this.phosphorCtx.clearRect(0, 0, this.width, this.height);
  }

  dispose(): void {
    this.phosphor = null;
    this.phosphorCtx = null;
  }

  draw(frame: RenderFrame): void {
    const trace = this.phosphorCtx;
    const canvas = this.phosphor;
    if (!trace || !canvas) return;

    const { ctx, mood, params, palette, weight, tuning } = frame;

    // Послесвечение параметром задаётся напрямую: это главное, чем
    // осциллограф отличается от простой ломаной.
    const persistence = tuning.persistence * (0.5 + params.trail * 0.5);
    const decay = 1 - Math.exp(-(frame.dtMs / 1000) * (1.2 + (1 - persistence) * 16));
    trace.globalCompositeOperation = 'destination-out';
    trace.fillStyle = `rgba(0,0,0,${decay.toFixed(4)})`;
    trace.fillRect(0, 0, this.width, this.height);

    trace.globalCompositeOperation = 'lighter';
    trace.lineWidth = Math.max(1, (0.9 + params.sharpness * 0.8) * tuning.lineWidth);
    trace.lineJoin = 'round';
    trace.strokeStyle = palette.accentAlpha(0.85, (0.25 + mood.energy * 0.5) * weight);

    const left = mood.waveform;
    const right = mood.stereo ? mood.waveformRight : mood.waveform;
    const points = Math.min(TRACE_POINTS, left.length);
    const cx = this.width / 2;
    const cy = this.height / 2;
    const gain = Math.min(this.width, this.height) * (0.2 + params.scale * 0.24)
      * (0.6 + mood.energy * 0.9) * tuning.gain;

    // Режим берётся из настройки, seed решает только когда она на середине.
    const xyMode = tuning.lissajous > 0.5 || (tuning.lissajous > 0.25 && this.xyMode);

    trace.beginPath();
    for (let i = 0; i < points; i++) {
      let x: number;
      let y: number;
      if (xyMode) {
        const other = mood.stereo ? right[i] : (left[(i + MONO_DELAY) % points] ?? 0);
        x = cx + left[i] * gain;
        y = cy + other * gain;
      } else {
        x = (i / (points - 1)) * this.width;
        y = cy + left[i] * gain;
      }
      if (i === 0) trace.moveTo(x, y);
      else trace.lineTo(x, y);
    }
    trace.stroke();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = weight;
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
  }
}
