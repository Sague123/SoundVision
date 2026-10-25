import { mulberry32, type GeneratorSeed } from '../seed.ts';
import { SpectrumBands } from './spectrum-bands.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';
import { WaveformGain } from './waveform-gain.ts';

/**
 * Осциллограмма, свёрнутая в окружность.
 *
 * Центр остаётся пустым — там место обложке трека. Зеркальная симметрия по N
 * лучам берётся от seed: один трек получает четыре сектора, другой девять, и
 * кольца выглядят по-разному при том же сигнале.
 *
 * Снаружи колец — радиальный эквалайзер: столбцы спектра расходятся лучами,
 * низ частот сверху, верх — к низу, левая половина зеркалит правую. Кольцо
 * рисует саму волну, лучи — из чего она сложена.
 */

const SAMPLES = 360;
/** Лучей эквалайзера на половину круга. */
const EQ_BARS = 48;

export class RadialWaveformPrimitive implements DrawPrimitive {
  readonly id = 'radial-waveform' as const;
  readonly kind = 'draw' as const;

  private readonly samples = new Float32Array(SAMPLES);
  private width = 1;
  private readonly autoGain = new WaveformGain();
  private height = 1;
  private rays = 6;
  private spin = 0;
  private direction = 1;
  private readonly bands = new SpectrumBands(EQ_BARS);
  private rainbow = false;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x9d2c5680);
    this.rays = 3 + Math.floor(rng() * 8);
    this.direction = rng() < 0.5 ? -1 : 1;
    this.spin = rng() * Math.PI * 2;
    this.rainbow = rng() < 0.5;
    this.bands.reset();
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    this.sample(mood.waveform, this.autoGain.update(mood.waveform, frame.dtMs / 1000));

    const cx = this.width / 2;
    const cy = this.height / 2;
    const minSide = Math.min(this.width, this.height);
    // Внутренний радиус — дыра под карточку трека.
    // Под обложкой кольцо расступается: оно обрамляет её, а не лезет сверху.
    const inner = Math.max(
      minSide * (0.12 + params.scale * 0.08) * tuning.radius,
      minSide * frame.hole,
    );
    const amplitude = minSide * (0.06 + params.scale * 0.12) * (0.4 + mood.energy * 1.3)
      * tuning.amplitude;

    this.spin += (frame.dtMs / 1000) * this.direction * (0.05 + params.speed * 0.35) * tuning.spin;

    // Один сектор считаем, остальные получаем поворотом и отражением —
    // симметрия должна быть точной, иначе кольцо «плывёт».
    const sector = (Math.PI * 2) / this.rays;
    const perSector = Math.max(8, Math.floor(SAMPLES / this.rays));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = Math.max(1, (0.9 + params.sharpness * 0.9) * tuning.lineWidth);
    ctx.lineJoin = 'round';

    const rings = Math.max(1, Math.round(tuning.rings * (0.5 + params.density * 0.75)));
    const outward = Math.min(1, frame.hole * 6);
    for (let ring = 0; ring < rings; ring++) {
      // Под обложкой кольца плотнее: иначе вся конструкция упирается в текст песни.
      const ringScale = 1 + ring * 0.22 * (1 - outward * 0.5);
      const fade = 1 - ring / (rings + 0.6);
      ctx.strokeStyle = palette.accentAlpha(0.2 + ring * 0.3, (0.16 + mood.energy * 0.4) * fade * weight);

      ctx.beginPath();
      for (let ray = 0; ray < this.rays; ray++) {
        // Каждый второй сектор зеркалим: получается замкнутый симметричный контур.
        const mirror = ray % 2 === 1;
        for (let i = 0; i <= perSector; i++) {
          const local = i / perSector;
          const index = Math.floor((mirror ? 1 - local : local) * (perSector - 1));
          const value = this.samples[(index + ring * 17) % SAMPLES];
          const angle = this.spin + ray * sector + local * sector;
          // Под обложкой волна идёт только наружу: внутрь ей некуда.
      const radius = inner * ringScale + (value + (Math.abs(value) - value) * outward) * amplitude;
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          if (ray === 0 && i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.stroke();
    }

    if (tuning.eq > 0.01) {
      const base = inner * (1 + (rings - 1) * 0.22 * (1 - outward * 0.5)) + amplitude * 0.3 + minSide * 0.015;
      this.drawEqualizer(frame, cx, cy, base, minSide * 0.13 * tuning.eq);
    }
    ctx.restore();
  }

  private drawEqualizer(frame: RenderFrame, cx: number, cy: number, base: number, reach: number): void {
    const { ctx, mood, palette, weight } = frame;
    this.bands.update(mood.spectrum, mood.binHz, EQ_BARS, frame.dtMs / 1000, mood.energy);
    const values = this.bands.values;
    const step = Math.PI / EQ_BARS;
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(1.5, base * step * 0.55);
    const body = (0.28 + mood.energy * 0.3) * weight;
    for (let k = 0; k < EQ_BARS; k++) {
      const value = values[k];
      if (value < 0.02) continue;
      const length = value * reach;
      const t = k / EQ_BARS;
      const colour = this.rainbow
        ? `hsl(${(t * 300).toFixed(0)} 90% ${(55 + value * 25).toFixed(0)}% / ${body.toFixed(3)})`
        : palette.accentAlpha(0.15 + t * 0.75, body);
      ctx.strokeStyle = colour;
      // Низ частот сверху, дальше по обе стороны вниз.
      const angle = -Math.PI / 2 + (k + 0.5) * step;
      ctx.beginPath();
      for (let side = 0; side < 2; side++) {
        const a = side === 0 ? angle : Math.PI - angle;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        ctx.moveTo(cx + cos * base, cy + sin * base);
        ctx.lineTo(cx + cos * (base + length), cy + sin * (base + length));
      }
      ctx.stroke();
    }
  }

  private sample(waveform: Float32Array, gain: number): void {
    const stride = Math.max(1, Math.floor(waveform.length / SAMPLES));
    for (let i = 0; i < SAMPLES; i++) {
      let peak = 0;
      const start = i * stride;
      for (let j = 0; j < stride; j++) {
        const value = waveform[start + j] ?? 0;
        if (Math.abs(value) > Math.abs(peak)) peak = value;
      }
      // Сглаживаем по кругу: скачок между последним и первым отсчётом виден
      // как разрыв кольца.
      this.samples[i] = this.samples[i] * 0.4 + peak * gain * 0.6;
    }
  }
}
