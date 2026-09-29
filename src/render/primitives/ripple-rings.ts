import { mulberry32, type GeneratorSeed } from '../seed.ts';
import { SpectrumBands } from './spectrum-bands.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';
import { WaveformGain } from './waveform-gain.ts';

/**
 * Кольца-волны вокруг обложки.
 *
 * Из-под центра непрерывно расходятся тонкие кольца. Каждое — снимок звука
 * в момент рождения: форма по кругу берётся из спектра (низ частот сверху,
 * по сторонам зеркально — как у радиального эквалайзера) и из формы волны.
 * Пока кольцо расходится, его волнистость растёт, а само оно гаснет, так что
 * кадр — это история последних секунд музыки, разбегающаяся от центра.
 *
 * Удар выпускает яркое кольцо вне очереди, громкость задаёт скорость
 * расхождения: на дропе кольца летят, в куплете плывут. Вокруг обложки —
 * светящийся обод, он дышит басом.
 */

const MAX_RINGS = 48;
/** Точек на кольцо: при радиусе в полэкрана шаг ~15 px, кривая гладкая. */
const ANGLES = 144;
const HALF = ANGLES / 2;
/** Минимальный промежуток между ударными кольцами, мс. */
const ONSET_GAP_MS = 90;

export class RippleRingsPrimitive implements DrawPrimitive {
  readonly id = 'ripple-rings' as const;
  readonly kind = 'draw' as const;
  /** Кольца — тонкие и быстрые: следы превращают их в сплошные полосы. */
  readonly maxTrail = 0.02;

  private readonly bands = new SpectrumBands(HALF);
  private readonly autoGain = new WaveformGain();
  /** Форма каждого кольца по углу, −1..1. */
  private readonly profiles = new Float32Array(MAX_RINGS * ANGLES);
  private readonly born = new Float64Array(MAX_RINGS).fill(-Infinity);
  private readonly strength = new Float32Array(MAX_RINGS);
  private readonly speed = new Float32Array(MAX_RINGS);
  private next = 0;
  private sinceSpawn = 0;
  private lastOnsetAt = -Infinity;
  private readonly xs = new Float32Array(ANGLES);
  private readonly ys = new Float32Array(ANGLES);
  private readonly cos = new Float32Array(ANGLES);
  private readonly sin = new Float32Array(ANGLES);
  private width = 1;
  private height = 1;
  private spin = 0;
  private direction = 1;
  private halo = 0;

  constructor() {
    this.setAngles(0);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x6a09e667);
    this.direction = rng() < 0.5 ? -1 : 1;
    this.spin = rng() * Math.PI * 2;
    this.born.fill(-Infinity);
    this.bands.reset();
    this.next = 0;
    this.sinceSpawn = 0;
  }

  dispose(): void {}

  draw(frame: RenderFrame): void {
    const { ctx, mood, params, palette, weight, tuning } = frame;
    const dt = frame.dtMs / 1000;
    const now = frame.timeMs;
    this.bands.update(mood.spectrum, mood.binHz, HALF, dt, mood.energy);
    const gain = this.autoGain.update(mood.waveform, dt);

    const minSide = Math.min(this.width, this.height);
    // Кольца выходят из-за края обложки; без обложки — из небольшого круга.
    const origin = Math.max(minSide * 0.1, minSide * frame.hole) + minSide * 0.012;
    const reach = Math.hypot(this.width, this.height) * 0.52;

    // Ровный поток колец плюс ударные вне очереди.
    const intervalMs = 280 / Math.max(0.2, tuning.rate * (0.7 + params.density * 0.6));
    this.sinceSpawn += frame.dtMs;
    if (mood.onset && mood.onsetStrength > 0.35 && now - this.lastOnsetAt > ONSET_GAP_MS) {
      this.lastOnsetAt = now;
      this.spawn(now, 0.55 + mood.onsetStrength * 0.45, mood, gain, minSide, tuning.speed);
      this.sinceSpawn = 0;
    } else if (this.sinceSpawn >= intervalMs) {
      this.sinceSpawn = 0;
      this.spawn(now, 0.2 + mood.energy * 0.3, mood, gain, minSide, tuning.speed);
    }

    this.spin += dt * this.direction * (0.04 + params.speed * 0.12) * tuning.spin;
    this.setAngles(this.spin);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    const cx = this.width / 2;
    const cy = this.height / 2;
    const deform = minSide * 0.045 * tuning.amplitude;
    const lineScale = tuning.lineWidth * (0.8 + params.sharpness * 0.4);

    for (let i = 0; i < MAX_RINGS; i++) {
      // Пустой слот: время рождения −∞, возраст вышел бы бесконечным.
      if (this.born[i] === -Infinity) continue;
      const age = (now - this.born[i]) / 1000;
      if (age < 0) continue;
      const radius = origin + this.speed[i] * age;
      const t = (radius - origin) / (reach - origin);
      if (t >= 1) {
        this.born[i] = -Infinity;
        continue;
      }
      const s = this.strength[i];
      // Волнистость проявляется за первые полсекунды и растёт с радиусом.
      const grow = Math.min(1, age / 0.5) * (0.35 + t * 0.9);
      const amplitude = deform * (0.4 + s) * grow;
      const offset = i * ANGLES;
      for (let k = 0; k < ANGLES; k++) {
        const r = radius + this.profiles[offset + k] * amplitude;
        this.xs[k] = cx + this.cos[k] * r;
        this.ys[k] = cy + this.sin[k] * r;
      }
      const fade = Math.pow(1 - t, 1.4) * Math.min(1, age / 0.12);
      this.traceLoop(ctx);
      ctx.lineWidth = Math.max(1, (0.9 + s * 1.3) * lineScale);
      ctx.strokeStyle = palette.accentAlpha(0.1 + t * 0.8, (0.18 + s * 0.6) * fade * weight);
      ctx.stroke();
      // Ударное кольцо со светлой сердцевиной — пока оно молодое.
      if (s > 0.6 && t < 0.45) {
        ctx.lineWidth = Math.max(1, 1.1 * lineScale);
        ctx.strokeStyle = `rgba(255,255,255,${(0.7 * (s - 0.5) * fade * weight * (1 - t / 0.45)).toFixed(3)})`;
        ctx.stroke();
      }
    }

    // Обод вокруг обложки: ровный круг, толщина и свечение — от баса.
    const bass = mood.bands.low;
    this.halo += (bass - this.halo) * (bass > this.halo ? 0.5 : 0.08);
    const haloRadius = origin - minSide * 0.006;
    ctx.beginPath();
    ctx.arc(cx, cy, haloRadius, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, minSide * (0.006 + this.halo * 0.012) * tuning.lineWidth);
    ctx.strokeStyle = palette.accentAlpha(0.35, (0.2 + this.halo * 0.35) * weight * tuning.halo);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 1.2 * lineScale);
    ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, (0.45 + this.halo * 0.5) * weight * tuning.halo).toFixed(3)})`;
    ctx.stroke();
    ctx.restore();
  }

  /** Новое кольцо: снимок спектра и волны, скорость — от громкости сейчас. */
  private spawn(now: number, strength: number, mood: RenderFrame['mood'], gain: number,
    minSide: number, speedTuning: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_RINGS;
    this.born[i] = now;
    this.strength[i] = Math.min(1, strength);
    this.speed[i] = minSide * (0.1 + mood.energy * 0.22) * speedTuning;

    const values = this.bands.values;
    const wave = mood.waveform;
    const stride = Math.max(1, Math.floor(wave.length / HALF));
    const offset = i * ANGLES;
    for (let k = 0; k < HALF; k++) {
      // Спектр — выпуклость наружу, волна — мелкая рябь в обе стороны.
      const spectral = values[k] * 2 - 0.6;
      const w = (wave[k * stride] ?? 0) * gain;
      const v = Math.max(-1, Math.min(1, spectral * 0.65 + w * 0.5));
      // Зеркально: правая половина сверху вниз, левая — её отражение.
      this.profiles[offset + k] = v;
      this.profiles[offset + ANGLES - 1 - k] = v;
    }
  }

  /** Углы: низ частот сверху, дальше по обе стороны вниз; плюс общий поворот. */
  private setAngles(spin: number): void {
    for (let k = 0; k < ANGLES; k++) {
      const angle = -Math.PI / 2 + ((k + 0.5) / ANGLES) * Math.PI * 2 + spin;
      this.cos[k] = Math.cos(angle);
      this.sin[k] = Math.sin(angle);
    }
  }

  /** Замкнутая гладкая кривая: квадратичные дуги через середины отрезков. */
  private traceLoop(ctx: CanvasRenderingContext2D): void {
    const xs = this.xs;
    const ys = this.ys;
    const last = ANGLES - 1;
    ctx.beginPath();
    ctx.moveTo((xs[last] + xs[0]) / 2, (ys[last] + ys[0]) / 2);
    for (let k = 0; k < ANGLES; k++) {
      const n = k === last ? 0 : k + 1;
      ctx.quadraticCurveTo(xs[k], ys[k], (xs[k] + xs[n]) / 2, (ys[k] + ys[n]) / 2);
    }
    ctx.closePath();
  }
}
