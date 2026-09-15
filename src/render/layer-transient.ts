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
 * Про безопасность: частота полноэкранных вспышек жёстко ограничена
 * (settings.transients.maxFlashHz, потолок — 3 Гц) из-за фотосенситивной эпилепсии.
 */

import { clamp01 } from '../audio/features.ts';
import type { MoodVector } from '../audio/mood-vector.ts';
import type { Settings } from '../settings.ts';
import type { Palette } from './palette.ts';
import type { Impulse, SceneState } from './scene.ts';

const MAX_PARTICLES = 900;
const MAX_RINGS = 8;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  tone: number;
  size: number;
  echo: boolean;
}

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
}

export class TransientLayer {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;

  private readonly particles: Particle[] = [];
  private readonly rings: Ring[] = [];
  private flash = 0;
  private flashTone = 0;
  private lastFlashMs = -Infinity;
  /** Номер последнего отработанного импульса: на каждый реагируем ровно раз. */
  private lastImpulseId = 0;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D-контекст недоступен');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  update(mood: MoodVector, settings: Settings, scene: SceneState): void {
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

      if (t.burst) this.spawnBurst(impulse, intensity);
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
  }

  render(palette: Palette, scene: SceneState, weight: number): TransientDebug {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';

    for (const particle of this.particles) {
      const life = particle.life / particle.maxLife;
      ctx.fillStyle = particle.echo
        ? palette.echo(1 - life, life * life * weight)
        : palette.accentAlpha(particle.tone, life * life * weight);
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (0.4 + life * 0.8), 0, Math.PI * 2);
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

    return {
      particles: this.particles.length,
      rings: this.rings.length,
      flash: this.flash,
    };
  }

  private integrate(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= 0.97;
      particle.vy *= 0.97;
      particle.life -= dt;
      if (particle.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.radius += ring.speed * dt;
      ring.life -= dt;
      if (ring.life <= 0) this.rings.splice(i, 1);
    }

    this.flash = Math.max(0, this.flash - dt * 3.4);
  }

  /** Частицы разлетаются из точки удара, а не из случайного места экрана. */
  private spawnBurst(impulse: Impulse, intensity: number): void {
    const power = impulse.strength * intensity;
    const count = Math.min(MAX_PARTICLES - this.particles.length, Math.round(14 + power * 120));
    if (count <= 0) return;

    const cx = impulse.x * this.width;
    const cy = impulse.y * this.height;
    const baseSpeed = Math.min(this.width, this.height) * (0.25 + power * 0.9);

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = baseSpeed * (0.25 + Math.random() * 0.9);
      const maxLife = 0.35 + Math.random() * (0.5 + power * 0.6);
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: maxLife,
        maxLife,
        tone: (impulse.x + Math.random() * 0.4) % 1,
        size: 1 + Math.random() * (1.5 + power * 3),
        echo: impulse.echo,
      });
    }
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
