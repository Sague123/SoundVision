/**
 * Транзиентный слой — рисуемая часть импульса: частицы, кольца, вспышка.
 *
 * Слой ничего не решает сам: он реагирует на импульсы, рождённые сценой,
 * поэтому всплеск приходит в ту же точку экрана, что и остальная реакция,
 * а эхо памяти повторяет его через половину и четверть такта.
 *
 * Искажения пространства (разлёт каналов, сдвиг блоков, бочка, волны) сюда
 * не входят: они живут в UV-координатах и делаются одним проходом варпа на
 * GPU. Тряска — тоже не здесь: это движение камеры.
 *
 * Сами частицы живут в общей системе (particles.ts) и несутся общим полем
 * потока — слой только даёт им холст и передаёт удары.
 *
 * Про безопасность: частота полноэкранных вспышек жёстко ограничена
 * (settings.transients.maxFlashHz, потолок — 3 Гц) из-за фотосенситивной эпилепсии.
 */

import { clamp01 } from '../audio/features.ts';
import type { MoodVector } from '../audio/mood-vector.ts';
import type { Settings } from '../settings.ts';
import type { Palette } from './palette.ts';
import type { FlowField } from './flow-field.ts';
import { ParticleSystem, type ParticleConfig, type ParticleDebug } from './particles.ts';
import type { Impulse, SceneState } from './scene.ts';
import type { GeneratorSeed } from './seed.ts';

const MAX_RINGS = 8;

interface Ring {
  x: number;
  y: number;
  radius: number;
  speed: number;
  life: number;
  maxLife: number;
  tone: number;
  /** Кольцо от эха красится комплементарным цветом — это цветовое эхо из §2.4. */
  echo: boolean;
}

export interface TransientDebug {
  particles: number;
  rings: number;
  flash: number;
  /** Какие типы частиц сейчас активны. */
  particleTypes: string[];
}

export class TransientLayer {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;

  private readonly particles: ParticleSystem;
  private readonly rings: Ring[] = [];
  private particleDebug: ParticleDebug = { active: [], count: 0 };
  private flash = 0;
  private flashTone = 0;
  private lastFlashMs = -Infinity;
  /** Номер последнего отработанного импульса: на каждый реагируем ровно раз. */
  private lastImpulseId = 0;

  constructor(field: FlowField) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D-контекст недоступен');
    this.ctx = ctx;
    this.particles = new ParticleSystem(field);
  }

  reseed(seed: GeneratorSeed, field: FlowField): void {
    this.particles.reseed(seed, field);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.particles.resize(width, height);
  }

  update(mood: MoodVector, settings: Settings, scene: SceneState, particles: ParticleConfig): void {
    const t = settings.transients;
    const intensity = t.intensity;
    const dt = Math.min(0.05, mood.deltaMs / 1000);

    // Реакция на импульсы сцены, а не на onset напрямую: так эхо памяти
    // порождает точно такой же всплеск, как исходный удар.
    let strongest = 0;
    for (const impulse of scene.impulses) {
      if (impulse.id <= this.lastImpulseId) continue;
      this.lastImpulseId = impulse.id;
      strongest = Math.max(strongest, impulse.strength);

      // Кольцо рисуется на тех же ударах, на которых сцена запускает волну.
      if ((t.shockwave || t.ripple) && impulse.strength > 0.3) this.spawnRing(impulse, intensity);
    }

    // Вспышка — единственный эффект с жёстким лимитом частоты. Саму вспышку
    // копит свет сцены, здесь только решается, пропустить ли её на экран.
    const flashInterval = t.maxFlashHz > 0 ? 1000 / t.maxFlashHz : Infinity;
    if (t.strobe && intensity > 0 && strongest > 0.55 &&
        mood.timeMs - this.lastFlashMs >= flashInterval) {
      this.lastFlashMs = mood.timeMs;
      this.flash = Math.min(0.5, scene.light.flash * 0.5) * intensity;
      this.flashTone = mood.beatPhase;
    }

    this.integrate(dt);
    // Частицы обновляются всегда: они фон сцены, а не реакция на конкретный удар.
    this.particleDebug = this.particles.update(mood, scene, particles, mood.deltaMs);
  }

  render(palette: Palette, scene: SceneState, weight: number): TransientDebug {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';

    // Призраки прошлых ударов: тусклые пятна, которые гаснут секундами.
    // Рисуются первыми, чтобы свежие частицы ложились поверх них.
    for (const ghost of scene.memory.ghosts) {
      const life = 1 - ghost.age / ghost.life;
      const radius = Math.min(this.width, this.height) * (0.04 + ghost.strength * 0.1) * (2 - life);
      const x = ghost.x * this.width;
      const y = ghost.y * this.height;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, palette.accentAlpha(ghost.strength, life * life * 0.35 * weight));
      gradient.addColorStop(1, palette.accentAlpha(ghost.strength, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const ring of this.rings) {
      const life = ring.life / ring.maxLife;
      // Фронт волны от эха уходит в комплементарный цвет и гаснет.
      ctx.strokeStyle = ring.echo
        ? palette.echo(1 - life, life * 0.8 * weight)
        : palette.accentAlpha(ring.tone, life * 0.75 * weight);
      ctx.lineWidth = Math.max(0.6, life * 9);
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.flash > 0.001) {
      // Вспышка светится цветом сцены: тёплым в мажоре, холодным в миноре.
      ctx.fillStyle = palette.accentAlpha(this.flashTone + scene.light.warmth * 0.2, this.flash * weight);
      ctx.fillRect(0, 0, this.width, this.height);
    }

    this.particles.draw(ctx, palette, scene, weight);

    return {
      particles: this.particleDebug.count,
      rings: this.rings.length,
      flash: this.flash,
      particleTypes: this.particleDebug.active,
    };
  }

  private integrate(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.radius += ring.speed * dt;
      ring.life -= dt;
      if (ring.life <= 0) this.rings.splice(i, 1);
    }

    this.flash = Math.max(0, this.flash - dt * 3.4);
  }

  private spawnRing(impulse: Impulse, intensity: number): void {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    const power = impulse.strength * intensity;
    const maxLife = 0.5 + power * 0.5;
    this.rings.push({
      x: impulse.x * this.width,
      y: impulse.y * this.height,
      radius: Math.min(this.width, this.height) * 0.04,
      speed: Math.max(this.width, this.height) * (0.5 + power * 1.1),
      life: maxLife,
      maxLife,
      tone: clamp01(power),
      echo: impulse.echo,
    });
  }

}
