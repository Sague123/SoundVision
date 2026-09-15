import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/**
 * Осциллограмма, свёрнутая в окружность.
 *
 * Центр остаётся пустым — там место обложке трека. Зеркальная симметрия по N
 * лучам берётся от seed: один трек получает четыре сектора, другой девять, и
 * кольца выглядят по-разному при том же сигнале.
 */

const SAMPLES = 360;

export class RadialWaveformPrimitive implements DrawPrimitive {
  readonly id = 'radial-waveform' as const;
  readonly kind = 'draw' as const;

  private readonly samples = new Float32Array(SAMPLES);
  private width = 1;
  private height = 1;
  private rays = 6;
  private spin = 0;
  private direction = 1;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x9d2c5680);
    this.rays = 3 + Math.floor(rng() * 8);
    this.direction = rng() < 0.5 ? -1 : 1;
    this.spin = rng() * Math.PI * 2;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    this.sample(mood.waveform);

    const cx = this.width / 2;
    const cy = this.height / 2;
    const minSide = Math.min(this.width, this.height);
    // Внутренний радиус — дыра под карточку трека.
    const inner = minSide * (0.12 + params.scale * 0.08) * tuning.radius;
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
    for (let ring = 0; ring < rings; ring++) {
      const ringScale = 1 + ring * 0.22;
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
          const radius = inner * ringScale + value * amplitude;
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          if (ray === 0 && i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  private sample(waveform: Float32Array): void {
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
      this.samples[i] = this.samples[i] * 0.4 + peak * 0.6;
    }
  }
}
