/**
 * Пост-конвейер: искажение пространства, память кадра и свет.
 *
 * Почему одним конвейером на GPU: искажение должно вести себя как свойство
 * пространства сцены, а не как настройка каждой фигуры, а свету нужен весь
 * сведённый кадр целиком. Всё это живёт в одном контексте, поэтому кадр
 * попадает в видеопамять один раз и возвращается на экран один раз — без
 * промежуточных копий через канвасы.
 *
 * Порядок:
 *   1. варп — деформации, UV-эффекты удара и обратная связь кадра;
 *   2. яркостный срез с адаптивным порогом в четверти разрешения;
 *   3. два прохода размытия — получается bloom;
 *   4. сведение — bloom, объёмные лучи, контровой свет, блик, экспозиция,
 *      виньетка.
 */

import type { Deformation, ImpactState, Light, Memory, WaveRing } from './scene.ts';

/** Сколько колец каждого типа читает шейдер. Должно совпадать с MAX_RINGS сцены. */
const MAX_RINGS = 4;

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

const WARP_FRAGMENT = `#version 300 es
precision highp float;

out vec4 fragColor;

uniform sampler2D uTexture;
/** Прошлый кадр: копия предыдущего результата варпа, та же ориентация. */
uniform sampler2D uFeedback;
uniform vec2 uResolution;
uniform float uTime;

// --- память сцены ---
uniform float uFeedbackAmount;
uniform float uFeedbackZoom;
uniform float uFeedbackRotate;
uniform vec2 uFeedbackOffset;
uniform float uSmear;

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
  vec3 colour;
  if (uChromaticBurst > 0.001) {
    vec2 direction = warped - 0.5;
    float amount = uChromaticBurst * 0.03;
    colour = vec3(
      texture(uTexture, clamp(warped + direction * amount, 0.0, 1.0)).r,
      texture(uTexture, clamp(warped, 0.0, 1.0)).g,
      texture(uTexture, clamp(warped - direction * amount, 0.0, 1.0)).b
    );
  } else {
    colour = texture(uTexture, clamp(warped, 0.0, 1.0)).rgb;
  }

  // --- Frame feedback: прошлый кадр со сдвигом, масштабом и поворотом ---
  if (uFeedbackAmount > 0.001) {
    vec2 f = warped - 0.5;
    f = rotate(f, uFeedbackRotate);
    // Масштаб больше единицы — выборка из меньшей области, содержимое растёт:
    // это и читается как полёт внутрь туннеля.
    f /= max(0.5, uFeedbackZoom);
    f += 0.5 + uFeedbackOffset;
    vec3 previous = texture(uFeedback, clamp(f, 0.0, 1.0)).rgb * 0.92;

    // Предохранитель от самовозбуждения: берём максимум, а не сумму.
    // Максимум затухающей последовательности не может превысить самый яркий
    // кадр в истории, поэтому обратная связь принципиально не расходится.
    colour = max(colour, previous * uFeedbackAmount);
  }

  // --- Temporal smear: прошлый кадр без преобразования ---
  if (uSmear > 0.001) {
    vec3 previous = texture(uFeedback, clamp(warped, 0.0, 1.0)).rgb;
    // Взвешенное среднее — сжимающая операция, ярче исходника стать не может.
    colour = mix(colour, previous, uSmear * 0.6);
  }

  fragColor = vec4(min(colour, vec3(1.0)), 1.0);
}`;


/**
 * Яркостный срез с мягким коленом. Порог адаптивный: он приходит снаружи из
 * средней яркости кадра, поэтому bloom не выжигает и без того светлую картинку
 * и не пропадает на тёмной.
 */
const BRIGHT_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uThreshold;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 colour = texture(uTexture, uv).rgb;
  float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
  // Мягкое колено вместо ступеньки: иначе на границе порога видны рваные пятна.
  float knee = max(0.0001, uThreshold * 0.5);
  float weight = clamp((luma - uThreshold + knee) / (2.0 * knee), 0.0, 1.0);
  fragColor = vec4(colour * weight * weight, 1.0);
}`;

/** Разделимое гауссово размытие: один и тот же шейдер для обеих осей. */
const BLUR_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform vec2 uDirection;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 step = uDirection / uResolution;
  // Веса девятиточечного гаусса, свёрнутого до пяти выборок.
  vec3 sum = texture(uTexture, uv).rgb * 0.2270270270;
  sum += texture(uTexture, uv + step * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uTexture, uv - step * 1.3846153846).rgb * 0.3162162162;
  sum += texture(uTexture, uv + step * 3.2307692308).rgb * 0.0702702703;
  sum += texture(uTexture, uv - step * 3.2307692308).rgb * 0.0702702703;
  fragColor = vec4(sum, 1.0);
}`;

/**
 * Сведение света. Здесь всё, что делает кадр «освещённым», а не просто
 * раскрашенным: bloom, объёмные лучи от источника, контровой свет по силуэтам,
 * блик, дыхание экспозиции и виньетка.
 */
const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uResolution;

uniform float uBloomIntensity;
uniform float uRays;
uniform int uRaySamples;
uniform float uRim;
uniform float uFlare;
uniform float uExposure;
uniform float uVignette;
/** Точка белого расширенного Рейнхарда: яркость, которая станет единицей. */
uniform float uWhitePoint;
uniform vec2 uLightPos;
uniform vec3 uLightColour;
uniform vec3 uRimColour;

/** Потолок цикла лучей: сам счётчик приходит уравнением качества. */
const int MAX_RAY_SAMPLES = 20;

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec3 colour = texture(uScene, uv).rgb;
  vec3 bloom = texture(uBloom, uv).rgb;

  colour += bloom * uBloomIntensity;

  // --- Объёмные лучи: радиальное накопление яркой части к источнику ---
  if (uRays > 0.001) {
    vec2 delta = (uv - uLightPos) / float(uRaySamples) * 0.7;
    vec2 sampleUv = uv;
    float decay = 1.0;
    vec3 rays = vec3(0.0);
    for (int i = 0; i < MAX_RAY_SAMPLES; i++) {
      if (i >= uRaySamples) break;
      sampleUv -= delta;
      rays += texture(uBloom, clamp(sampleUv, 0.0, 1.0)).rgb * decay;
      decay *= 0.86;
    }
    colour += rays * (uRays / float(uRaySamples)) * uLightColour * 2.4;
  }

  // --- Контровой свет: подсветка силуэтов со стороны источника ---
  if (uRim > 0.001) {
    vec2 texel = 1.0 / uResolution;
    // Градиент яркости — дешёвая замена нормали: на плотных формах он резкий.
    float lx = luminance(texture(uScene, uv + vec2(texel.x, 0.0)).rgb)
             - luminance(texture(uScene, uv - vec2(texel.x, 0.0)).rgb);
    float ly = luminance(texture(uScene, uv + vec2(0.0, texel.y)).rgb)
             - luminance(texture(uScene, uv - vec2(0.0, texel.y)).rgb);
    vec2 gradient = vec2(lx, ly);
    float edge = length(gradient);
    if (edge > 0.0001) {
      vec2 toLight = normalize((uLightPos - uv) * vec2(aspect, 1.0));
      // Светится только та сторона силуэта, что обращена к источнику.
      float facing = max(0.0, dot(normalize(gradient), toLight));
      colour += uRimColour * edge * facing * uRim * 6.0;
    }
  }

  // --- Блик: несколько призраков вдоль линии «источник — центр» ---
  if (uFlare > 0.001) {
    vec2 toCentre = vec2(0.5) - uLightPos;
    for (int i = 1; i <= 3; i++) {
      vec2 ghostPos = uLightPos + toCentre * (0.45 * float(i));
      float distance = length((uv - ghostPos) * vec2(aspect, 1.0));
      float ghost = exp(-distance * distance * (90.0 + float(i) * 55.0));
      colour += uLightColour * ghost * uFlare * (0.5 / float(i));
    }
    // Сам источник — мягкое пятно.
    float core = exp(-pow(length((uv - uLightPos) * vec2(aspect, 1.0)), 2.0) * 140.0);
    colour += uLightColour * core * uFlare * 0.7;
  }

  colour *= uExposure;

  // --- Виньетка: поджимается на билд-апе, раскрывается на дропе ---
  vec2 centred = (uv - 0.5) * vec2(aspect, 1.0);
  float radius = length(centred) / 0.72;
  float vignette = 1.0 - uVignette * smoothstep(0.35, 1.25, radius);
  colour *= vignette;

  // Расширенный тон-маппинг Рейнхарда — последний рубеж всей цепочки.
  // Обычный Рейнхард никогда не доводит до единицы и делает кадр вялым;
  // расширенный отображает uWhitePoint ровно в 1, сохраняя яркие места.
  vec3 numerator = colour * (1.0 + colour / (uWhitePoint * uWhitePoint));
  colour = numerator / (1.0 + colour);
  fragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
}`;

/**
 * Градация качества всей цепочки. Каждый проход стоит кадров, поэтому
 * снижать нужно не что-то одно, а всё сразу и согласованно.
 */
export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  /** Доля разрешения для буферов bloom. */
  bloomScale: number;
  /** Сколько раз повторяется пара горизонталь/вертикаль. */
  blurPasses: number;
  /** Число выборок объёмных лучей. */
  raySamples: number;
  /** Разрешено ли считать контровой свет. */
  rim: boolean;
  /** Доля разрешения для raymarch-примитива. */
  raymarch: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { bloomScale: 0.18, blurPasses: 1, raySamples: 6, rim: false, raymarch: 0.3 },
  medium: { bloomScale: 0.25, blurPasses: 1, raySamples: 12, rim: true, raymarch: 0.5 },
  high: { bloomScale: 0.34, blurPasses: 2, raySamples: 20, rim: true, raymarch: 0.75 },
};

export const QUALITY_ORDER: QualityLevel[] = ['low', 'medium', 'high'];

export interface LightSettings {
  /** Сила bloom, 0..1. */
  bloom: number;
  /** Порог bloom: приходит снаружи как адаптивный. */
  bloomThreshold: number;
  rays: number;
  rim: number;
  /** Цвет света и контрового света в 0..1. */
  lightColour: Rgb01;
  rimColour: Rgb01;
  /** Точка белого тон-маппинга: во что отображается «самое яркое». */
  whitePoint: number;
}

export type Rgb01 = [number, number, number];

export class PostPass {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private warpProgram: WebGLProgram | null = null;
  private brightProgram: WebGLProgram | null = null;
  private blurProgram: WebGLProgram | null = null;
  private compositeProgram: WebGLProgram | null = null;

  private sceneTexture: WebGLTexture | null = null;
  /**
   * Два кадровых буфера, между которыми идёт ping-pong: варп пишет в один и
   * читает другой как обратную связь. Копировать кадр не нужно вовсе —
   * достаточно поменять индекс.
   */
  private frameTextures: Array<WebGLTexture | null> = [null, null];
  private frameFbos: Array<WebGLFramebuffer | null> = [null, null];
  private writeIndex = 0;
  private bloomTextureA: WebGLTexture | null = null;
  private bloomTextureB: WebGLTexture | null = null;
  private bloomFboA: WebGLFramebuffer | null = null;
  private bloomFboB: WebGLFramebuffer | null = null;

  private warpUniforms: Record<string, WebGLUniformLocation | null> = {};
  private brightUniforms: Record<string, WebGLUniformLocation | null> = {};
  private blurUniforms: Record<string, WebGLUniformLocation | null> = {};
  private compositeUniforms: Record<string, WebGLUniformLocation | null> = {};

  private width = 1;
  private height = 1;
  private bloomWidth = 1;
  private bloomHeight = 1;
  private quality: QualityPreset = QUALITY_PRESETS.medium;
  private unavailable = false;
  /** До первого кадра в буфере обратной связи мусор — подмешивать его нельзя. */
  private feedbackReady = false;

  /** Буферы под массивы колец — чтобы не аллоцировать их каждый кадр. */
  private readonly shockwaveData = new Float32Array(MAX_RINGS * 4);
  private readonly rippleData = new Float32Array(MAX_RINGS * 4);

  get available(): boolean {
    return !this.unavailable;
  }

  /** @returns true, если уровень изменился и буферы пересобраны. */
  setQuality(level: QualityLevel): boolean {
    const preset = QUALITY_PRESETS[level];
    if (preset === this.quality) return false;
    this.quality = preset;
    this.resize(this.width, this.height);
    return true;
  }

  get qualityPreset(): QualityPreset {
    return this.quality;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.bloomWidth = Math.max(1, Math.round(width * this.quality.bloomScale));
    this.bloomHeight = Math.max(1, Math.round(height * this.quality.bloomScale));
    if (this.unavailable) return;
    if (!this.canvas) this.init();
    if (!this.canvas || !this.gl) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.allocateTargets();
  }

  /**
   * Есть ли вообще что делать. Свет считается всегда, если он включён, поэтому
   * пропустить конвейер можно только когда выключено вообще всё.
   */
  static isIdle(deformation: Deformation, impact: ImpactState, memory: Memory, light: LightSettings): boolean {
    const deformationSum = deformation.domainWarp + deformation.twist + deformation.wave
      + deformation.turbulence + deformation.melt + deformation.fold;
    const impactSum = Math.abs(impact.lensPulse) + impact.chromaticBurst + impact.slice
      + impact.shockwaves.length + impact.ripples.length;
    const memorySum = memory.feedbackAmount + memory.smear;
    const lightSum = light.bloom + light.rays + light.rim;
    return deformationSum < 0.004 && impactSum < 0.004 && memorySum < 0.004 && lightSum < 0.004;
  }

  /**
   * @param source сведённый кадр
   * @returns холст с результатом или null, если конвейер недоступен
   */
  render(
    source: CanvasImageSource,
    deformation: Deformation,
    impact: ImpactState,
    memory: Memory,
    lightState: Light,
    light: LightSettings,
    /** Статичная линза от поля зрения камеры: + бочка, − подушка. */
    fovLens = 0,
  ): HTMLCanvasElement | null {
    if (this.unavailable) return null;
    if (!this.gl) this.resize(this.width, this.height);
    const gl = this.gl;
    const canvas = this.canvas;
    if (!gl || !canvas || !this.warpProgram || !this.compositeProgram) return null;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);

    this.runWarp(gl, deformation, impact, memory, fovLens);
    this.runBloom(gl, light);
    this.runComposite(gl, lightState, light);

    // Следующий кадр будет читать этот как обратную связь.
    this.writeIndex ^= 1;
    this.feedbackReady = true;
    return canvas;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl) {
      for (const program of [this.warpProgram, this.brightProgram, this.blurProgram, this.compositeProgram]) {
        if (program) gl.deleteProgram(program);
      }
      for (const texture of [
        this.sceneTexture, ...this.frameTextures, this.bloomTextureA, this.bloomTextureB,
      ]) {
        if (texture) gl.deleteTexture(texture);
      }
      for (const fbo of [...this.frameFbos, this.bloomFboA, this.bloomFboB]) {
        if (fbo) gl.deleteFramebuffer(fbo);
      }
    }
    this.gl = null;
    this.canvas = null;
  }

  /** Шаг 1: деформации, удары и обратная связь — в собственный буфер. */
  private runWarp(
    gl: WebGL2RenderingContext,
    deformation: Deformation,
    impact: ImpactState,
    memory: Memory,
    fovLens: number,
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.frameFbos[this.writeIndex]);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.warpProgram);

    // Обратная связь читается из второго буфера пары.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTextures[this.writeIndex ^ 1]);
    gl.activeTexture(gl.TEXTURE0);

    const u = this.warpUniforms;
    gl.uniform2f(u.uResolution!, this.width, this.height);
    gl.uniform1f(u.uTime!, deformation.time);
    gl.uniform1f(u.uDomainWarp!, deformation.domainWarp);
    gl.uniform1f(u.uTwist!, deformation.twist);
    gl.uniform1f(u.uWave!, deformation.wave);
    gl.uniform1f(u.uTurbulence!, deformation.turbulence);
    gl.uniform1f(u.uMelt!, deformation.melt);
    gl.uniform1f(u.uFold!, deformation.fold);
    // Импульсная линза и линза поля зрения — одна и та же математика,
    // поэтому складываются до шейдера.
    gl.uniform1f(u.uLensPulse!, impact.lensPulse + fovLens);
    gl.uniform1f(u.uChromaticBurst!, impact.chromaticBurst);
    gl.uniform1f(u.uSlice!, impact.slice);
    gl.uniform1f(u.uFeedbackAmount!, this.feedbackReady ? memory.feedbackAmount : 0);
    gl.uniform1f(u.uFeedbackZoom!, memory.feedbackZoom);
    gl.uniform1f(u.uFeedbackRotate!, memory.feedbackRotate);
    gl.uniform2f(u.uFeedbackOffset!, memory.feedbackX, memory.feedbackY);
    gl.uniform1f(u.uSmear!, this.feedbackReady ? memory.smear : 0);

    const shockwaveCount = packRings(impact.shockwaves, this.shockwaveData);
    const rippleCount = packRings(impact.ripples, this.rippleData);
    gl.uniform4fv(u.uShockwaves!, this.shockwaveData);
    gl.uniform4fv(u.uRipples!, this.rippleData);
    gl.uniform1i(u.uShockwaveCount!, shockwaveCount);
    gl.uniform1i(u.uRippleCount!, rippleCount);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Шаги 2-3: яркостный срез и два прохода размытия в четверти разрешения. */
  private runBloom(gl: WebGL2RenderingContext, light: LightSettings): void {
    gl.viewport(0, 0, this.bloomWidth, this.bloomHeight);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFboA);
    gl.useProgram(this.brightProgram);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTextures[this.writeIndex]);
    gl.uniform1i(this.brightUniforms.uTexture!, 2);
    gl.uniform2f(this.brightUniforms.uResolution!, this.bloomWidth, this.bloomHeight);
    gl.uniform1f(this.brightUniforms.uThreshold!, light.bloomThreshold);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.blurProgram);
    gl.uniform2f(this.blurUniforms.uResolution!, this.bloomWidth, this.bloomHeight);
    gl.uniform1i(this.blurUniforms.uTexture!, 3);

    // Каждый проход расширяет радиус вдвое: два прохода дают мягкий широкий
    // ореол, один — экономный узкий.
    for (let pass = 0; pass < this.quality.blurPasses; pass++) {
      const spread = 1 + pass * 2;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFboB);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureA);
      gl.uniform2f(this.blurUniforms.uDirection!, spread, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFboA);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureB);
      gl.uniform2f(this.blurUniforms.uDirection!, 0, spread);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /** Шаг 4: сведение света на экранный холст. */
  private runComposite(gl: WebGL2RenderingContext, state: Light, light: LightSettings): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.compositeProgram);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTextures[this.writeIndex]);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureA);

    const u = this.compositeUniforms;
    gl.uniform1i(u.uScene!, 2);
    gl.uniform1i(u.uBloom!, 3);
    gl.uniform2f(u.uResolution!, this.width, this.height);
    gl.uniform1f(u.uBloomIntensity!, light.bloom);
    gl.uniform1f(u.uRays!, light.rays);
    gl.uniform1i(u.uRaySamples!, this.quality.raySamples);
    gl.uniform1f(u.uRim!, this.quality.rim ? light.rim : 0);
    gl.uniform1f(u.uWhitePoint!, light.whitePoint);
    gl.uniform1f(u.uFlare!, state.flare);
    gl.uniform1f(u.uExposure!, state.exposure);
    gl.uniform1f(u.uVignette!, state.vignette);
    gl.uniform2f(u.uLightPos!, state.x, state.y);
    gl.uniform3f(u.uLightColour!, light.lightColour[0], light.lightColour[1], light.lightColour[2]);
    gl.uniform3f(u.uRimColour!, light.rimColour[0], light.rimColour[1], light.rimColour[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
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

    const warpProgram = linkProgram(gl, VERTEX_SHADER, WARP_FRAGMENT);
    const brightProgram = linkProgram(gl, VERTEX_SHADER, BRIGHT_FRAGMENT);
    const blurProgram = linkProgram(gl, VERTEX_SHADER, BLUR_FRAGMENT);
    const compositeProgram = linkProgram(gl, VERTEX_SHADER, COMPOSITE_FRAGMENT);
    if (!warpProgram || !brightProgram || !blurProgram || !compositeProgram) {
      this.unavailable = true;
      return;
    }

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.unavailable = true;
    });

    this.canvas = canvas;
    this.gl = gl;
    this.warpProgram = warpProgram;
    this.brightProgram = brightProgram;
    this.blurProgram = blurProgram;
    this.compositeProgram = compositeProgram;

    this.warpUniforms = collectUniforms(gl, warpProgram, [
      'uTexture', 'uFeedback', 'uResolution', 'uTime',
      'uFeedbackAmount', 'uFeedbackZoom', 'uFeedbackRotate', 'uFeedbackOffset', 'uSmear',
      'uDomainWarp', 'uTwist', 'uWave', 'uTurbulence', 'uMelt', 'uFold',
      'uShockwaves', 'uRipples', 'uShockwaveCount', 'uRippleCount',
      'uLensPulse', 'uChromaticBurst', 'uSlice',
    ]);
    this.brightUniforms = collectUniforms(gl, brightProgram, ['uTexture', 'uResolution', 'uThreshold']);
    this.blurUniforms = collectUniforms(gl, blurProgram, ['uTexture', 'uResolution', 'uDirection']);
    this.compositeUniforms = collectUniforms(gl, compositeProgram, [
      'uScene', 'uBloom', 'uResolution', 'uBloomIntensity', 'uRays', 'uRaySamples', 'uRim',
      'uFlare', 'uExposure', 'uVignette', 'uWhitePoint', 'uLightPos', 'uLightColour', 'uRimColour',
    ]);

    gl.useProgram(warpProgram);
    gl.uniform1i(this.warpUniforms.uTexture!, 0);
    gl.uniform1i(this.warpUniforms.uFeedback!, 1);

    this.sceneTexture = createTexture(gl);
    this.frameTextures = [createTexture(gl), createTexture(gl)];
    this.frameFbos = [gl.createFramebuffer(), gl.createFramebuffer()];
    this.bloomTextureA = createTexture(gl);
    this.bloomTextureB = createTexture(gl);
    this.bloomFboA = gl.createFramebuffer();
    this.bloomFboB = gl.createFramebuffer();

    // Исходный кадр приходит из 2D-канваса, который устроен «сверху вниз».
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindVertexArray(gl.createVertexArray());
    this.allocateTargets();
  }

  /** Переаллокация всех буферов под текущий размер кадра. */
  private allocateTargets(): void {
    const gl = this.gl;
    if (!gl) return;

    for (let i = 0; i < 2; i++) {
      allocate(gl, this.frameTextures[i], this.width, this.height);
      attach(gl, this.frameFbos[i], this.frameTextures[i]);
    }
    allocate(gl, this.bloomTextureA, this.bloomWidth, this.bloomHeight);
    allocate(gl, this.bloomTextureB, this.bloomWidth, this.bloomHeight);

    attach(gl, this.bloomFboA, this.bloomTextureA);
    attach(gl, this.bloomFboB, this.bloomTextureB);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.feedbackReady = false;
  }
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // CLAMP_TO_EDGE: координаты после варпа выходят за кадр, и края должны
  // растягиваться, а не заворачиваться на противоположную сторону.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

function allocate(gl: WebGL2RenderingContext, texture: WebGLTexture | null, width: number, height: number): void {
  if (!texture) return;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

function attach(gl: WebGL2RenderingContext, fbo: WebGLFramebuffer | null, texture: WebGLTexture | null): void {
  if (!fbo || !texture) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
}

function collectUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: string[],
): Record<string, WebGLUniformLocation | null> {
  const result: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) result[name] = gl.getUniformLocation(program, name);
  return result;
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
    console.error('[post] link failed:', gl.getProgramInfoLog(program));
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
    console.error('[post] compile failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
