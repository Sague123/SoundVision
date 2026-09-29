import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';
import { WaveformGain } from './waveform-gain.ts';

/**
 * Лента волны: раскалённая белая сердцевина через весь кадр и цветные
 * пряди вокруг неё.
 *
 * Сердцевина — сама осциллограмма, слегка сглаженная. Пряди — та же волна
 * со сдвигом во времени, своим сглаживанием и своим размахом. Насколько
 * пряди расходятся, решают энергия и верха: на тихом месте они ложатся на
 * сердцевину и кадр держит одна тонкая линия, на громком — раскрываются
 * веером. Сила музыки видна напрямую, без подписи.
 *
 * К краям кадра размах сходится в ноль: лента выходит из точки и в точку
 * уходит, как на осциллографе с окном. Без окна обрез волны у края
 * читается как ошибка отрисовки.
 */

/** Точек на прядь: при 1920 пикселях — шаг в шесть пикселей, ломаная не видна. */
const POINTS = 320;
/** Сколько отсчётов осциллограммы ложится на ширину кадра. */
const SPAN = 1024;
const MAX_STRANDS = 12;

export class WaveformRibbonPrimitive implements DrawPrimitive {
  readonly id = 'waveform-ribbon' as const;
  readonly kind = 'draw' as const;

  private height = 1;
  private readonly autoGain = new WaveformGain();
  /** Префиксные суммы осциллограммы: скользящее среднее за O(1) на точку. */
  private prefix = new Float64Array(1);
  private readonly xs = new Float32Array(POINTS);
  private readonly window = new Float32Array(POINTS);
  /** Сглаженная огибающая размаха: пряди раскрываются плавно, а не рывком. */
  private spread = 0;
  /** Фазы медленной модуляции прядей — от seed, чтобы треки различались. */
  private readonly phases = new Float32Array(MAX_STRANDS);

  constructor() {
    for (let i = 0; i < POINTS; i++) {
      const t = i / (POINTS - 1);
      // Окно с плоской серединой: sin^0.6 держит размах почти до краёв.
      this.window[i] = Math.pow(Math.sin(Math.PI * t), 0.6);
    }
  }

  resize(width: number, height: number): void {
    this.height = height;
    const margin = width * 0.04;
    for (let i = 0; i < POINTS; i++) {
      this.xs[i] = margin + (i / (POINTS - 1)) * (width - margin * 2);
    }
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x2545f491);
    for (let i = 0; i < MAX_STRANDS; i++) this.phases[i] = rng() * Math.PI * 2;
    this.spread = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    const dt = frame.dtMs / 1000;
    const wave = mood.waveform;
    if (wave.length < 8) return;

    const gain = this.autoGain.update(wave, dt);
    this.buildPrefix(wave);

    // Раскрытие: энергия плюс верха и атака. Раскрывается быстро,
    // схлопывается медленно — удар оставляет после себя веер.
    const target = Math.min(1, mood.energy * 0.7 + mood.brightness * 0.25 + mood.onsetStrength * 0.4)
      * tuning.spread;
    const k = 1 - Math.exp(-dt / (target > this.spread ? 0.08 : 0.9));
    this.spread += (target - this.spread) * k;

    const cy = this.height * 0.5;
    const loud = 0.4 + mood.energy * 0.6;
    const amplitude = this.height * 0.22 * tuning.amplitude * loud * gain * (0.8 + params.scale * 0.4);
    const span = Math.min(SPAN, wave.length);
    const strands = Math.min(MAX_STRANDS, Math.max(0, Math.round(tuning.strands)));
    const baseSmooth = 1 + Math.round(tuning.smoothing * 10);
    const time = frame.timeMs / 1000;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Пряди: сначала дальние и тусклые, ближние к сердцевине — поверх.
    for (let s = strands - 1; s >= 0; s--) {
      const rank = (s + 1) / Math.max(1, strands);
      // Сдвиг во времени и собственное сглаживание: пряди похожи на
      // сердцевину, но не повторяют её.
      const offset = Math.min(wave.length - span, Math.round(rank * 90 * (0.4 + this.spread)));
      const smooth = baseSmooth + Math.round(rank * 14);
      const reach = 1 + rank * this.spread * 1.6;
      const drift = 0.25 * this.spread;
      const phase = this.phases[s];
      ctx.beginPath();
      for (let i = 0; i < POINTS; i++) {
        const u = i / (POINTS - 1);
        const value = this.average(offset + Math.floor(u * (span - 1)), smooth);
        // Медленная бегущая модуляция размаха: пряди дышат по-разному.
        const breathe = 1 + drift * Math.sin(u * 7 + time * (0.6 + rank) + phase);
        const y = cy + value * amplitude * reach * breathe * this.window[i];
        if (i === 0) ctx.moveTo(this.xs[i], y);
        else ctx.lineTo(this.xs[i], y);
      }
      const alpha = (0.1 + this.spread * 0.35) * (1 - rank * 0.45) * weight;
      ctx.lineWidth = Math.max(1, (1 + rank * 1.5) * tuning.lineWidth);
      ctx.strokeStyle = palette.accentAlpha(0.1 + rank * 0.8, alpha);
      ctx.stroke();
    }

    // Сердцевина: один путь, три обводки — широкий цветной ореол, плотный
    // внутренний и белая линия. Ядро не гаснет с энергией: тихое место
    // отличается размахом и ореолом, а не серой линией.
    ctx.beginPath();
    for (let i = 0; i < POINTS; i++) {
      const u = i / (POINTS - 1);
      const value = this.average(Math.floor(u * (span - 1)), baseSmooth);
      const y = cy + value * amplitude * this.window[i];
      if (i === 0) ctx.moveTo(this.xs[i], y);
      else ctx.lineTo(this.xs[i], y);
    }
    ctx.lineWidth = Math.max(3, 14 * tuning.lineWidth * loud);
    ctx.strokeStyle = palette.accentAlpha(0.4, 0.14 * weight * tuning.core);
    ctx.stroke();
    ctx.lineWidth = Math.max(2, 5 * tuning.lineWidth * loud);
    ctx.strokeStyle = palette.accentAlpha(0.55, 0.4 * weight);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 1.6 * tuning.lineWidth);
    ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, 0.95 * weight * tuning.core).toFixed(3)})`;
    ctx.stroke();
    ctx.restore();
  }

  private buildPrefix(wave: Float32Array): void {
    if (this.prefix.length !== wave.length + 1) this.prefix = new Float64Array(wave.length + 1);
    let sum = 0;
    this.prefix[0] = 0;
    for (let i = 0; i < wave.length; i++) {
      sum += wave[i];
      this.prefix[i + 1] = sum;
    }
  }

  /** Скользящее среднее вокруг отсчёта `index` с полуокном `radius`. */
  private average(index: number, radius: number): number {
    const last = this.prefix.length - 1;
    const a = Math.max(0, index - radius);
    const b = Math.min(last, index + radius + 1);
    return b > a ? (this.prefix[b] - this.prefix[a]) / (b - a) : 0;
  }
}
