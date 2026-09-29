/**
 * Задник: то, что всегда заполняет кадр позади эффектов.
 *
 * Эффект на чёрном выглядит как демо эффекта, а не как шоу: вокруг героя
 * пусто, и музыка не «живёт» во всём кадре. Задник закрывает кадр целиком,
 * но тихо — он темнее героя и никогда не спорит с ним за внимание.
 *
 * Три стиля, их выбирает сцена:
 *  - `cover` — сама обложка трека, сильно размытая и затемнённая, медленно
 *    плывёт. Трек узнаётся по цвету кадра ещё до названия. Нет обложки —
 *    вместо неё аврора.
 *  - `aurora` — несколько огромных мягких пятен цветов палитры; каждое
 *    ведёт своя полоса частот: бас — нижнее, середина и верх — остальные.
 *  - `horizon` — небо с солнцем у линии горизонта для трёхмерных сцен.
 *
 * Всё дышит в долю такта: вспышка на сильную долю по найденному темпу, а не
 * только на детектированный удар. Удар без темпа тоже подсвечивает, но темп
 * даёт то, чего не даёт детектор, — ровную пульсацию, в которую попадает
 * вся картинка.
 *
 * Стили не щёлкают: у каждого свой вес, веса едут к цели за пару секунд.
 */

import type { MoodVector } from '../audio/mood-vector.ts';
import type { Palette } from './palette.ts';

export type BackdropStyle = 'cover' | 'aurora' | 'horizon';
export const BACKDROP_STYLES: readonly BackdropStyle[] = ['cover', 'aurora', 'horizon'];

/** Высота горизонта в долях кадра — там же, где его держат 3D-сцены. */
export const BACKDROP_HORIZON = 0.4;

/** Размер предразмытой обложки: размытие считается один раз на трек. */
const BLURRED_SIZE = 256;

interface Blob {
  /** Фазы и скорости медленного дрейфа по фигуре Лиссажу. */
  px: number;
  py: number;
  sx: number;
  sy: number;
  tone: number;
}

const BLOBS: readonly Blob[] = [
  { px: 0.1, py: 1.3, sx: 0.031, sy: 0.023, tone: 0.1 },
  { px: 2.1, py: 0.4, sx: 0.027, sy: 0.037, tone: 0.4 },
  { px: 4.0, py: 2.6, sx: 0.041, sy: 0.029, tone: 0.7 },
  { px: 5.2, py: 4.1, sx: 0.022, sy: 0.034, tone: 0.95 },
];

export class Backdrop {
  private readonly blurred = document.createElement('canvas');
  private readonly blurredCtx: CanvasRenderingContext2D | null;
  private coverSource: HTMLImageElement | null = null;
  private hasCover = false;
  private readonly weights: Record<BackdropStyle, number> = { cover: 0, aurora: 1, horizon: 0 };
  private pulse = 0;
  private bass = 0;
  private mid = 0;
  private high = 0;
  private lastBeatPhase = 0;

  constructor() {
    this.blurred.width = BLURRED_SIZE;
    this.blurred.height = BLURRED_SIZE;
    this.blurredCtx = this.blurred.getContext('2d');
  }

  /** Обложку размываем один раз: фильтр на каждом кадре слабому ПК не по силам. */
  setCover(image: HTMLImageElement | null): void {
    if (image === this.coverSource) return;
    this.coverSource = image;
    this.hasCover = false;
    const ctx = this.blurredCtx;
    if (!image || !ctx || !image.naturalWidth) return;
    ctx.save();
    ctx.clearRect(0, 0, BLURRED_SIZE, BLURRED_SIZE);
    ctx.filter = 'blur(14px) saturate(1.4) brightness(0.8)';
    // С запасом по краям: размытие иначе затягивает края в прозрачность.
    const pad = BLURRED_SIZE * 0.12;
    ctx.drawImage(image, -pad, -pad, BLURRED_SIZE + pad * 2, BLURRED_SIZE + pad * 2);
    ctx.restore();
    this.hasCover = true;
  }

  /**
   * @param style стиль, который просит сцена
   * @param level общая яркость задника 0..1 — от состояния музыки
   */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    mood: MoodVector,
    palette: Palette,
    style: BackdropStyle,
    level: number,
  ): void {
    const dt = Math.min(0.1, mood.deltaMs / 1000);
    const target: BackdropStyle = style === 'cover' && !this.hasCover ? 'aurora' : style;
    const k = 1 - Math.exp(-dt / 1.2);
    for (const s of BACKDROP_STYLES) this.weights[s] += ((s === target ? 1 : 0) - this.weights[s]) * k;

    this.updatePulse(mood, dt);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.bgBottom;
    ctx.fillRect(0, 0, width, height);

    const lit = Math.max(0, Math.min(1, level)) * (0.75 + this.pulse * 0.45);
    if (this.weights.cover > 0.01) this.drawCover(ctx, width, height, mood, lit * this.weights.cover);
    if (this.weights.aurora > 0.01) this.drawAurora(ctx, width, height, mood, palette, lit * this.weights.aurora);
    if (this.weights.horizon > 0.01) this.drawHorizon(ctx, width, height, palette, lit * this.weights.horizon);
    this.drawShade(ctx, width, height);
    ctx.restore();
  }

  /**
   * Пульс: сильная доля по темпу (если темп уверенный) и детектированный
   * удар. Атака мгновенная, спад — за долю такта.
   */
  private updatePulse(mood: MoodVector, dt: number): void {
    const beat = mood.beatPhase < this.lastBeatPhase - 0.5 ? 1 : 0;
    this.lastBeatPhase = mood.beatPhase;
    const onBeat = beat * Math.max(0, Math.min(1, mood.beatConfidence)) * (0.5 + mood.energy * 0.5);
    const onset = mood.onset ? mood.onsetStrength * 0.8 : 0;
    const hit = Math.max(onBeat, onset);
    this.pulse = hit > this.pulse ? hit : this.pulse * Math.exp(-dt / 0.22);
    const follow = (current: number, next: number): number =>
      current + (next - current) * (next > current ? 0.35 : 1 - Math.exp(-dt / 0.35));
    this.bass = follow(this.bass, mood.bands.low);
    this.mid = follow(this.mid, mood.bands.mid);
    this.high = follow(this.high, mood.bands.high);
  }

  private drawCover(ctx: CanvasRenderingContext2D, width: number, height: number, mood: MoodVector, alpha: number): void {
    const t = mood.timeMs / 1000;
    // Медленный наезд и дрейф — «камера» задника; пульс чуть толкает масштаб.
    const scale = Math.max(width, height) / BLURRED_SIZE * (1.18 + Math.sin(t * 0.05) * 0.05 + this.pulse * 0.025);
    const w = BLURRED_SIZE * scale;
    const x = (width - w) / 2 + Math.sin(t * 0.037) * width * 0.03;
    const y = (height - w) / 2 + Math.cos(t * 0.029) * height * 0.03;
    // Задник обязан быть темнее героя: светлая обложка иначе заливает кадр
    // молочной пеленой, и линии на ней теряются.
    ctx.globalAlpha = Math.min(1, alpha * 0.4);
    ctx.drawImage(this.blurred, x, y, w, w);
    ctx.globalAlpha = 1;
  }

  private drawAurora(ctx: CanvasRenderingContext2D, width: number, height: number, mood: MoodVector,
    palette: Palette, alpha: number): void {
    const t = mood.timeMs / 1000;
    const minSide = Math.min(width, height);
    const bands = [this.bass, this.mid, this.high, (this.bass + this.high) * 0.5];
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < BLOBS.length; i++) {
      const b = BLOBS[i];
      // Басовое пятно держится внизу — «пол» звука; остальные гуляют выше.
      const cx = width * (0.5 + Math.sin(t * b.sx * 6.28 + b.px) * 0.38);
      const cy = i === 0
        ? height * (0.82 + Math.sin(t * b.sy * 6.28 + b.py) * 0.08)
        : height * (0.42 + Math.sin(t * b.sy * 6.28 + b.py) * 0.3);
      const radius = minSide * (0.55 + bands[i] * 0.35 + (i === 0 ? this.pulse * 0.12 : 0));
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, palette.accentAlpha(b.tone, alpha * (0.2 + bands[i] * 0.22)));
      gradient.addColorStop(1, palette.accentAlpha(b.tone, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawHorizon(ctx: CanvasRenderingContext2D, width: number, height: number, palette: Palette,
    alpha: number): void {
    const horizon = height * BACKDROP_HORIZON;
    // Небо: к горизонту светлеет цветом палитры.
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, palette.accentAlpha(0.8, 0));
    sky.addColorStop(1, palette.accentAlpha(0.75, alpha * 0.35));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, horizon);

    // Солнце за горизонтом: пульсирует басом.
    ctx.globalCompositeOperation = 'lighter';
    const radius = width * (0.28 + this.bass * 0.12 + this.pulse * 0.05);
    const sun = ctx.createRadialGradient(width / 2, horizon, 0, width / 2, horizon, radius);
    sun.addColorStop(0, palette.accentAlpha(0.2, alpha * (0.55 + this.pulse * 0.3)));
    sun.addColorStop(0.35, palette.accentAlpha(0.45, alpha * 0.22));
    sun.addColorStop(1, palette.accentAlpha(0.6, 0));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, horizon + height * 0.02);
    ctx.clip();
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, width, horizon + height * 0.02);
    ctx.restore();
    // Линия горизонта.
    ctx.fillStyle = palette.accentAlpha(0.3, alpha * (0.45 + this.pulse * 0.4));
    ctx.fillRect(0, horizon - 1, width, 2);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Центр чуть светлее краёв: взгляд собирается туда, где герой. */
  private drawShade(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const radius = Math.hypot(width, height) / 2;
    const shade = ctx.createRadialGradient(width / 2, height / 2, radius * 0.25, width / 2, height / 2, radius);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
  }
}
