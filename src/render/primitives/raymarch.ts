import type { Rgb } from '../color/oklch.ts';
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
/* Свои параметры примитива из панели. */
uniform float uTuneRadius;
uniform float uTuneRipple;
uniform float uTuneFacets;
uniform float uTuneGlow;
// Импульс: xy — точка удара в кадре, z — сила. uImpulseRing — радиус фронта.
uniform vec3 uImpulse;
uniform float uImpulseRing;
uniform float uLightAngle;
uniform float uLightFlash;
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
  float radius = mix(0.34, 0.6, uScale) * breathe * uTuneRadius;

  float sphere = sdSphere(p, radius);
  float torus = sdTorus(p, vec2(radius * 1.05, mix(0.5, 0.12, uSharpness) * radius));
  float box = sdBox(p, vec3(radius * 0.78));

  // Форма непрерывно перетекает между шаром, тором и кубом — никаких переключений.
  // Радиусы сглаживания тоже считаются от размера тела: smin занижает значение
  // поля примерно на четверть своего k, и в абсолютных единицах это раздувало
  // форму сильнее, чем она сама.
  float shape = smin(sphere, torus, radius * mix(0.7, 0.1, uSharpness));
  shape = mix(shape, smin(shape, box, radius * 0.4), uBrightness);

  // Складки поверхности: их частота — от density, глубина — от chaos и шумности.
  float ripple = sin(p.x * (3.0 + uDensity * 9.0) + uTime * 1.4)
               * sin(p.y * (3.0 + uDensity * 9.0) - uTime * 1.1)
               * sin(p.z * (3.0 + uDensity * 9.0) + uTime * 0.9);
  // Глубина складок считается от радиуса, а не в абсолютных единицах. С
  // абсолютной глубиной складки раздували эффективный радиус тела почти вдвое:
  // луч «цеплялся» за складку далеко от самой формы, и она занимала весь кадр.
  shape -= ripple * radius * (0.02 + uChaos * 0.1 + uNoisiness * 0.04) * uTuneRipple * 2.0;

  // Волна от удара идёт сферическим фронтом и коробит поверхность на своём пути.
  if (uImpulse.z > 0.001) {
    vec3 centre = vec3(uImpulse.xy * 2.2, 0.0);
    float front = abs(length(p - centre) - uImpulseRing * 3.4);
    shape -= exp(-front * front * 5.0) * uImpulse.z * 0.3;
  }

  // Спутник вокруг основной формы. Раньше здесь была бесконечная решётка
  // через mod — она заполняла весь кадр телами, и при контурной отрисовке
  // экран превращался в сплошную сетку.
  vec3 q = p;
  q.xz *= rot(uTime * 0.4);
  float orbit = sdSphere(q - vec3(1.2 + uWarp * 0.4, 0.0, 0.0), 0.07 + uDensity * 0.12);
  /*
   * Спутник соединяется с телом узкой перемычкой.
   *
   * Радиус сглаживания был 0.6 — больше самого тела. Такое smin не столько
   * скругляет стык, сколько занижает поле во всей округе: между телом и
   * спутником вырастал широкий мост, и луч цеплялся за него далеко от формы.
   * Именно он и давал ту размытую заливку в пол-кадра.
   */
  return smin(shape, orbit, 0.12);
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

  vec3 origin = vec3(0.0, 0.0, -5.0);
  /*
   * Поле зрения. С множителем 3.4 видимая половина кадра на расстоянии до
   * формы составляла примерно 0.74 при радиусе тела до 0.75 — форма ровно
   * заполняла кадр, и чёрного вокруг не оставалось совсем. Шире поле — и
   * форма становится объектом на чёрном, а не фоном.
   */
  vec3 dir = normalize(vec3(uv, 2.4));

  float travelled = 0.0;
  // Насколько близко луч подошёл к поверхности — из этого делается свечение.
  // Накопление вдоль луча не годится: оно набегает даже у лучей, прошедших
  // мимо, и заливает весь кадр ровной серой подложкой.
  float nearest = 1e9;
  bool hit = false;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = origin + dir * travelled;
    float d = map(p);
    nearest = min(nearest, abs(d));
    if (d < SURFACE_DIST) { hit = true; break; }
    travelled += d;
    if (travelled > MAX_DIST) break;
  }
  /*
   * Экспонента по минимальному сближению: строго ноль вдали от формы.
   *
   * Показатель крутой. С шестёркой луч, прошедший в 0.2 от поверхности,
   * получал ещё треть свечения — при теле радиусом около 0.6 это давало
   * мягкую долю вокруг силуэта в пол-кадра. Проверка прямым отключением:
   * с выключенным свечением заполненность падала вдвое, а контраст рос
   * с 7 до 14. Свечение должно облегать линии, а не наполнять пустоту.
   */
  float glow = exp(-nearest * 26.0);

  // Форма рисуется контурами, а не залитой поверхностью: сплошная заливка
  // занимает весь кадр средними тонами и читается мутно. Здесь светятся
  // только силуэт и срезы формы по глубине — как горизонтали на карте.
  vec3 color = vec3(0.0);
  if (hit) {
    vec3 p = origin + dir * travelled;
    vec3 normal = normalAt(p);
    // Источник обходит сцену по орбите — тот же угол, что у фона базового слоя.
    vec3 light = normalize(vec3(cos(uLightAngle) * 0.9, sin(uLightAngle) * 0.9, -0.6));
    float diffuse = max(0.0, dot(normal, light));
    float depth = clamp(travelled / 8.0, 0.0, 1.0);

    /*
     * Силуэт — узкая линия по самому краю, а не мягкий спад к центру.
     *
     * С третьей степенью подсветка тянулась далеко внутрь формы и на
     * крупной форме заливала полкадра. smoothstep оставляет только те лучи,
     * что идут почти по касательной.
     */
    float grazing = 1.0 - max(0.0, dot(normal, -dir));
    // Порог узкий: у крупной формы целая доля поверхности повёрнута почти
    // по касательной, и при широком пороге подсветка силуэта расползается
    // в заливку на пол-кадра вместо линии по краю.
    float rim = smoothstep(0.94, 1.0, grazing);

    /*
     * Срезы по глубине: частота растёт с плотностью, дрейф фазы гонит линии
     * по форме.
     *
     * Ширину линии держим постоянной на экране, а не в единицах глубины.
     *
     * Полоса smoothstep по значению — это интервал по глубине, и его
     * ширина на экране зависит от того, как быстро глубина меняется от
     * пикселя к пикселю. На участке, повёрнутом к камере плашмя, глубина
     * почти постоянна, и вся эта доля попадает внутрь одной полосы: вместо
     * линии получается залитое пятно в пол-кадра. Производная по экрану
     * (fwidth) приводит полосу к постоянной толщине в пикселях.
     */
    float spacing = 2.5 + uDensity * 7.0;
    float sliceCoord = travelled * spacing + uTime * 0.12;
    float sliceWidth = max(fwidth(sliceCoord) * 2.0, 0.015);
    float slice = abs(fract(sliceCoord) - 0.5) * 2.0;
    float sliceLine = smoothstep(1.0 - sliceWidth, 1.0, slice);

    // Линии по нормали добавляют структуру там, где форма поворачивается.
    // Нормировка та же: у пологих участков diffuse меняется медленно, и без
    // неё полоса заливала бы их целиком.
    float facetCoord = diffuse * (3.0 + uSharpness * 6.0);
    float facetWidth = max(fwidth(facetCoord) * 2.0, 0.015);
    float facetValue = abs(fract(facetCoord) - 0.5) * 2.0;
    float facet = smoothstep(1.0 - facetWidth, 1.0, facetValue) * uTuneFacets * 2.0;

    /*
     * Линии светятся сильно. Пока по форме шла мягкая заливка, контуры на её
     * фоне были не нужны — они и стояли вполсилы. Теперь заливки нет, и
     * яркость кадра держат только они, как и положено по правилам §2:
     * яркость набирается линиями, а не площадью.
     */
    color = uColorA * sliceLine * (1.2 + diffuse * 1.4)
          + uColorB * facet * 1.1
          + uColorC * rim * 3.2;
    color *= 1.0 - depth * 0.45;
  }

  // Свечение оставлено совсем слабым: на контурной картинке оно только
  // подсвечивает линии, а не наполняет пустоту.
  color += uColorC * min(glow, 1.0) * (0.015 + uEnergy * 0.03) * uTuneGlow;
  // Вспышка умножается на близость к форме: раньше она прибавлялась ко всем
  // пикселям кадра и держала ровную серую подложку поверх чёрного фона.
  color += uColorA * uLightFlash * glow * 0.4 * uTuneGlow;

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
    gl.uniform1f(u.uTuneRadius!, frame.tuning.radius);
    gl.uniform1f(u.uTuneRipple!, frame.tuning.ripple);
    gl.uniform1f(u.uTuneFacets!, frame.tuning.facets);
    gl.uniform1f(u.uTuneGlow!, frame.tuning.glow);

    // Из всех живых волн шейдеру отдаём самую сильную: остальные на форме
    // всё равно не читаются, а каждая лишняя стоит целого прохода по кадру.
    const scene = frame.scene;
    let strongest = null as (typeof scene.impulses)[number] | null;
    for (const impulse of scene.impulses) {
      const remaining = impulse.strength * (1 - impulse.age / impulse.life);
      if (!strongest || remaining > strongest.strength * (1 - strongest.age / strongest.life)) {
        strongest = impulse;
      }
    }
    if (strongest) {
      const decay = 1 - strongest.age / strongest.life;
      gl.uniform3f(u.uImpulse!, strongest.x - 0.5, 0.5 - strongest.y, strongest.strength * decay);
      gl.uniform1f(u.uImpulseRing!, strongest.radius);
    } else {
      gl.uniform3f(u.uImpulse!, 0, 0, 0);
      gl.uniform1f(u.uImpulseRing!, 0);
    }
    gl.uniform1f(u.uLightAngle!, scene.light.angle);
    gl.uniform1f(u.uLightFlash!, scene.light.flash);
    setColor(gl, u.uColorA, palette.accentRgb(0.1));
    setColor(gl, u.uColorB, palette.accentRgb(0.55));
    setColor(gl, u.uColorC, palette.accentRgb(0.95));

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const ctx = frame.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    /*
     * Вклад делится на затухание слоя.
     *
     * Это единственный примитив, который кладёт в слой картинку во весь
     * кадр, а не отдельные линии. Слой со следами копит: вклад 0.34 за кадр
     * при медленном затухании давал установившуюся яркость под единицу, и
     * форма превращалась в ровное мутное пятно на весь экран — замер
     * показывал 88% заполненности при контрасте 2.3 и двух третях массы
     * гистограммы в средних тонах.
     */
    ctx.globalAlpha = (0.7 + mood.energy * 0.3) * frame.weight * frame.fade;
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
      'uTuneRadius', 'uTuneRipple', 'uTuneFacets', 'uTuneGlow',
      'uImpulse', 'uImpulseRing', 'uLightAngle', 'uLightFlash',
      'uColorA', 'uColorB', 'uColorC',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    // Полноэкранный треугольник берётся из gl_VertexID, но VAO всё равно нужен.
    gl.bindVertexArray(gl.createVertexArray());
  }
}

function setColor(gl: WebGL2RenderingContext, location: WebGLUniformLocation | null, color: Rgb): void {
  if (!location) return;
  gl.uniform3f(location, color[0] / 255, color[1] / 255, color[2] / 255);
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
