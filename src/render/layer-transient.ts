/**
 * Транзиентный слой: короткие модификаторы поверх базы и жанра.
 * Ничего не «помнит» дольше пары сотен миллисекунд — это реакция на удар.
 *
 * Про безопасность: частота полноэкранных вспышек жёстко ограничена
 * (settings.transients.maxFlashHz, потолок — 3 Гц) из-за фотосенситивной эпилепсии.
 */

import { clamp01 } from '../audio/features.ts';
import type { MoodVector } from '../audio/mood-vector.ts';
import type { Settings } from '../settings.ts';
import type { Palette } from './palette.ts';

const MAX_PARTICLES = 900;
const MAX_RINGS = 8;
const GLITCH_MIN_INTERVAL_MS = 420;
const GLITCH_DURATION_MS = 160;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  tone: number;
  size: number;
}

interface Ring {
  x: number;
  y: number;
  radius: number;
  speed: number;
  life: number;
  maxLife: number;
  tone: number;
}

export interface TransientDebug {
  particles: number;
  rings: number;
  glitch: boolean;
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
  private shakeX = 0;
  private shakeY = 0;
  private shakeEnergy = 0;
  private glitchUntilMs = 0;
  private lastGlitchMs = -Infinity;
  private prevFlux = 0;
  private prevSection: MoodVector['section'] = 'calm';

  private scratch: HTMLCanvasElement | null = null;
  private channel: HTMLCanvasElement | null = null;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D-контекст недоступен');
    this.ctx = ctx;
  }

  get shake(): { x: number; y: number } {
    return { x: this.shakeX, y: this.shakeY };
  }

  get glitchActive(): boolean {
    return this.glitchUntilMs > 0;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.scratch = null;
    this.channel = null;
  }

  update(mood: MoodVector, settings: Settings): void {
    const t = settings.transients;
    const intensity = t.intensity;
    const dt = Math.min(0.05, mood.deltaMs / 1000);

    if (mood.onset && mood.onsetStrength > 0.08) {
      const power = mood.onsetStrength * intensity;
      if (t.burst) this.spawnBurst(power, mood);
      if (t.shockwave && mood.onsetStrength > 0.35) this.spawnRing(power, mood);
      if (t.shake) this.shakeEnergy = Math.min(1, this.shakeEnergy + power * 0.8);
    }

    // Резкий скачок flux — характерный признак глитча/дропа в самом материале.
    const fluxJump = mood.flux - this.prevFlux;
    this.prevFlux = mood.flux;
    if (t.glitch && fluxJump > 0.22 * (1.2 - intensity) &&
        mood.timeMs - this.lastGlitchMs > GLITCH_MIN_INTERVAL_MS) {
      this.lastGlitchMs = mood.timeMs;
      this.glitchUntilMs = mood.timeMs + GLITCH_DURATION_MS * (0.6 + intensity * 0.7);
    }
    if (this.glitchUntilMs > 0 && mood.timeMs > this.glitchUntilMs) this.glitchUntilMs = 0;

    const sectionChanged = mood.section !== this.prevSection;
    this.prevSection = mood.section;
    if (sectionChanged && mood.section === 'drop') {
      if (t.shockwave) this.spawnRing(intensity, mood);
      if (t.shake) this.shakeEnergy = Math.min(1, this.shakeEnergy + intensity);
    }

    // Вспышка — единственный эффект с жёстким лимитом частоты.
    const flashInterval = t.maxFlashHz > 0 ? 1000 / t.maxFlashHz : Infinity;
    const wantsFlash = t.strobe && intensity > 0 &&
      ((mood.onset && mood.onsetStrength > 0.6) || (sectionChanged && mood.section === 'drop'));
    if (wantsFlash && mood.timeMs - this.lastFlashMs >= flashInterval) {
      this.lastFlashMs = mood.timeMs;
      this.flash = Math.min(0.55, 0.2 + mood.onsetStrength * 0.45) * intensity;
      this.flashTone = mood.beatPhase;
    }

    this.integrate(dt, mood);
  }

  render(palette: Palette, weight: number): TransientDebug {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';

    for (const particle of this.particles) {
      const life = particle.life / particle.maxLife;
      ctx.fillStyle = palette.accentAlpha(particle.tone, life * life * weight);
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (0.4 + life * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }

    for (const ring of this.rings) {
      const life = ring.life / ring.maxLife;
      ctx.strokeStyle = palette.accentAlpha(ring.tone, life * 0.75 * weight);
      ctx.lineWidth = Math.max(0.6, life * 9);
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.flash > 0.001) {
      ctx.fillStyle = palette.accentAlpha(this.flashTone, this.flash * weight);
      ctx.fillRect(0, 0, this.width, this.height);
    }

    return {
      particles: this.particles.length,
      rings: this.rings.length,
      glitch: this.glitchActive,
      flash: this.flash,
    };
  }

  /**
   * Глитч работает уже по сведённому кадру: RGB-сплит плюс сдвиг горизонтальных
   * блоков. Вызывается композитором после сведения слоёв.
   */
  applyGlitch(ctx: CanvasRenderingContext2D, mood: MoodVector, settings: Settings): void {
    if (!this.glitchActive || !settings.transients.glitch) return;

    const scratch = this.ensureCanvas('scratch');
    const channelCanvas = this.ensureCanvas('channel');
    const scratchCtx = scratch.getContext('2d');
    const channelCtx = channelCanvas.getContext('2d');
    if (!scratchCtx || !channelCtx) return;

    const amount = settings.transients.intensity * (0.5 + mood.flux * 0.8);
    const shift = Math.max(2, this.width * 0.012 * amount);

    scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
    scratchCtx.globalCompositeOperation = 'source-over';
    scratchCtx.clearRect(0, 0, this.width, this.height);
    scratchCtx.drawImage(ctx.canvas, 0, 0);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';

    // Каждый канал изолируем умножением на чистый цвет и кладём со своим сдвигом.
    const channels: Array<[string, number, number]> = [
      ['#f00', -shift, 0],
      ['#0f0', 0, 0],
      ['#00f', shift, Math.round(shift * 0.25)],
    ];
    for (const [color, dx, dy] of channels) {
      channelCtx.setTransform(1, 0, 0, 1, 0, 0);
      channelCtx.globalCompositeOperation = 'source-over';
      channelCtx.clearRect(0, 0, this.width, this.height);
      channelCtx.drawImage(scratch, 0, 0);
      channelCtx.globalCompositeOperation = 'multiply';
      channelCtx.fillStyle = color;
      channelCtx.fillRect(0, 0, this.width, this.height);
      ctx.drawImage(channelCanvas, dx, dy);
    }

    // Datamosh: несколько горизонтальных полос уезжают в сторону.
    ctx.globalCompositeOperation = 'source-over';
    const blocks = 2 + Math.floor(amount * 6);
    for (let i = 0; i < blocks; i++) {
      const y = Math.random() * this.height;
      const h = Math.max(4, (this.height / 40) * (0.5 + Math.random() * 2));
      const dx = (Math.random() * 2 - 1) * shift * 4;
      ctx.drawImage(scratch, 0, y, this.width, h, dx, y, this.width, h);
    }
    ctx.restore();
  }

  private integrate(dt: number, mood: MoodVector): void {
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

    this.shakeEnergy = Math.max(0, this.shakeEnergy - dt * 3.2);
    const amplitude = this.shakeEnergy * this.shakeEnergy * Math.min(this.width, this.height) * 0.022;
    // Тряска не должна попадать в такт кадрам — берём случайное направление.
    const angle = Math.random() * Math.PI * 2;
    this.shakeX = Math.cos(angle) * amplitude;
    this.shakeY = Math.sin(angle) * amplitude * (0.6 + mood.energy * 0.6);
  }

  private spawnBurst(power: number, mood: MoodVector): void {
    const count = Math.min(MAX_PARTICLES - this.particles.length, Math.round(20 + power * 130));
    if (count <= 0) return;
    const cx = this.width / 2 + (Math.random() * 2 - 1) * this.width * 0.22;
    const cy = this.height / 2 + (Math.random() * 2 - 1) * this.height * 0.22;
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
        tone: (mood.beatPhase + Math.random() * 0.4) % 1,
        size: 1 + Math.random() * (1.5 + power * 3),
      });
    }
  }

  private spawnRing(power: number, mood: MoodVector): void {
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    const maxLife = 0.5 + power * 0.5;
    this.rings.push({
      x: this.width / 2,
      y: this.height / 2,
      radius: Math.min(this.width, this.height) * 0.04,
      speed: Math.max(this.width, this.height) * (0.5 + power * 1.1),
      life: maxLife,
      maxLife,
      tone: clamp01(mood.energy),
    });
  }

  private ensureCanvas(which: 'scratch' | 'channel'): HTMLCanvasElement {
    const existing = which === 'scratch' ? this.scratch : this.channel;
    if (existing && existing.width === this.width && existing.height === this.height) return existing;
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    if (which === 'scratch') this.scratch = canvas;
    else this.channel = canvas;
    return canvas;
  }
}
