/**
 * Общее поле потока сцены.
 *
 * Им пользуются и примитив flow field, и все частицы. Это принципиально:
 * частицы, которых несёт то же поле, что и линии фона, читаются как часть
 * сцены, а не как отдельный слой, наложенный сверху.
 */

import { SimplexNoise } from './noise.ts';
import type { Impulse } from './scene.ts';
import { mulberry32, type GeneratorSeed } from './seed.ts';

const TAU = Math.PI * 2;
/**
 * Сколько волн одновременно толкают вещество. Больше трёх на глаз не
 * различить, а стоимость растёт линейно по числу частиц.
 */
const MAX_PUSHING_WAVES = 3;

/** Фронт волны, пересчитанный в пиксели — чтобы не считать это в горячем цикле. */
export interface Wave {
  x: number;
  y: number;
  ring: number;
  thickness: number;
  force: number;
}

export class FlowField {
  private noise = new SimplexNoise();
  private phase = 0;

  reseed(seed: GeneratorSeed): void {
    this.noise = new SimplexNoise(mulberry32(seed.seed ^ 0x9e3779b9));
    this.phase = seed.phase['flow-field'];
  }

  /**
   * Угол поля в точке.
   *
   * @param scale размер деталей поля: 0 — мелкая турбулентность, 1 — длинные реки
   * @param turbulence множитель закрученности
   */
  angleAt(x: number, y: number, timeSeconds: number, speed: number, scale: number, turbulence: number): number {
    const fieldScale = 0.0016 + (1 - scale) * 0.007;
    const t = timeSeconds * (0.05 + speed * 0.35) + this.phase;
    return this.noise.noise3D(x * fieldScale, y * fieldScale, t) * TAU * turbulence;
  }

  /**
   * Готовит список волн для расталкивания частиц.
   * Считается один раз на кадр, а не на каждую частицу.
   */
  static prepareWaves(
    impulses: readonly Impulse[],
    width: number,
    height: number,
    velocity: number,
    dt: number,
    pressure: number,
  ): Wave[] {
    const diagonal = Math.hypot(width, height);
    return impulses
      .slice()
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_PUSHING_WAVES)
      .map((impulse) => ({
        x: impulse.x * width,
        y: impulse.y * height,
        ring: impulse.radius * diagonal,
        thickness: diagonal * 0.06,
        // Волна давления усиливает толчок, не меняя его форму.
        force: impulse.strength * (1 - impulse.age / impulse.life)
          * velocity * 2.4 * dt * (1 + pressure),
      }))
      .filter((wave) => wave.force > 0.01);
  }

  /**
   * Суммарный толчок волн в точке. Записывает результат в `out`,
   * чтобы не плодить объекты на каждую частицу.
   */
  static pushAt(waves: readonly Wave[], x: number, y: number, out: { x: number; y: number }): void {
    out.x = 0;
    out.y = 0;
    for (const wave of waves) {
      const dx = x - wave.x;
      const dy = y - wave.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 1e-3) continue;
      // Гауссиана вокруг фронта: толкает только там, где волна сейчас проходит.
      const offset = (distance - wave.ring) / wave.thickness;
      const falloff = Math.exp(-offset * offset);
      if (falloff < 0.01) continue;
      const push = (wave.force * falloff) / distance;
      out.x += dx * push;
      out.y += dy * push;
    }
  }
}
