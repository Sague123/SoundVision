import { SimplexNoise } from '../noise.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/**
 * Поток параллельных линий.
 *
 * Каждая линия смещается суммой трёх вкладов: низкочастотный шум задаёт
 * плавную форму, спектр — детализацию, а номер линии — сдвиг фазы. Линии
 * намеренно не пересекаются: тканевая структура сохраняется, а там, где они
 * сходятся, аддитивное смешивание само даёт яркие полосы. Это и есть красота
 * референса — она получается из сгущения линий, а не рисуется отдельно.
 */

const SAMPLES = 200;

export class WaveMeshPrimitive implements DrawPrimitive {
  readonly id = 'wave-mesh' as const;
  readonly kind = 'draw' as const;

  private noise = new SimplexNoise();
  private width = 1;
  private height = 1;
  private phase = 0;
  private drift = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x3243f6a8);
    this.noise = new SimplexNoise(rng);
    this.phase = rng() * 100;
    this.drift = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    const lines = Math.max(4, Math.round(tuning.lines * (0.5 + params.density * 0.5)));

    // Фаза течёт непрерывно, а не берётся от абсолютного времени: при смене
    // скорости поток не дёргается.
    this.drift += (frame.dtMs / 1000) * (0.05 + params.speed * 0.5) * tuning.flow;

    const spectrum = mood.spectrum;
    const amplitude = this.height * (0.02 + params.scale * 0.05) * (0.5 + mood.energy * 1.2)
      * tuning.amplitude;
    const noiseScale = (0.9 + params.chaos * 2.5) * tuning.noiseScale;

    /**
     * Ткань держится на том, что линии не пересекаются: соседние идут через
     * `height * 0.84 / lines`, и размах больше половины этого шага сплавляет
     * их в заливку. Поэтому амплитуда ограничена шагом, а не только настройкой.
     */
    const spacing = (this.height * 0.84) / Math.max(1, lines - 1);
    const safeAmplitude = Math.min(amplitude, spacing * 0.45);

    // Та же логика постоянной «краски», что у ландшафта: сто аддитивных линий
    // с непрозрачностью одной дают сплошное поле вместо ткани.
    const ink = Math.min(1, 24 / lines);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = Math.max(1, (0.7 + params.sharpness * 0.6) * tuning.lineWidth);
    ctx.lineJoin = 'round';

    for (let line = 0; line < lines; line++) {
      const v = line / (lines - 1);
      const baseY = this.height * (0.08 + v * 0.84);
      // Сдвиг фазы по номеру линии — из-за него поток «течёт» поперёк, а не
      // колеблется одинаково по всей высоте.
      const linePhase = v * (1.5 + params.warp * 4);

      ctx.strokeStyle = palette.accentAlpha(v, (0.08 + mood.energy * 0.22) * weight * ink);
      ctx.beginPath();
      for (let i = 0; i < SAMPLES; i++) {
        const u = i / (SAMPLES - 1);
        const x = u * this.width;

        const smooth = this.noise.noise3D(
          u * noiseScale + this.phase, v * noiseScale * 0.6, this.drift + linePhase,
        );
        // Спектр берётся по логарифму частоты: иначе вся детализация уезжает
        // в левую четверть кадра, где живут низкие.
        const bin = Math.min(spectrum.length - 1,
          Math.floor((Math.exp(u * 4.6) / 100) * spectrum.length));
        // Спектр приходит линейной магнитудой (около 0.01..0.15 у музыки),
        // поэтому множитель здесь двузначный — он приводит деталь к тому же
        // порядку, что и плавная форма от шума.
        const detail = spectrum[bin] * 12;

        const y = baseY + (smooth + detail * tuning.spectrumMix * 2) * safeAmplitude;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
