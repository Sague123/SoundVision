import { SimplexNoise } from '../noise.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/** Правила переписывания для 'F'. Разные наборы дают очень разный силуэт. */
const RULES = [
  'FF+[+F-F-F]-[-F+F+F]',
  'F[+F]F[-F][F]',
  'FF-[-F+F+F]+[+F-F-F]',
  'F[+FF][-FF]F[-F][+F]F',
  'F+F-F-FF+F+F-F',
];

const AXIOM = 'F';
const MAX_SEGMENTS = 9000;

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  depth: number;
}

/**
 * Фрактальное ветвление. Строка L-системы переписывается редко (дорого),
 * а живость даёт геометрия: угол, длина и толщина ветвей идут от mood vector.
 */
export class LSystemPrimitive implements DrawPrimitive {
  readonly id = 'l-system' as const;
  readonly kind = 'draw' as const;

  private noise = new SimplexNoise();
  private rule = RULES[0];
  private branches = 3;
  private phase = 0;
  private width = 1;
  private height = 1;
  private readonly cache = new Map<number, string>();
  private segments: Segment[] = [];
  private cachedKey = '';
  private maxDepth = 1;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  reseed(seed: GeneratorSeed): void {
    const rng = mulberry32(seed.seed ^ 0x2545f491);
    this.noise = new SimplexNoise(rng);
    this.rule = RULES[Math.floor(rng() * RULES.length)];
    this.branches = 2 + Math.floor(rng() * 4);
    this.phase = seed.phase['l-system'];
    this.cache.clear();
    this.cachedKey = '';
  }

  dispose(): void {
    this.cache.clear();
    this.segments = [];
  }

  draw(frame: RenderFrame): void {
    const { ctx, params, mood, palette, weight } = frame;
    const depth = Math.max(1, Math.round(frame.tuning.depth * (0.6 + params.density * 0.6)));
    const t = (frame.timeMs / 1000) * (0.05 + params.speed * 0.25) + this.phase;
    // Угол ветвления дышит шумом — дерево «качается», а не стоит колом.
    const angle = (14 + params.chaos * 26 + this.noise.noise2D(t, 4.2) * (4 + mood.flux * 14))
      * frame.tuning.angle * (Math.PI / 180);
    const length = Math.min(this.width, this.height) * (0.028 + params.scale * 0.05)
      * frame.tuning.length;

    const key = `${depth}|${angle.toFixed(3)}|${length.toFixed(2)}|${this.width}x${this.height}`;
    if (key !== this.cachedKey) {
      this.cachedKey = key;
      this.segments = this.buildSegments(depth, angle, length);
      this.maxDepth = this.segments.reduce((max, segment) => Math.max(max, segment.depth), 1);
    }

    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    const rotation = t * 0.12 * (0.3 + params.speed);
    for (let copy = 0; copy < this.branches; copy++) {
      ctx.save();
      ctx.rotate(rotation + (copy / this.branches) * Math.PI * 2);
      // Каждую копию чуть «дышим» на бите — ветви пульсируют вразнобой.
      const pulse = 1 + Math.sin(mood.beatPhase * Math.PI * 2 + copy) * mood.energy * 0.14;
      ctx.scale(pulse, pulse);

      let currentDepth = -1;
      for (const segment of this.segments) {
        if (segment.depth !== currentDepth) {
          if (currentDepth >= 0) ctx.stroke();
          currentDepth = segment.depth;
          const tone = currentDepth / this.maxDepth;
          ctx.strokeStyle = palette.accentAlpha(tone, (0.18 + mood.energy * 0.5) * weight);
          ctx.lineWidth = Math.max(0.5,
            ((1 - tone) * (1.4 + params.sharpness * 3.4) + 0.4) * frame.tuning.lineWidth);
          ctx.beginPath();
        }
        ctx.moveTo(segment.x1, segment.y1);
        ctx.lineTo(segment.x2, segment.y2);
      }
      if (currentDepth >= 0) ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  private expand(depth: number): string {
    const cached = this.cache.get(depth);
    if (cached) return cached;

    let current = AXIOM;
    for (let i = 0; i < depth; i++) {
      let next = '';
      for (const char of current) next += char === 'F' ? this.rule : char;
      current = next;
      if (current.length > MAX_SEGMENTS * 3) break; // страховка от комбинаторного взрыва
    }
    this.cache.set(depth, current);
    return current;
  }

  /**
   * Turtle-обход строки. Сегменты складываем отсортированными по глубине,
   * чтобы рисовать их пачками одного цвета и толщины.
   */
  private buildSegments(depth: number, angle: number, length: number): Segment[] {
    const commands = this.expand(depth);
    const byDepth = new Map<number, Segment[]>();
    let x = 0;
    let y = 0;
    let heading = -Math.PI / 2; // растём вверх
    let level = 0;
    const stack: Array<{ x: number; y: number; heading: number; level: number }> = [];
    let emitted = 0;

    for (const command of commands) {
      if (emitted >= MAX_SEGMENTS) break;
      switch (command) {
        case 'F': {
          // Ветви к вершине короче — иначе фрактал расползается за экран.
          const step = length * Math.pow(0.82, level);
          const nx = x + Math.cos(heading) * step;
          const ny = y + Math.sin(heading) * step;
          const bucket = byDepth.get(level) ?? [];
          bucket.push({ x1: x, y1: y, x2: nx, y2: ny, depth: level });
          byDepth.set(level, bucket);
          x = nx;
          y = ny;
          emitted++;
          break;
        }
        case '+':
          heading += angle;
          break;
        case '-':
          heading -= angle;
          break;
        case '[':
          stack.push({ x, y, heading, level });
          level++;
          break;
        case ']': {
          const saved = stack.pop();
          if (saved) {
            x = saved.x;
            y = saved.y;
            heading = saved.heading;
            level = saved.level;
          }
          break;
        }
        default:
          break;
      }
    }

    const depths = [...byDepth.keys()].sort((a, b) => a - b);
    return depths.flatMap((key) => byDepth.get(key) ?? []);
  }
}
