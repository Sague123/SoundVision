import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/**
 * Осциллограмма в перспективе над уходящей в горизонт сеткой.
 *
 * Самая узнаваемая из «аудиошных» композиций: яркая волна по центру, под ней
 * отражение в полу, пол — сетка, убегающая к горизонту. Вся глубина здесь
 * настоящая: точки живут в трёхмерных координатах и проецируются делением на
 * z, а не рисуются «как будто в перспективе» заранее посчитанными линиями.
 * Из-за этого сетка сама сгущается к горизонту, а волна на ближнем краю
 * крупнее, чем на дальнем.
 *
 * Яркость набирается не площадью, а ядром: линия волны рисуется трижды —
 * широкое цветное гало, средний штрих и добела выжженная сердцевина. Именно
 * это даёт «раскалённый» вид референсов, которого не получить одной линией.
 */

/** Точек в одной осциллограмме. */
const SAMPLES = 256;
/** Линий сетки вдоль и поперёк. */
const GRID_LINES_Z = 28;
const GRID_LINES_X = 34;
/** Высота камеры над полом и её отступ назад, в мировых единицах. */
const EYE_HEIGHT = 1.15;
const EYE_BACK = 2.6;
/** Фокусное расстояние проекции: больше — уже поле зрения. */
const FOCAL = 1.5;
/** Ближняя плоскость: точки ближе неё не проецируются. */
const NEAR = 0.05;

interface Projected {
  x: number;
  y: number;
  /** Масштаб перспективы: 1 у камеры, меньше — вдали. Им же ведём толщину. */
  scale: number;
  visible: boolean;
}

export class WaveGrid3DPrimitive implements DrawPrimitive {
  readonly id = 'wave-grid-3d' as const;
  readonly kind = 'draw' as const;

  private width = 1;
  private height = 1;
  private samples = new Float32Array(SAMPLES);
  /** Медленный сдвиг сетки «на зрителя» — из-за него пол течёт. */
  private scroll = 0;
  private rng = mulberry32(1);

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    this.rng = mulberry32(seed.seed ^ 0x6d2b79f5);
    // Стартовая фаза сетки от seed: два трека не начинают с одного кадра.
    this.scroll = this.rng() * 10;
    this.samples.fill(0);
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    this.sample(mood.waveform);

    // Сетка едет в темпе: на быстрой музыке пол летит быстрее.
    const bpm = Math.max(60, mood.bpm);
    this.scroll += (frame.dtMs / 1000) * (bpm / 120) * (0.2 + params.speed * 1.4) * tuning.flow;

    const horizon = this.height * (0.5 - tuning.horizon * 0.2);
    const amplitude = 0.45 + mood.energy * 1.5 * tuning.amplitude;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this.drawGrid(frame, horizon, tuning.grid);
    this.drawWave(frame, horizon, amplitude, false);
    // Отражение: та же волна вниз, слабее. Пол становится зеркалом.
    if (tuning.reflection > 0.02) {
      this.drawWave(frame, horizon, amplitude, true);
    }

    ctx.restore();
    void palette;
    void weight;
  }

  /**
   * Проекция мировой точки на экран.
   *
   * Камера смотрит вдоль +z из точки (0, EYE_HEIGHT, -EYE_BACK). Деление на
   * глубину — это и есть перспектива: одно и то же смещение по x даёт тем
   * меньший сдвиг на экране, чем точка дальше.
   */
  private project(x: number, y: number, z: number, horizon: number): Projected {
    const depth = z + EYE_BACK;
    if (depth < NEAR) return { x: 0, y: 0, scale: 0, visible: false };

    const scale = FOCAL / depth;
    const unit = this.height * 0.5;
    return {
      x: this.width * 0.5 + x * scale * unit,
      y: horizon - (y - EYE_HEIGHT) * scale * unit,
      scale,
      visible: true,
    };
  }

  /** Пол: линии поперёк (уходят вдаль) и вдоль (бегут на зрителя). */
  private drawGrid(frame: RenderFrame, horizon: number, strength: number): void {
    if (strength <= 0.02) return;
    const { ctx, mood, palette, weight, tuning } = frame;

    const far = 26;
    const half = 9;

    // Продольные: идут от камеры к горизонту, поэтому сами сходятся в точку.
    ctx.beginPath();
    for (let i = 0; i <= GRID_LINES_X; i++) {
      const x = ((i / GRID_LINES_X) * 2 - 1) * half;
      const a = this.project(x, 0, 0.2, horizon);
      const b = this.project(x, 0, far, horizon);
      if (!a.visible || !b.visible) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.lineWidth = Math.max(1, tuning.lineWidth);
    ctx.strokeStyle = palette.accentAlpha(0.25, (0.05 + mood.energy * 0.1) * weight * strength);
    ctx.stroke();

    /*
     * Поперечные рисуем по одной: у каждой своя яркость и толщина от
     * глубины. Общий путь тут не годится — дальние линии должны гаснуть,
     * иначе у горизонта получается сплошная светлая полоса.
     */
    for (let i = 0; i < GRID_LINES_Z; i++) {
      // Дробная часть сдвига гонит сетку на зрителя без рывков на стыке.
      const t = (i + (this.scroll % 1)) / GRID_LINES_Z;
      // Квадрат по t сгущает линии у горизонта — так же, как это делает
      // настоящая перспектива на равномерной сетке.
      const z = 0.2 + t * t * far;
      const a = this.project(-half, 0, z, horizon);
      const b = this.project(half, 0, z, horizon);
      if (!a.visible || !b.visible) continue;

      const near = 1 - t;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = Math.max(1, near * 1.8 * tuning.lineWidth);
      ctx.strokeStyle = palette.accentAlpha(0.3, (0.04 + mood.energy * 0.16) * near * weight * strength);
      ctx.stroke();
    }
  }

  /**
   * Сама волна. Рисуется тремя проходами от широкого гало к белой сердцевине:
   * один штрих даёт ровную линию, а нужен раскалённый шнур.
   */
  private drawWave(frame: RenderFrame, horizon: number, amplitude: number, mirrored: boolean): void {
    const { ctx, mood, palette, weight, tuning } = frame;
    const z = 1.1;
    const span = 7.4;
    const baseY = mirrored ? -0.05 : EYE_HEIGHT * 0.95;
    const direction = mirrored ? -1 : 1;
    const fade = mirrored ? tuning.reflection * 0.5 : 1;

    const points: Projected[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const u = i / (SAMPLES - 1);
      const x = (u * 2 - 1) * span;
      // Волна уходит от камеры к горизонту по дуге: середина дальше краёв,
      // поэтому она читается как лежащая в пространстве, а не наклеенная.
      const bend = (1 - Math.cos(u * Math.PI)) * 0.5;
      const y = baseY + this.samples[i] * amplitude * direction;
      points.push(this.project(x, y, z + bend * 2.2, horizon));
    }

    const path = new Path2D();
    let started = false;
    for (const point of points) {
      if (!point.visible) continue;
      if (!started) {
        path.moveTo(point.x, point.y);
        started = true;
      } else {
        path.lineTo(point.x, point.y);
      }
    }
    if (!started) return;

    const energy = 0.35 + mood.energy * 0.65;
    const core = tuning.core;

    // Гало: широкое и цветное, набирает объём вокруг шнура.
    ctx.lineWidth = Math.max(2, 9 * tuning.lineWidth * energy);
    ctx.strokeStyle = palette.accentAlpha(0.45, 0.1 * energy * weight * fade * core);
    ctx.stroke(path);

    // Средний слой: собственно цвет линии.
    ctx.lineWidth = Math.max(1.5, 3.4 * tuning.lineWidth);
    ctx.strokeStyle = palette.accentAlpha(0.7, 0.32 * energy * weight * fade);
    ctx.stroke(path);

    /*
     * Сердцевина. Белая и почти непрозрачная — это то самое выжженное ядро,
     * которым держится вся яркость референсов. Без неё самая светлая точка
     * кадра остаётся приглушённым цветом, и картинка выглядит вялой.
     */
    ctx.lineWidth = Math.max(1, 1.3 * tuning.lineWidth);
    ctx.strokeStyle = `rgba(255,255,255,${(0.85 * energy * weight * fade * core).toFixed(3)})`;
    ctx.stroke(path);
  }

  /** Осциллограмма прореживается по максимуму модуля и сглаживается по времени. */
  private sample(waveform: Float32Array): void {
    const stride = Math.max(1, Math.floor(waveform.length / SAMPLES));
    for (let i = 0; i < SAMPLES; i++) {
      let peak = 0;
      const start = i * stride;
      for (let j = 0; j < stride; j++) {
        const value = waveform[start + j] ?? 0;
        if (Math.abs(value) > Math.abs(peak)) peak = value;
      }
      // Лёгкое сглаживание: без него волна дрожит покадрово и читается шумом.
      this.samples[i] = this.samples[i] * 0.35 + peak * 0.65;
    }
  }
}
