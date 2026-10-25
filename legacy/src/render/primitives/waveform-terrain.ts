import type { GeneratorSeed } from '../seed.ts';
import { SpectrumBands } from './spectrum-bands.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';
import { WaveformGain } from './waveform-gain.ts';

/**
 * Ландшафт из истории спектра в настоящей перспективе.
 *
 * Каждые несколько десятков миллисекунд спектр ложится новым хребтом у края
 * кадра и уходит вдаль к горизонту. Бас — гора в середине, верха — к краям,
 * у самых краёв хребты гаснут в равнину: так ландшафт читается как горная
 * гряда, а не как ровная гребёнка.
 *
 * Поверх спектра в хребет подмешана огибающая текущей волны: спектр за
 * десятки миллисекунд меняется мало, и без неё строки стояли бы одинаковыми
 * куполами. С ней каждый хребет — свой пульс, как на старом осциллографе.
 *
 * Ближние хребты закрывают дальние (как на обложке «Unknown Pleasures»):
 * под каждой линией стирается всё, что нарисовано за ней. Без этого
 * полсотни аддитивных линий сливались в светящуюся кашу, и никакой глубины
 * не было. Передний хребет — с белой сердцевиной: на нём вся яркость кадра.
 *
 * Строки двигаются плавно, долей шага, а не прыжком на новую строку:
 * иначе весь ландшафт дёргался бы с частотой добавления строк.
 */

const MAX_ROWS = 96;
/** Полос спектра на половину ширины; ландшафт зеркален от центра. */
const BANDS = 40;
const COLUMNS = BANDS * 2;
/** Как далеко уходит последний хребет, в единицах ближнего. */
const FAR_Z = 8;
/** Доля огибающей волны в высоте хребта. */
const PULSE_SHARE = 0.35;

export class WaveformTerrainPrimitive implements DrawPrimitive {
  readonly id = 'waveform-terrain' as const;
  readonly kind = 'draw' as const;

  private readonly bands = new SpectrumBands(BANDS);
  private readonly autoGain = new WaveformGain();
  /** Огибающая волны по колонкам на текущий кадр. */
  private readonly pulse = new Float32Array(COLUMNS);
  /** История хребтов: MAX_ROWS строк по COLUMNS высот, кольцевой буфер. */
  private readonly history = new Float32Array(MAX_ROWS * COLUMNS);
  private readonly window = new Float32Array(COLUMNS);
  private readonly xs = new Float32Array(COLUMNS);
  private readonly ys = new Float32Array(COLUMNS);
  private writeIndex = 0;
  private filled = 0;
  /** Доля пути до следующей строки, 0..1. */
  private progress = 0;
  private width = 1;
  private height = 1;

  constructor() {
    for (let c = 0; c < COLUMNS; c++) {
      const u = c / (COLUMNS - 1);
      // Края — равнина, середина — горы.
      this.window[c] = 0.08 + 0.92 * Math.pow(Math.sin(Math.PI * u), 1.4);
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(_seed: GeneratorSeed): void {
    this.history.fill(0);
    this.bands.reset();
    this.writeIndex = 0;
    this.filled = 0;
    this.progress = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    const dt = frame.dtMs / 1000;
    this.bands.update(mood.spectrum, mood.binHz, BANDS, dt, mood.energy);
    this.samplePulse(mood.waveform, this.autoGain.update(mood.waveform, dt));

    // Скорость полёта: быстрее на подъёме и с ручкой «скорость».
    const rowMs = 70 / Math.max(0.2, tuning.flow * (0.7 + params.speed * 0.6));
    this.progress += frame.dtMs / rowMs;
    // Больше двух строк за кадр не добавляем: после паузы вкладки не
    // заливаем историю одинаковыми хребтами.
    let pushes = 0;
    while (this.progress >= 1 && pushes < 2) {
      this.progress -= 1;
      this.push();
      pushes++;
    }
    if (this.progress >= 1) this.progress = 0;

    const rows = Math.min(this.filled, Math.max(8, Math.min(MAX_ROWS, Math.round(tuning.depth))));
    if (rows < 2) return;

    const horizon = this.height * (0.44 - tuning.perspective * 0.14);
    // Масштаб проекции: основание ближнего хребта — у нижней кромки.
    const scale = this.height * 0.97 - horizon;
    const cx = this.width / 2;
    // Ближний хребет шире кадра: края гряды уходят за рамку.
    const halfWorld = (this.width * 0.62) / scale;
    const amplitude = tuning.verticalGain * (0.3 + params.scale * 0.35) * (0.55 + mood.energy * 0.7);
    const dz = (FAR_Z - 1) / rows;
    const occlusion = Math.min(1, tuning.occlusion) * weight;
    const lineScale = tuning.lineWidth * (0.8 + params.sharpness * 0.5);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Дальние первыми: ближние стирают их под собой и ложатся сверху.
    for (let k = rows - 1; k >= 0; k--) {
      const z = 1 + (k + this.progress) * dz;
      const age = (k + this.progress) / rows;
      const inv = 1 / z;
      const base = horizon + scale * inv;
      const offset = ((this.writeIndex - 1 - k + MAX_ROWS * 2) % MAX_ROWS) * COLUMNS;

      for (let c = 0; c < COLUMNS; c++) {
        const u = c / (COLUMNS - 1);
        this.xs[c] = cx + (u * 2 - 1) * halfWorld * scale * inv;
        this.ys[c] = base - this.history[offset + c] * amplitude * scale * inv;
      }

      // Туман: вдаль линии гаснут; новая строка проявляется, пока встаёт на место.
      const fog = Math.pow(1 - age, 1.5);
      const enter = k === 0 ? Math.min(1, this.progress * 3) : 1;
      if (fog * enter < 0.01) continue;

      if (occlusion > 0.01) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = `rgba(0,0,0,${occlusion.toFixed(3)})`;
        this.tracePath(ctx);
        ctx.lineTo(this.xs[COLUMNS - 1], base + 2);
        ctx.lineTo(this.xs[0], base + 2);
        ctx.closePath();
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'lighter';
      const near = 1 - age;
      this.tracePath(ctx);
      ctx.lineWidth = Math.max(1, (0.8 + near * 1.6) * lineScale);
      ctx.strokeStyle = palette.accentAlpha(0.15 + age * 0.7,
        (0.22 + mood.energy * 0.45) * fog * enter * weight);
      ctx.stroke();

      // Передний хребет: ореол и белая сердцевина.
      if (k <= 1) {
        const front = (k === 0 ? enter : 1 - this.progress) * weight;
        ctx.lineWidth = Math.max(2, 7 * lineScale * (0.6 + mood.energy * 0.4));
        ctx.strokeStyle = palette.accentAlpha(0.3, 0.22 * front);
        ctx.stroke();
        ctx.lineWidth = Math.max(1, 1.5 * lineScale);
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, 0.9 * front).toFixed(3)})`;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Сглаженная кривая по точкам хребта: середины отрезков — узлы, точки — опоры. */
  private tracePath(ctx: CanvasRenderingContext2D): void {
    const xs = this.xs;
    const ys = this.ys;
    ctx.beginPath();
    ctx.moveTo(xs[0], ys[0]);
    for (let c = 1; c < COLUMNS - 1; c++) {
      ctx.quadraticCurveTo(xs[c], ys[c], (xs[c] + xs[c + 1]) / 2, (ys[c] + ys[c + 1]) / 2);
    }
    ctx.lineTo(xs[COLUMNS - 1], ys[COLUMNS - 1]);
  }

  /** Огибающая волны: пик модуля на отрезок, приведённый автоусилением к ~0.6. */
  private samplePulse(wave: Float32Array, gain: number): void {
    const stride = Math.max(1, Math.floor(wave.length / COLUMNS));
    for (let c = 0; c < COLUMNS; c++) {
      let peak = 0;
      const start = c * stride;
      for (let j = 0; j < stride; j++) {
        const v = wave[start + j] ?? 0;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      this.pulse[c] = Math.min(1, peak * gain * 1.3);
    }
  }

  /** Новый хребет: текущий спектр, зеркально от центра, со сглаживанием соседей. */
  private push(): void {
    const offset = this.writeIndex * COLUMNS;
    const values = this.bands.values;
    for (let c = 0; c < COLUMNS; c++) {
      const band = c < BANDS ? BANDS - 1 - c : c - BANDS;
      const left = values[Math.max(0, band - 1)];
      const right = values[Math.min(BANDS - 1, band + 1)];
      const smooth = values[band] * 0.5 + (left + right) * 0.25;
      const height = smooth * (1 - PULSE_SHARE) + this.pulse[c] * PULSE_SHARE;
      this.history[offset + c] = height * this.window[c];
    }
    this.writeIndex = (this.writeIndex + 1) % MAX_ROWS;
    this.filled = Math.min(MAX_ROWS, this.filled + 1);
  }
}
