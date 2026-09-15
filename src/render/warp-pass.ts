/**
 * Проход искажения пространства: деформации вещества (§4) и все импакт-эффекты,
 * живущие в UV-координатах (§3).
 *
 * Почему одним проходом на GPU, а не по примитивам: искажение должно вести
 * себя как свойство пространства сцены, а не как настройка каждой фигуры.
 * Сведённый кадр загружается текстурой, шейдер гнёт координаты и читает по
 * ним цвет — деформация автоматически действует на всё сразу и стоит один
 * проход по кадру независимо от числа примитивов.
 */

import type { Deformation, ImpactState, WaveRing } from './scene.ts';

/** Сколько колец каждого типа читает шейдер. Должно совпадать с MAX_RINGS сцены. */
const MAX_RINGS = 4;

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

out vec4 fragColor;

uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uTime;

// --- деформации вещества (постоянные, усиливаются на пиках) ---
uniform float uDomainWarp;
uniform float uTwist;
uniform float uWave;
uniform float uTurbulence;
uniform float uMelt;
uniform float uFold;

// --- импакт-эффекты в UV ---
uniform vec4 uShockwaves[${MAX_RINGS}];  // xy — центр, z — радиус фронта, w — сила
uniform vec4 uRipples[${MAX_RINGS}];
uniform int uShockwaveCount;
uniform int uRippleCount;
uniform float uLensPulse;       // + бочка, − подушка
uniform float uChromaticBurst;
uniform float uSlice;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/** Value-шум: для гнутья координат его хватает, а стоит он втрое дешевле симплекса. */
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  ) * 2.0 - 1.0;
}

float fbm(vec2 p) {
  return valueNoise(p) * 0.65 + valueNoise(p * 2.17 + 19.3) * 0.35;
}

vec2 rotate(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c) * p;
}

/**
 * Радиальное смещение от кольца: гауссиана вокруг фронта. Для ряби фронтов
 * несколько — они идут следом друг за другом и затухают.
 */
vec2 ringDisplacement(vec2 centred, vec4 ring, float aspect, int ringCount) {
  vec2 delta = centred - vec2((ring.x - 0.5) * aspect, ring.y - 0.5);
  float distance = length(delta);
  if (distance < 1e-4) return vec2(0.0);

  float total = 0.0;
  for (int k = 0; k < 3; k++) {
    if (k >= ringCount) break;
    // Каждое следующее кольцо отстаёт по радиусу и слабее предыдущего.
    float radius = ring.z - float(k) * 0.12;
    if (radius <= 0.0) continue;
    float offset = (distance - radius) / 0.06;
    total += exp(-offset * offset) / (1.0 + float(k) * 1.6);
  }
  return normalize(delta) * total * ring.w * 0.06;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  // Центрированные координаты с поправкой на пропорции: без неё все радиальные
  // эффекты становятся эллипсами на широком экране.
  vec2 centred = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

  // --- Fold: зеркальные складки пространства ---
  if (uFold > 0.001) {
    float folded = abs(centred.x);
    centred.x = mix(centred.x, folded - 0.25 * aspect * uFold, uFold);
  }

  // --- Twist: закручивание вокруг центра, тем сильнее, чем дальше от него ---
  float radius = length(centred);
  if (uTwist > 0.001) {
    centred = rotate(centred, uTwist * (0.9 - radius) * sin(uTime * 0.6) * 1.6);
  }

  // --- Domain warping: шум гнёт само координатное пространство ---
  if (uDomainWarp > 0.001) {
    vec2 q = vec2(
      fbm(centred * 3.1 + vec2(uTime * 0.16, 0.0)),
      fbm(centred * 3.1 + vec2(5.2, uTime * 0.13))
    );
    centred += q * uDomainWarp * 0.12;
  }

  // --- Turbulence: мелкие локальные завихрения поверх крупного варпа ---
  if (uTurbulence > 0.001) {
    float angle = fbm(centred * 7.3 + uTime * 0.4) * 3.1416;
    centred += vec2(cos(angle), sin(angle)) * uTurbulence * 0.022;
  }

  // --- Wave: синусоидальное смещение по осям ---
  if (uWave > 0.001) {
    centred.x += sin(centred.y * 9.0 + uTime * 1.7) * uWave * 0.02;
    centred.y += sin(centred.x * 7.0 - uTime * 1.3) * uWave * 0.015;
  }

  // --- Melt: вертикальное стекание ---
  if (uMelt > 0.001) {
    float smear = fbm(vec2(centred.x * 5.0, uTime * 0.1)) * 0.5 + 0.5;
    // Течёт только нижняя половина кадра, и тем сильнее, чем ниже.
    centred.y -= smear * uMelt * 0.08 * smoothstep(-0.5, 0.5, centred.y);
  }

  // --- Lens pulse: бочка или подушка ---
  if (abs(uLensPulse) > 0.001) {
    float r2 = dot(centred, centred);
    // Минус, а не плюс: чтобы кадр выпучивался наружу (бочка), выборка должна
    // идти ближе к центру по мере роста радиуса, а не дальше от него.
    centred *= 1.0 - uLensPulse * r2 * 0.8;
  }

  // --- Ударные волны и рябь ---
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    if (i >= uShockwaveCount) break;
    centred += ringDisplacement(centred, uShockwaves[i], aspect, 1);
  }
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    if (i >= uRippleCount) break;
    centred += ringDisplacement(centred, uRipples[i], aspect, 3);
  }

  vec2 warped = vec2(centred.x / aspect, centred.y) + 0.5;

  // --- Slice displacement: горизонтальные блоки уезжают в сторону ---
  if (uSlice > 0.001) {
    float band = floor(warped.y * 22.0);
    float shift = (hash(vec2(band, floor(uTime * 12.0))) * 2.0 - 1.0);
    // Смещается не каждая полоса, иначе это читается как дрожь, а не как сбой.
    // Имя не active: это зарезервированное слово GLSL ES 3.00.
    float bandActive = step(0.62, hash(vec2(band, floor(uTime * 12.0) + 7.0)));
    warped.x += shift * bandActive * uSlice * 0.06;
  }

  // --- Chromatic burst: каналы разлетаются от центра и сходятся обратно ---
  if (uChromaticBurst > 0.001) {
    vec2 direction = warped - 0.5;
    float amount = uChromaticBurst * 0.03;
    fragColor = vec4(
      texture(uTexture, clamp(warped + direction * amount, 0.0, 1.0)).r,
      texture(uTexture, clamp(warped, 0.0, 1.0)).g,
      texture(uTexture, clamp(warped - direction * amount, 0.0, 1.0)).b,
      1.0
    );
    return;
  }

  fragColor = vec4(texture(uTexture, clamp(warped, 0.0, 1.0)).rgb, 1.0);
}`;

export class WarpPass {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private width = 1;
  private height = 1;
  private unavailable = false;

  /** Буферы под массивы колец — чтобы не аллоцировать их каждый кадр. */
  private readonly shockwaveData = new Float32Array(MAX_RINGS * 4);
  private readonly rippleData = new Float32Array(MAX_RINGS * 4);

  get available(): boolean {
    return !this.unavailable;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.unavailable) return;
    if (!this.canvas) this.init();
    if (!this.canvas || !this.gl) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  /**
   * Есть ли вообще что искажать. Если всё выключено и ударов нет, проход
   * пропускается целиком — кадр идёт на экран напрямую.
   */
  static isIdle(deformation: Deformation, impact: ImpactState): boolean {
    const deformationSum = deformation.domainWarp + deformation.twist + deformation.wave
      + deformation.turbulence + deformation.melt + deformation.fold;
    const impactSum = Math.abs(impact.lensPulse) + impact.chromaticBurst + impact.slice
      + impact.shockwaves.length + impact.ripples.length;
    return deformationSum < 0.004 && impactSum < 0.004;
  }

  /**
   * @param source сведённый кадр
   * @returns холст с искажённым кадром или null, если проход недоступен
   */
  render(source: CanvasImageSource, deformation: Deformation, impact: ImpactState): HTMLCanvasElement | null {
    if (this.unavailable) return null;
    if (!this.gl) this.resize(this.width, this.height);
    const gl = this.gl;
    const canvas = this.canvas;
    if (!gl || !canvas || !this.program || !this.texture) return null;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);

    gl.useProgram(this.program);
    const u = this.uniforms;
    gl.uniform2f(u.uResolution!, canvas.width, canvas.height);
    gl.uniform1f(u.uTime!, deformation.time);
    gl.uniform1f(u.uDomainWarp!, deformation.domainWarp);
    gl.uniform1f(u.uTwist!, deformation.twist);
    gl.uniform1f(u.uWave!, deformation.wave);
    gl.uniform1f(u.uTurbulence!, deformation.turbulence);
    gl.uniform1f(u.uMelt!, deformation.melt);
    gl.uniform1f(u.uFold!, deformation.fold);
    gl.uniform1f(u.uLensPulse!, impact.lensPulse);
    gl.uniform1f(u.uChromaticBurst!, impact.chromaticBurst);
    gl.uniform1f(u.uSlice!, impact.slice);

    const shockwaveCount = packRings(impact.shockwaves, this.shockwaveData);
    const rippleCount = packRings(impact.ripples, this.rippleData);
    gl.uniform4fv(u.uShockwaves!, this.shockwaveData);
    gl.uniform4fv(u.uRipples!, this.rippleData);
    gl.uniform1i(u.uShockwaveCount!, shockwaveCount);
    gl.uniform1i(u.uRippleCount!, rippleCount);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  }

  dispose(): void {
    if (this.gl) {
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.texture) this.gl.deleteTexture(this.texture);
    }
    this.program = null;
    this.texture = null;
    this.gl = null;
    this.canvas = null;
  }

  private init(): void {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      alpha: false,
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

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // CLAMP_TO_EDGE: координаты после варпа выходят за кадр, и края должны
    // растягиваться, а не заворачиваться на противоположную сторону.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.unavailable = true;
    });

    this.canvas = canvas;
    this.gl = gl;
    this.program = program;
    this.texture = texture;
    this.uniforms = {};
    for (const name of [
      'uTexture', 'uResolution', 'uTime',
      'uDomainWarp', 'uTwist', 'uWave', 'uTurbulence', 'uMelt', 'uFold',
      'uShockwaves', 'uRipples', 'uShockwaveCount', 'uRippleCount',
      'uLensPulse', 'uChromaticBurst', 'uSlice',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.useProgram(program);
    gl.uniform1i(this.uniforms.uTexture!, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(gl.createVertexArray());
  }
}

/** Кольца в плоский буфер: xy — центр, z — радиус, w — сила. */
function packRings(rings: WaveRing[], target: Float32Array): number {
  target.fill(0);
  const count = Math.min(MAX_RINGS, rings.length);
  for (let i = 0; i < count; i++) {
    const ring = rings[i];
    target[i * 4] = ring.x;
    target[i * 4 + 1] = ring.y;
    target[i * 4 + 2] = ring.radius;
    target[i * 4 + 3] = ring.strength;
  }
  return count;
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
    console.error('[warp] link failed:', gl.getProgramInfoLog(program));
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
    console.error('[warp] compile failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
