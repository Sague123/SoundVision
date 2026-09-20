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
    const noiseScale = (0.9 + params.chaos * 2.5) * tuning.noiseScale;

    /*
     * Вся яркость референса — в местах, где линии сгущаются: там аддитивное
     * смешивание само складывает их до белого. Сгущение берётся не из
     * случайности, а из производной формы полотна по номеру линии: там, где
     * полотно круто уходит вверх, соседние линии сходятся.
     *
     * Значит, размах обязан быть соизмерим со всей высотой кадра, а не с
     * шагом между линиями. С маленьким размахом полотно просто едет целиком,
     * линии идут строго параллельно, и на экране ровное тусклое поле — ровно
     * это и показывал замер: верхние 2% яркости отличались от медианы втрое,
     * то есть ни одна линия ни разу не легла на другую.
     */
    const amplitude = this.height * (0.1 + params.scale * 0.3) * (0.5 + mood.energy * 0.8)
      * tuning.amplitude;
    const spacing = (this.height * 0.84) / Math.max(1, lines - 1);
    // Потолок — чтобы полотно не выезжало за кадр целиком.
    const safeAmplitude = Math.min(amplitude, this.height * 0.42);

    // Та же логика постоянной «краски», что у ландшафта, но с запасом на
    // перекрытие: в сгущениях несколько линий должны складываться до белого.
    const ink = Math.min(1, 30 / lines);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = Math.max(1, (0.7 + params.sharpness * 0.6) * tuning.lineWidth);
    ctx.lineJoin = 'round';

    for (let line = 0; line < lines; line++) {
      const v = line / (lines - 1);
      const baseY = this.height * (0.08 + v * 0.84);
      /*
       * Сдвиг фазы по номеру линии держим маленьким: полотно должно остаться
       * связным. Большой сдвиг давал каждой линии независимую форму — они
       * пересекались во всех направлениях, тканевая структура пропадала, а
       * сгущений всё равно не возникало.
       */
      const linePhase = v * (0.2 + params.warp * 0.5);

      ctx.strokeStyle = palette.accentAlpha(v, (0.08 + mood.energy * 0.22) * weight * ink);
      ctx.beginPath();
      for (let i = 0; i < SAMPLES; i++) {
        const u = i / (SAMPLES - 1);
        const x = u * this.width;

        /*
         * По номеру линии шум меняется быстрее, чем по горизонтали.
         *
         * Сгущение линий возникает там, где производная формы по номеру
         * линии гасит равномерный шаг между ними: нужно, чтобы
         * `амплитуда * d(форма)/dv` было соизмеримо с высотой поля. При
         * прежнем множителе 0.6 для этого требовался размах в две трети
         * кадра — полотно уезжало бы за края. Втрое более частый шум по v
         * даёт то же сгущение при втрое меньшем размахе.
         */
        const smooth = this.noise.noise3D(
          u * noiseScale + this.phase, v * noiseScale * 1.8, this.drift + linePhase,
        );
        // Спектр берётся по логарифму частоты: иначе вся детализация уезжает
        // в левую четверть кадра, где живут низкие.
        const bin = Math.min(spectrum.length - 1,
          Math.floor((Math.exp(u * 4.6) / 100) * spectrum.length));
        // Спектр приходит линейной магнитудой (около 0.01..0.15 у музыки),
        // поэтому множитель здесь двузначный — он приводит деталь к тому же
        // порядку, что и плавная форма от шума.
        const detail = spectrum[bin] * 12;

        /*
         * Деталь от спектра идёт с долей шага между линиями, а не с полным
         * размахом: она добавляет фактуру, но не должна рвать порядок линий
         * по вертикали — иначе вместо ткани получается клубок.
         */
        const y = baseY + smooth * safeAmplitude
          + detail * tuning.spectrumMix * spacing * 0.8;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
