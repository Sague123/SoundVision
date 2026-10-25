import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { ModifierPrimitive, RenderFrame } from './types.ts';

/**
 * Не рисует ничего сам — отражает уже нарисованный слой N-угольной симметрией.
 * Это и есть «калейдоскоп любого примитива» из плана: работает поверх чего угодно.
 */
export class KaleidoscopePrimitive implements ModifierPrimitive {
  readonly id = 'kaleidoscope' as const;
  readonly kind = 'modifier' as const;

  private width = 1;
  private height = 1;
  private phase = 0;
  private spinDirection = 1;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x7feb352d);
    this.phase = seed.phase.kaleidoscope;
    this.spinDirection = rng() < 0.5 ? -1 : 1;
  }

  dispose(): void {}

  apply(frame: RenderFrame, source: CanvasImageSource): void {
    const { ctx, params, mood, weight } = frame;
    // Секторы берутся из настройки: симметрия — это то, что настраивают в
    // первую очередь, а seed задаёт лишь стартовое значение.
    const sectors = Math.max(3, Math.round(frame.tuning.segments));
    const cx = this.width / 2;
    const cy = this.height / 2;
    // Радиус до угла: иначе в углах экрана остаются пустые клинья.
    const radius = Math.hypot(cx, cy);
    const wedge = (Math.PI * 2) / sectors;
    const spin = ((frame.timeMs / 1000) * 0.08 * this.spinDirection * (0.3 + params.speed)
      * (0.4 + frame.tuning.twist * 1.7) + this.phase) %
      (Math.PI * 2);

    ctx.clearRect(0, 0, this.width, this.height);

    // Ниже единичного веса просто подмешиваем неотражённый исходник — так
    // включение/выключение калейдоскопа ощущается как морфинг, а не щелчок.
    if (weight < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - weight;
      ctx.drawImage(source, 0, 0, this.width, this.height);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = weight;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < sectors; i++) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(spin + i * wedge);
      if (i % 2 === 1) ctx.scale(1, -1); // зеркалим каждый второй клин — получается шов без разрыва

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, -wedge / 2, wedge / 2);
      ctx.closePath();
      ctx.clip();

      // Внутрь клина кладём один и тот же кусок исходника, слегка увеличенный.
      const zoom = (1 + mood.energy * 0.12) * frame.tuning.zoom;
      ctx.rotate(-wedge / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-cx, -cy);
      ctx.drawImage(source, 0, 0, this.width, this.height);
      ctx.restore();
    }
    ctx.restore();
  }
}
