/**
 * Частицы: девять типов в одном общем поле потока.
 *
 * Общее поле — не деталь реализации, а главное свойство: все типы несёт тот
 * же поток, что и линии фона, поэтому они читаются как часть сцены, а не как
 * наложенный сверху слой.
 *
 * Активный набор выбирается тем же непрерывным рейтингом уместности, что и
 * примитивы: никаких «включить дождь», только то, что сейчас к месту.
 */

import { clamp01 } from '../audio/features.ts';
import type { MoodVector } from '../audio/mood-vector.ts';
import { FlowField, type Wave } from './flow-field.ts';
import type { Palette } from './palette.ts';
import { lerp, smoothstep } from './primitives/types.ts';
import type { Impulse, SceneState } from './scene.ts';
import { mulberry32, type GeneratorSeed, type Rng } from './seed.ts';

export const PARTICLE_TYPES = [
  'sparks', 'dust', 'ribbons', 'shards', 'bokeh', 'swarm', 'embers', 'streaks', 'petals',
] as const;

export type ParticleType = (typeof PARTICLE_TYPES)[number];

export const PARTICLE_LABELS: Record<ParticleType, string> = {
  sparks: 'Sparks (искры)',
  dust: 'Dust (взвесь)',
  ribbons: 'Ribbons (ленты)',
  shards: 'Shards (осколки)',
  bokeh: 'Bokeh (боке)',
  swarm: 'Swarm (стая)',
  embers: 'Embers (угли)',
  streaks: 'Streaks (дождь)',
  petals: 'Petals (лепестки)',
};

/** Общий потолок: выше этого Canvas 2D перестаёт укладываться в кадр. */
const MAX_PARTICLES = 1400;
/** Сколько типов живёт одновременно — по секциям, как и у примитивов. */
/**
 * Постоянный тип частиц ровно один.
 *
 * Раньше их было два-три — тот же «N активных одновременно», от которого
 * ушла система фокуса, только для частиц. По иерархии ролей частицы
 * привязаны к соло и не самостоятельны: два независимых типа поверх соло
 * возвращают ровно ту кашу, из-за которой глазу не за что зацепиться.
 *
 * Вдобавок к нему разрешён один ударный тип: он рождается только в момент
 * импульса и между ударами ничего не рисует, так что кадр не загромождает.
 */
const AMBIENT_TYPES = 1;
/** Длина хвоста у лент. */
const RIBBON_TRAIL = 9;

interface Particle {
  type: ParticleType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  tone: number;
  /** Угол и скорость вращения — нужны осколкам и лепесткам. */
  angle: number;
  spin: number;
  /** Хвост: выделяется только лентам. */
  trail: Float32Array | null;
  trailLength: number;
}

export interface ParticleConfig {
  /** auto — набор выбирает рейтинг; manual — список ниже. */
  mode: 'auto' | 'manual';
  manual: ParticleType[];
  /** Общий множитель плотности, 0..1. */
  density: number;
  /** Множитель времени жизни частицы. */
  life: number;
  /** Множитель скорости в общем поле потока. */
  speed: number;
  /** Множитель размера частицы. */
  size: number;
  enabled: boolean;
}

export interface ParticleDebug {
  active: ParticleType[];
  count: number;
}

export class ParticleSystem {
  private readonly particles: Particle[] = [];
  private readonly weights = new Map<ParticleType, number>();
  private readonly bias = new Map<ParticleType, number>();
  private rng: Rng = mulberry32(1);
  private width = 1;
  private height = 1;
  private readonly push = { x: 0, y: 0 };
  /** Накопитель дробной части спавна: без него редкие типы не появляются вовсе. */
  private readonly spawnDebt = new Map<ParticleType, number>();

  constructor(private field: FlowField) {
    for (const type of PARTICLE_TYPES) {
      this.weights.set(type, 0);
      this.spawnDebt.set(type, 0);
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.particles.length = 0;
  }

  reseed(seed: GeneratorSeed, field: FlowField): void {
    this.field = field;
    this.rng = mulberry32(seed.seed ^ 0x6a09e667);
    this.particles.length = 0;
    // Смещение рейтинга на трек: одинаковое настроение у разных треков даёт
    // разный набор частиц — ровно как у примитивов.
    for (const type of PARTICLE_TYPES) this.bias.set(type, (this.rng() * 2 - 1) * 0.22);
  }

  update(mood: MoodVector, scene: SceneState, config: ParticleConfig, dtMs: number): ParticleDebug {
    const dt = Math.min(0.05, dtMs / 1000);
    if (!config.enabled) {
      this.particles.length = 0;
      return { active: [], count: 0 };
    }

    this.updateWeights(mood, scene, config, dt);

    const velocity = 40 + mood.energy * 260;
    const waves = FlowField.prepareWaves(
      scene.impulses, this.width, this.height, velocity, dt, scene.impact.pressure,
    );

    this.spawn(mood, scene, config, dt);
    this.integrate(mood, scene, waves, dt);

    const active: ParticleType[] = [];
    for (const [type, weight] of this.weights) if (weight > 0.05) active.push(type);
    return { active, count: this.particles.length };
  }

  draw(ctx: CanvasRenderingContext2D, palette: Palette, scene: SceneState, weight: number): void {
    if (this.particles.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (const particle of this.particles) {
      const life = particle.life / particle.maxLife;
      switch (particle.type) {
        case 'sparks': this.drawSpark(ctx, palette, particle, life, weight); break;
        case 'ribbons': this.drawRibbon(ctx, palette, particle, life, weight); break;
        case 'shards': this.drawShard(ctx, palette, particle, life, weight); break;
        case 'bokeh': this.drawBokeh(ctx, palette, particle, life, weight); break;
        case 'streaks': this.drawStreak(ctx, palette, particle, life, weight); break;
        case 'petals': this.drawPetal(ctx, palette, particle, life, weight); break;
        case 'dust': this.drawDust(ctx, palette, particle, life, weight, scene); break;
        case 'embers': this.drawEmber(ctx, palette, particle, life, weight); break;
        case 'swarm': this.drawSwarmMember(ctx, palette, particle, life, weight); break;
      }
    }
    ctx.restore();
  }

  /**
   * Рейтинг уместности по типам. Формулы — прямо из назначения каждого типа:
   * искры на резких атаках, взвесь в тишине, ленты на плавной мелодии и так далее.
   */
  private updateWeights(mood: MoodVector, scene: SceneState, config: ParticleConfig, dt: number): void {
    const k = 1 - Math.exp(-dt * 1.1);

    if (config.mode === 'manual') {
      for (const type of PARTICLE_TYPES) {
        const target = config.manual.includes(type) ? 1 : 0;
        this.weights.set(type, lerp(this.weights.get(type) ?? 0, target, k));
      }
      return;
    }

    const major = mood.key.mode === 'major' ? 1 : 0;
    const scored = PARTICLE_TYPES.map((type) => ({
      type,
      score: clamp01(this.affinity(type, mood, scene, major) + (this.bias.get(type) ?? 0)
        + ((this.weights.get(type) ?? 0) > 0.15 ? 0.07 : 0)),
    })).sort((a, b) => b.score - a.score);

    const winners = new Set(scored.slice(0, AMBIENT_TYPES).map((entry) => entry.type));
    // Лучший ударный тип — вдобавок к постоянному: он спавнится только на
    // импульсе, поэтому не считается вторым «активным» типом в кадре.
    const burst = scored.find((entry) => BURST_TYPES.has(entry.type));
    if (burst) winners.add(burst.type);
    for (const entry of scored) {
      const target = winners.has(entry.type) ? Math.max(0.25, entry.score) : 0;
      this.weights.set(entry.type, lerp(this.weights.get(entry.type) ?? 0, target, k));
    }
  }

  private affinity(type: ParticleType, mood: MoodVector, scene: SceneState, major: number): number {
    const calm = mood.section === 'calm' ? 1 : 0;
    const drop = mood.section === 'drop' ? 1 : 0;
    switch (type) {
      case 'sparks':
        // Резкие атаки и шумность: искры — это транзиент, а не фон.
        return 0.15 + mood.noisiness * 0.5 + scene.impulseEnergy * 0.4;
      case 'dust':
        return 0.2 + calm * 0.6 - mood.energy * 0.45;
      case 'ribbons':
        // Плавно и мелодично: мало шума, уверенная тональность.
        return 0.25 + (1 - mood.noisiness) * 0.4 + mood.key.confidence * 0.25 - drop * 0.2;
      case 'shards':
        return 0.05 + mood.noisiness * 0.7 + mood.energy * 0.2;
      case 'bokeh':
        return 0.1 + major * 0.35 + calm * 0.3 - mood.noisiness * 0.3;
      case 'swarm':
        // Ритмичное и средней энергии: стае нужен внятный пульс.
        return 0.1 + mood.beatConfidence * 0.4 + (1 - Math.abs(mood.energy - 0.55) * 2) * 0.35;
      case 'embers':
        return 0.1 + (1 - major) * 0.35 + (1 - mood.brightness) * 0.4 - mood.energy * 0.15;
      case 'streaks':
        return 0.05 + mood.bands.high * 0.75;
      case 'petals':
        return 0.05 + major * 0.35 + smoothstep(0.5, 0.9, mood.energy) * 0.4;
    }
  }

  /** Спавн по весам. Часть типов рождается только от ударов, часть — постоянно. */
  private spawn(mood: MoodVector, scene: SceneState, config: ParticleConfig, dt: number): void {
    const budget = MAX_PARTICLES - this.particles.length;
    if (budget <= 0) return;

    const density = clamp01(config.density) * (0.35 + mood.energy * 0.85);
    const freshImpulse = scene.impulses.find((impulse) => impulse.age < dt * 1.5) ?? null;

    for (const type of PARTICLE_TYPES) {
      const weight = this.weights.get(type) ?? 0;
      if (weight < 0.05) continue;

      const rate = BURST_TYPES.has(type)
        // Ударные типы рождаются пачкой в момент удара, а не струйкой.
        ? (freshImpulse ? weight * density * 260 * freshImpulse.strength : 0)
        : weight * density * SPAWN_RATE[type] * dt;

      const debt = (this.spawnDebt.get(type) ?? 0) + rate;
      const whole = Math.floor(debt);
      this.spawnDebt.set(type, debt - whole);

      const amount = Math.min(whole, MAX_PARTICLES - this.particles.length);
      for (let i = 0; i < amount; i++) {
        this.particles.push(this.create(type, mood, freshImpulse, config));
      }
    }
  }

  private create(
    type: ParticleType,
    mood: MoodVector,
    impulse: Impulse | null,
    config: ParticleConfig,
  ): Particle {
    const rng = this.rng;
    const minSide = Math.min(this.width, this.height);
    // Ударные типы стартуют из точки удара, фоновые — где угодно.
    const fromImpulse = impulse !== null && BURST_TYPES.has(type);
    const x = fromImpulse ? impulse!.x * this.width : rng() * this.width;
    const y = fromImpulse ? impulse!.y * this.height : rng() * this.height;

    const base: Particle = {
      type, x, y, vx: 0, vy: 0,
      life: 1, maxLife: 1,
      size: 1,
      tone: rng(),
      angle: rng() * Math.PI * 2,
      spin: 0,
      trail: null,
      trailLength: 0,
    };

    const power = impulse?.strength ?? 0.5;
    switch (type) {
      case 'sparks': {
        const angle = rng() * Math.PI * 2;
        const speed = minSide * (0.35 + power * 1.1) * (0.3 + rng());
        base.vx = Math.cos(angle) * speed;
        base.vy = Math.sin(angle) * speed;
        base.maxLife = 0.22 + rng() * 0.35;
        base.size = 1 + rng() * 2;
        break;
      }
      case 'shards': {
        const angle = rng() * Math.PI * 2;
        const speed = minSide * (0.25 + power * 0.8) * (0.3 + rng());
        base.vx = Math.cos(angle) * speed;
        base.vy = Math.sin(angle) * speed;
        base.maxLife = 0.5 + rng() * 0.8;
        base.size = minSide * (0.006 + rng() * 0.016);
        base.spin = (rng() * 2 - 1) * 9;
        break;
      }
      case 'dust':
        base.maxLife = 5 + rng() * 7;
        base.size = 0.7 + rng() * 1.6;
        base.vx = (rng() * 2 - 1) * 6;
        base.vy = (rng() * 2 - 1) * 6;
        break;
      case 'ribbons':
        base.maxLife = 2.5 + rng() * 3;
        base.size = 1 + rng() * 2.5;
        base.trail = new Float32Array(RIBBON_TRAIL * 2);
        base.trailLength = 0;
        break;
      case 'bokeh':
        base.maxLife = 3.5 + rng() * 4;
        base.size = minSide * (0.012 + rng() * 0.05);
        base.vx = (rng() * 2 - 1) * 10;
        base.vy = (rng() * 2 - 1) * 10;
        break;
      case 'swarm': {
        const angle = rng() * Math.PI * 2;
        const speed = minSide * 0.12;
        base.vx = Math.cos(angle) * speed;
        base.vy = Math.sin(angle) * speed;
        base.maxLife = 4 + rng() * 5;
        base.size = 1.2 + rng() * 1.8;
        break;
      }
      case 'embers':
        base.y = this.height * (0.75 + rng() * 0.3);
        base.maxLife = 2.5 + rng() * 3;
        base.size = 1.2 + rng() * 2.4;
        base.vy = -minSide * (0.02 + rng() * 0.05);
        base.vx = (rng() * 2 - 1) * 8;
        break;
      case 'streaks':
        base.y = -rng() * this.height * 0.4;
        base.maxLife = 1.2 + rng() * 1.2;
        base.size = 0.8 + rng() * 1.4;
        base.vy = minSide * (0.8 + rng() * 0.9);
        break;
      case 'petals':
        base.y = -rng() * this.height * 0.3;
        base.maxLife = 4 + rng() * 4;
        base.size = minSide * (0.005 + rng() * 0.012);
        base.vy = minSide * (0.05 + rng() * 0.07);
        base.spin = (rng() * 2 - 1) * 2.4;
        break;
    }
    // Ручки панели домножают уже собранные значения типа: каждый тип
    // сохраняет свой характер, меняется только общий масштаб.
    base.maxLife *= Math.max(0.05, config.life);
    base.size *= Math.max(0.05, config.size);
    base.vx *= config.speed;
    base.vy *= config.speed;
    base.life = base.maxLife;
    if (mood.section === 'drop') base.maxLife *= 0.8; // на дропе всё живёт короче
    return base;
  }

  private integrate(mood: MoodVector, scene: SceneState, waves: readonly Wave[], dt: number): void {
    const seconds = mood.timeMs / 1000;
    const minSide = Math.min(this.width, this.height);
    const turbulence = 1 + scene.substance.axis * 2;
    const flowStrength = 20 + mood.energy * 130;
    const swarm = this.swarmCentre();

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];

      // Общее поле: его влияние у каждого типа своё, но поле одно на всех.
      const angle = this.field.angleAt(
        particle.x, particle.y, seconds, 0.4, 0.55, turbulence,
      );
      const follow = FLOW_FOLLOW[particle.type] * flowStrength;
      particle.vx += Math.cos(angle) * follow * dt;
      particle.vy += Math.sin(angle) * follow * dt;

      this.applyBehaviour(particle, mood, swarm, minSide, dt);

      FlowField.pushAt(waves, particle.x, particle.y, this.push);
      particle.x += particle.vx * dt + this.push.x;
      particle.y += particle.vy * dt + this.push.y;
      particle.vx *= DRAG[particle.type];
      particle.vy *= DRAG[particle.type];
      particle.angle += particle.spin * dt;
      particle.life -= dt;

      if (particle.trail) this.pushTrail(particle);

      const outside = particle.x < -80 || particle.x > this.width + 80
        || particle.y < -120 || particle.y > this.height + 120;
      if (particle.life <= 0 || outside) this.particles.splice(i, 1);
    }
  }

  /** Поведение, специфичное для типа: гравитация, всплытие, стая, качание. */
  private applyBehaviour(
    particle: Particle,
    mood: MoodVector,
    swarm: { x: number; y: number; vx: number; vy: number; count: number },
    minSide: number,
    dt: number,
  ): void {
    switch (particle.type) {
      case 'sparks':
        particle.vy += minSide * 1.1 * dt; // искры падают
        break;
      case 'shards':
        particle.vy += minSide * 0.5 * dt;
        break;
      case 'embers':
        // Угли всплывают и дрожат: тепловой поток, а не прямая линия.
        particle.vy -= minSide * 0.08 * dt;
        particle.vx += Math.sin(particle.angle * 3 + particle.life * 4) * minSide * 0.05 * dt;
        break;
      case 'petals':
        // Лепесток качается, поворачиваясь вокруг собственной оси.
        particle.vx += Math.sin(particle.life * 1.6 + particle.tone * 6) * minSide * 0.12 * dt;
        particle.vy += minSide * 0.04 * dt;
        break;
      case 'streaks':
        particle.vy += minSide * 0.6 * dt;
        break;
      case 'swarm': {
        if (swarm.count < 2) break;
        // Boids в упрощённом виде: сплочённость к центру стаи и выравнивание
        // по её средней скорости. Разделение даёт сама турбулентность поля.
        const toCentreX = swarm.x - particle.x;
        const toCentreY = swarm.y - particle.y;
        const distance = Math.hypot(toCentreX, toCentreY) || 1;
        const cohesion = mood.beatConfidence * 0.9 + 0.2;
        particle.vx += (toCentreX / distance) * minSide * 0.25 * cohesion * dt;
        particle.vy += (toCentreY / distance) * minSide * 0.25 * cohesion * dt;
        particle.vx += (swarm.vx - particle.vx) * 0.6 * dt;
        particle.vy += (swarm.vy - particle.vy) * 0.6 * dt;
        // На удар стая рассыпается.
        if (distance < minSide * 0.08) {
          particle.vx -= (toCentreX / distance) * minSide * 0.35 * dt;
          particle.vy -= (toCentreY / distance) * minSide * 0.35 * dt;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Центр и средняя скорость стаи — считаются один раз на кадр. */
  private swarmCentre(): { x: number; y: number; vx: number; vy: number; count: number } {
    let x = 0;
    let y = 0;
    let vx = 0;
    let vy = 0;
    let count = 0;
    for (const particle of this.particles) {
      if (particle.type !== 'swarm') continue;
      x += particle.x;
      y += particle.y;
      vx += particle.vx;
      vy += particle.vy;
      count++;
    }
    if (count === 0) return { x: 0, y: 0, vx: 0, vy: 0, count: 0 };
    return { x: x / count, y: y / count, vx: vx / count, vy: vy / count, count };
  }

  private pushTrail(particle: Particle): void {
    const trail = particle.trail!;
    // Сдвигаем историю на одну позицию и дописываем текущую в начало.
    for (let i = Math.min(particle.trailLength, RIBBON_TRAIL - 1); i > 0; i--) {
      trail[i * 2] = trail[(i - 1) * 2];
      trail[i * 2 + 1] = trail[(i - 1) * 2 + 1];
    }
    trail[0] = particle.x;
    trail[1] = particle.y;
    particle.trailLength = Math.min(RIBBON_TRAIL, particle.trailLength + 1);
  }

  // ------------------------------------------------------------- отрисовка

  private drawSpark(ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number): void {
    // Искра — короткий след вдоль скорости, а не точка.
    ctx.strokeStyle = palette.accentAlpha(0.9, life * w);
    ctx.lineWidth = p.size * life;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
    ctx.stroke();
  }

  private drawDust(
    ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number, scene: SceneState,
  ): void {
    // Взвесь видно только когда она между зрителем и источником света.
    const toLight = 1 - Math.hypot(p.x / this.width - scene.light.x, p.y / this.height - scene.light.y);
    const fade = Math.sin(life * Math.PI);
    ctx.fillStyle = palette.accentAlpha(0.3, fade * clamp01(toLight) * 0.5 * w);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawRibbon(ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number): void {
    if (!p.trail || p.trailLength < 2) return;
    ctx.strokeStyle = palette.accentAlpha(p.tone, Math.sin(life * Math.PI) * 0.6 * w);
    ctx.lineWidth = p.size;
    ctx.beginPath();
    ctx.moveTo(p.trail[0], p.trail[1]);
    for (let i = 1; i < p.trailLength; i++) ctx.lineTo(p.trail[i * 2], p.trail[i * 2 + 1]);
    ctx.stroke();
  }

  private drawShard(ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number): void {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.fillStyle = palette.accentAlpha(p.tone, life * 0.75 * w);
    ctx.beginPath();
    // Неправильный треугольник: осколок не должен читаться как аккуратная фигура.
    ctx.moveTo(-p.size, -p.size * 0.6);
    ctx.lineTo(p.size * 1.1, -p.size * 0.2);
    ctx.lineTo(-p.size * 0.3, p.size);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawBokeh(ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number): void {
    const fade = Math.sin(life * Math.PI);
    const gradient = ctx.createRadialGradient(p.x, p.y, p.size * 0.25, p.x, p.y, p.size);
    // Яркая кайма и провал в центре — так выглядит расфокусированный кружок.
    gradient.addColorStop(0, palette.accentAlpha(p.tone, fade * 0.16 * w));
    gradient.addColorStop(0.75, palette.accentAlpha(p.tone, fade * 0.3 * w));
    gradient.addColorStop(1, palette.accentAlpha(p.tone, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawSwarmMember(ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number): void {
    ctx.fillStyle = palette.accentAlpha(0.55, Math.sin(life * Math.PI) * 0.7 * w);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawEmber(ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number): void {
    // Уголёк мерцает: яркость дышит по собственной фазе.
    const flicker = 0.6 + Math.sin(p.life * 9 + p.tone * 12) * 0.4;
    ctx.fillStyle = palette.accentAlpha(0.08, life * flicker * 0.8 * w);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.6 + life * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }

  private drawStreak(ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number): void {
    ctx.strokeStyle = palette.accentAlpha(0.75, life * 0.5 * w);
    ctx.lineWidth = p.size;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x, p.y - Math.min(140, Math.abs(p.vy) * 0.08));
    ctx.stroke();
  }

  private drawPetal(ctx: CanvasRenderingContext2D, palette: Palette, p: Particle, life: number, w: number): void {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.fillStyle = palette.accentAlpha(p.tone * 0.3 + 0.6, Math.sin(life * Math.PI) * 0.6 * w);
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size, p.size * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Типы, которые рождаются от удара, а не постоянным потоком. */
const BURST_TYPES = new Set<ParticleType>(['sparks', 'shards']);

/** Сколько частиц в секунду рождает тип при полном весе и полной плотности. */
const SPAWN_RATE: Record<ParticleType, number> = {
  sparks: 0, dust: 55, ribbons: 14, shards: 0, bokeh: 12,
  swarm: 40, embers: 30, streaks: 90, petals: 22,
};

/** Насколько тип слушается общего поля потока. */
const FLOW_FOLLOW: Record<ParticleType, number> = {
  sparks: 0.25, dust: 1, ribbons: 1.4, shards: 0.2, bokeh: 0.5,
  swarm: 0.6, embers: 0.7, streaks: 0.15, petals: 0.8,
};

/** Торможение за кадр: тяжёлые типы теряют скорость медленнее. */
const DRAG: Record<ParticleType, number> = {
  sparks: 0.94, dust: 0.97, ribbons: 0.92, shards: 0.97, bokeh: 0.98,
  swarm: 0.95, embers: 0.96, streaks: 0.995, petals: 0.96,
};
