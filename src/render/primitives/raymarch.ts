import { parseHsl } from '../palette.ts';
import { mulberry32, type GeneratorSeed } from '../seed.ts';
import type { DrawPrimitive, RenderFrame } from './types.ts';

/**
 * Единственный примитив на WebGL: raymarch по SDF. Рисуется в собственный
 * offscreen-канвас и переносится в общий 2D-контекст — так вся композиция
 * остаётся в одном месте, а шейдер не тянет за собой весь рендер.
 */

const VERTEX_SHADER = `#version 300 es
void main() {
  // Полноэкранный треугольник без буфера вершин: три точки по gl_VertexID.
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uEnergy;
uniform float uBrightness;
uniform float uNoisiness;
uniform float uFlux;
uniform float uBeatPhase;
uniform float uDensity;
uniform float uSpeed;
uniform float uScale;
uniform float uSharpness;
uniform float uChaos;
uniform float uWarp;
uniform float uSeed;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;

const int MAX_STEPS = 48;
const float MAX_DIST = 18.0;
const float SURFACE_DIST = 0.0025;

mat2 rot(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdSphere(vec3 p, float r) { return length(p) - r; }

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float map(vec3 p) {
  p.xz *= rot(uTime * 0.12 * (0.3 + uSpeed) + uSeed);
  p.xy *= rot(uTime * 0.07 * (0.3 + uSpeed));

  float breathe = 1.0 + uEnergy * 0.22 + sin(uBeatPhase * 6.2831) * uEnergy * 0.1;
  float radius = mix(0.75, 1.35, uScale) * breathe;

  float sphere = sdSphere(p, radius);
  float torus = sdTorus(p, vec2(radius * 1.05, mix(0.5, 0.12, uSharpness) * radius));
  float box = sdBox(p, vec3(radius * 0.78));

  // Форма непрерывно перетекает между шаром, тором и кубом — никаких переключений.
  float shape = smin(sphere, torus, mix(0.9, 0.12, uSharpness));
  shape = mix(shape, smin(shape, box, 0.5), uBrightness);

  // Складки поверхности: их частота — от density, глубина — от chaos и шумности.
  float ripple = sin(p.x * (3.0 + uDensity * 9.0) + uTime * 1.4)
               * sin(p.y * (3.0 + uDensity * 9.0) - uTime * 1.1)
               * sin(p.z * (3.0 + uDensity * 9.0) + uTime * 0.9);
  shape -= ripple * (0.02 + uChaos * 0.16 + uNoisiness * 0.06);

  // Спутники вокруг основной формы — плотность отвечает за их количество.
  vec3 q = p;
  q.xz *= rot(uTime * 0.4);
  float orbit = sdSphere(vec3(mod(q.x + 2.0, 4.0) - 2.0, q.y, q.z) - vec3(0.0, 0.0, 2.4 + uWarp),
                         0.12 + uDensity * 0.22);
  return smin(shape, orbit, 0.6);
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.0015, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)
  ));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

  // Лёгкий варп экранных координат — «линза», которая дышит вместе с flux.
  uv += 0.06 * uWarp * vec2(sin(uv.y * 6.0 + uTime), cos(uv.x * 6.0 - uTime)) * (0.4 + uFlux);

  vec3 origin = vec3(0.0, 0.0, -4.2);
  vec3 dir = normalize(vec3(uv, 1.4));

  float travelled = 0.0;
  float glow = 0.0;
  bool hit = false;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = origin + dir * travelled;
    float d = map(p);
    // Мягкое свечение копится у поверхности — объём без второго прохода.
    // Вклад одного шага ограничен: у самой поверхности 1/d уходит в бесконечность.
    glow += min(0.05, 0.012 / (0.02 + abs(d)));
    if (d < SURFACE_DIST) { hit = true; break; }
    travelled += d;
    if (travelled > MAX_DIST) break;
  }

  vec3 color = vec3(0.0);
  if (hit) {
    vec3 p = origin + dir * travelled;
    vec3 normal = normalAt(p);
    vec3 light = normalize(vec3(0.6, 0.8, -0.6));
    float diffuse = max(0.0, dot(normal, light));
    float fresnel = pow(1.0 - max(0.0, dot(normal, -dir)), 2.5);
    float depth = clamp(travelled / 8.0, 0.0, 1.0);

    color = mix(uColorA, uColorB, diffuse);
    color = mix(color, uColorC, fresnel);
    color *= 0.35 + diffuse * (0.6 + uEnergy * 0.8);
    color *= 1.0 - depth * 0.55;
  }

  color += uColorC * min(glow, 1.5) * (0.04 + uEnergy * 0.08);

  // Тон-маппинг Рейнхарда: слой кладётся в композицию через 'lighter',
  // поэтому значения выше единицы выбивают кадр в белое — ограничиваем здесь.
  color = color / (1.0 + color);
  fragColor = vec4(color, 1.0);
}`;

export class RaymarchPrimitive implements DrawPrimitive {
  readonly id = 'raymarch' as const;
  readonly kind = 'draw' as const;

  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private width = 1;
  private height = 1;
  private scale = 0.5;
  private seedValue = 0;
  private unavailable = false;

  /** @returns false, если WebGL2 недоступен — тогда примитив исключается из пула. */
  get available(): boolean {
    return !this.unavailable;
  }

  /** Доля от полного разрешения, в которой считается шейдер (0.25..1). */
  setQuality(scale: number): void {
    const next = Math.min(1, Math.max(0.25, scale));
    if (Math.abs(next - this.scale) < 0.01) return;
    this.scale = next;
    this.resize(this.width, this.height);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.unavailable) return;
    if (!this.canvas) this.init();
    if (!this.canvas || !this.gl) return;
    this.canvas.width = Math.max(1, Math.round(width * this.scale));
    this.canvas.height = Math.max(1, Math.round(height * this.scale));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  reseed(seed: GeneratorSeed): void {
    this.seedValue = mulberry32(seed.seed ^ 0x85ebca6b)() * Math.PI * 2;
  }

  dispose(): void {
    if (this.gl && this.program) this.gl.deleteProgram(this.program);
    this.program = null;
    this.gl = null;
    this.canvas = null;
  }

  draw(frame: RenderFrame): void {
    if (this.unavailable) return;
    if (!this.gl) this.resize(this.width, this.height);
    const gl = this.gl;
    const canvas = this.canvas;
    if (!gl || !canvas || !this.program) return;

    const { mood, params, palette } = frame;
    gl.useProgram(this.program);
    const u = this.uniforms;
    gl.uniform2f(u.uResolution!, canvas.width, canvas.height);
    gl.uniform1f(u.uTime!, frame.timeMs / 1000);
    gl.uniform1f(u.uEnergy!, mood.energy);
    gl.uniform1f(u.uBrightness!, mood.brightness);
    gl.uniform1f(u.uNoisiness!, mood.noisiness);
    gl.uniform1f(u.uFlux!, mood.flux);
    gl.uniform1f(u.uBeatPhase!, mood.beatPhase);
    gl.uniform1f(u.uDensity!, params.density);
    gl.uniform1f(u.uSpeed!, params.speed);
    gl.uniform1f(u.uScale!, params.scale);
    gl.uniform1f(u.uSharpness!, params.sharpness);
    gl.uniform1f(u.uChaos!, params.chaos);
    gl.uniform1f(u.uWarp!, params.warp);
    gl.uniform1f(u.uSeed!, this.seedValue);
    setColor(gl, u.uColorA, palette.accent(0.1));
    setColor(gl, u.uColorB, palette.accent(0.55));
    setColor(gl, u.uColorC, palette.accent(0.95));

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const ctx = frame.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.34 + mood.energy * 0.28) * frame.weight;
    ctx.drawImage(canvas, 0, 0, this.width, this.height);
    ctx.restore();
  }

  private init(): void {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      this.unavailable = true;
      return;
    }

    const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) {
      this.unavailable = true;
      return;
    }

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.unavailable = true;
    });

    this.canvas = canvas;
    this.gl = gl;
    this.program = program;
    this.uniforms = {};
    for (const name of [
      'uResolution', 'uTime', 'uEnergy', 'uBrightness', 'uNoisiness', 'uFlux', 'uBeatPhase',
      'uDensity', 'uSpeed', 'uScale', 'uSharpness', 'uChaos', 'uWarp', 'uSeed',
      'uColorA', 'uColorB', 'uColorC',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    // Полноэкранный треугольник берётся из gl_VertexID, но VAO всё равно нужен.
    gl.bindVertexArray(gl.createVertexArray());
  }
}

function setColor(gl: WebGL2RenderingContext, location: WebGLUniformLocation | null, color: string): void {
  if (!location) return;
  const [r, g, b] = parseHsl(color);
  gl.uniform3f(location, r / 255, g / 255, b / 255);
}

function linkProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[raymarch] link failed:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[raymarch] compile failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
