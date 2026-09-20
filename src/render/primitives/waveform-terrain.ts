import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/**
 * Ландшафт из истории осциллограммы.
 *
 * Каждый кадр волны остаётся в кольцевом буфере и на следующих кадрах уходит
 * вглубь: поднимается, сжимается и гаснет. Совпавшие гребни соседних кадров
 * складываются аддитивно и дают яркий хребет — именно так набирается яркость
 * в референсе, наложением линий, а не заливкой площади.
 *
 * Снизу то же самое отражается с меньшей непрозрачностью — «отражение в воде».
 */

/** Сколько кадров волны держим в истории. */
const MAX_HISTORY = 190;
/** Сколько точек берём с каждой осциллограммы. */
const SAMPLES = 220;

export class WaveformTerrainPrimitive implements DrawPrimitive {
  readonly id = 'waveform-terrain' as const;
  readonly kind = 'draw' as const;

  /** История волн: MAX_HISTORY строк по SAMPLES значений. */
  private history = new Float32Array(MAX_HISTORY * SAMPLES);
  private writeIndex = 0;
  private filled = 0;
  private width = 1;
  private height = 1;
  private rng = mulberry32(1);
  /** Смещение фазы «дождя»: вертикальных штрихов от гребней. */
  private rainPhase = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    this.rng = mulberry32(seed.seed ^ 0x1b873593);
    this.rainPhase = this.rng();
    this.history = new Float32Array(MAX_HISTORY * SAMPLES);
    this.writeIndex = 0;
    this.filled = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    this.push(mood.waveform);

    // Глубина задаётся параметром напрямую, плотность лишь поджимает её:
    // «сколько кадров видно» — это решение пользователя, а не настроения.
    const depth = Math.max(12, Math.round(tuning.depth * (0.5 + params.density * 0.5)));
    const rows = Math.min(this.filled, depth);
    if (rows < 2) return;

    // Горизонт держим ниже середины: над ним остаётся воздух, под ним отражение.
    const horizon = this.height * 0.52;
    const gain = this.height * (0.1 + params.scale * 0.22) * (0.5 + mood.energy * 1.1)
      * tuning.verticalGain;
    const step = (horizon * 0.82 * (0.4 + tuning.perspective * 1.2)) / rows;

    /**
     * Общая «краска» кадра не должна зависеть от глубины: сто аддитивных
     * линий в два пикселя друг от друга сливаются в заливку, а референс
     * держится на том, что линии видно по отдельности. Поэтому непрозрачность
     * делится на число строк, и глубина меняет детализацию, а не яркость.
     */
    const bulkInk = Math.min(1, 26 / rows);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Дальние кадры рисуем первыми: ближние должны ложиться поверх.
    for (let row = rows - 1; row >= 0; row--) {
      const age = row / rows;
      // Перспектива: чем дальше кадр, тем выше, у́же и тусклее.
      const y = horizon - age * step * rows;
      const shrink = 1 - age * 0.42 * (0.4 + tuning.perspective * 1.2);
      const fade = (1 - age) ** 1.6;
      const amplitude = gain * shrink * (1 - age * 0.35);

      const offset = ((this.writeIndex - 1 - row + MAX_HISTORY) % MAX_HISTORY) * SAMPLES;
      const tone = 0.15 + age * 0.7;

      /*
       * Делить непрозрачность поровну между всеми строками нельзя: получается
       * ровное тусклое поле без единой яркой точки, а гистограмма — один горб
       * в тенях. В референсе передний гребень почти белый, а вглубь всё
       * быстро гаснет. Поэтому ближние строки идут почти на полной яркости, и
       * только хвост уходит в общую «краску».
       */
      const ink = bulkInk + (1 - bulkInk) * fade ** 5;

      ctx.lineWidth = Math.max(1, (1.2 - age) * (0.8 + params.sharpness * 0.6) * tuning.lineWidth);
      ctx.strokeStyle = palette.accentAlpha(tone, (0.1 + mood.energy * 0.35) * fade * weight * ink);
      this.strokeRow(ctx, offset, y, amplitude, shrink, false);
      ctx.stroke();

      // Отражение: слабее и ниже горизонта, даёт «воду» из референса.
      const reflection = tuning.reflection * params.trail;
      if (reflection > 0.08) {
        ctx.strokeStyle = palette.accentAlpha(tone, (0.05 + mood.energy * 0.14) * fade * weight * reflection * ink);
        this.strokeRow(ctx, offset, horizon + (horizon - y) * 0.75, amplitude * 0.8, shrink, true);
        ctx.stroke();
      }
    }

    this.drawRain(frame, horizon, gain);
    ctx.restore();
  }

  /** Одна ломаная по ширине экрана. */
  private strokeRow(
    ctx: CanvasRenderingContext2D,
    offset: number,
    y: number,
    amplitude: number,
    shrink: number,
    mirrored: boolean,
  ): void {
    const inset = (this.width * (1 - shrink)) / 2;
    const span = this.width * shrink;
    const direction = mirrored ? -1 : 1;

    ctx.beginPath();
    for (let i = 0; i < SAMPLES; i++) {
      const x = inset + (i / (SAMPLES - 1)) * span;
      const value = this.history[offset + i];
      const py = y - value * amplitude * direction;
      if (i === 0) ctx.moveTo(x, py);
      else ctx.lineTo(x, py);
    }
  }

  /**
   * Вертикальные штрихи от пиков вверх. Мелкая деталь из референса: она
   * читается только в нативном разрешении и даёт текстуру над ландшафтом.
   */
  private drawRain(frame: RenderFrame, horizon: number, gain: number): void {
    const { ctx, params, mood, palette, weight, tuning } = frame;
    const density = Math.round(SAMPLES * (0.05 + params.density * 0.25) * tuning.rain * 2);
    if (density <= 0) return;

    const offset = ((this.writeIndex - 1 + MAX_HISTORY) % MAX_HISTORY) * SAMPLES;
    ctx.lineWidth = tuning.lineWidth;
    ctx.strokeStyle = palette.accentAlpha(0.95, (0.08 + mood.energy * 0.22) * weight);
    ctx.beginPath();
    for (let i = 0; i < density; i++) {
      // Шаг выбран простым перебором с фазой от seed: штрихи не должны
      // выстраиваться в регулярную гребёнку.
      const index = Math.floor((i * 7.3 + this.rainPhase * SAMPLES)) % SAMPLES;
      const value = Math.abs(this.history[offset + index]);
      if (value < 0.04) continue;
      const x = (index / (SAMPLES - 1)) * this.width;
      const top = horizon - value * gain * (1.2 + mood.energy);
      ctx.moveTo(x, horizon - value * gain * 0.9);
      ctx.lineTo(x, top);
    }
    ctx.stroke();
  }

  /** Осциллограмма прореживается до SAMPLES точек по максимуму модуля. */
  private push(waveform: Float32Array): void {
    const offset = this.writeIndex * SAMPLES;
    const stride = Math.max(1, Math.floor(waveform.length / SAMPLES));
    for (let i = 0; i < SAMPLES; i++) {
      let peak = 0;
      const start = i * stride;
      for (let j = 0; j < stride; j++) {
        const value = waveform[start + j] ?? 0;
        if (Math.abs(value) > Math.abs(peak)) peak = value;
      }
      this.history[offset + i] = peak;
    }
    this.writeIndex = (this.writeIndex + 1) % MAX_HISTORY;
    this.filled = Math.min(MAX_HISTORY, this.filled + 1);
  }
}
