/**
 * Свои параметры каждого примитива.
 *
 * Общий ползунок «интенсивность» не даёт подобрать картинку: у ландшафта из
 * волны и у спектра нечего крутить одной ручкой. Поэтому у каждого примитива
 * свой набор — и именно он показывается в отдельном разделе панели.
 *
 * Значения здесь не заменяют реакцию на музыку, а масштабируют её: примитив
 * по-прежнему берёт плотность и размах из `GenParams`, а параметр умножает
 * или сдвигает результат. Иначе настройка убила бы отклик на звук.
 */

import type { PrimitiveId } from './types.ts';

export interface ParamSpec {
  key: string;
  label: string;
  /** Безопасный диапазон: внутри него рендер не ломается. */
  min: number;
  max: number;
  step: number;
  def: number;
  /**
   * Расширенный диапазон — открывается галочкой «расширенный режим».
   * Здесь живут значения, которые заведомо уродуют картинку, но нужны для
   * поиска: тысяча линий, нулевая толщина, десятикратное усиление.
   */
  wide?: readonly [number, number];
  /** Как показывать значение: доля, множитель или просто число. */
  format?: 'percent' | 'multiplier' | 'plain';
  hint?: string;
}

export type Tuning = Readonly<Record<string, number>>;

/** Множитель «как было» — 1. Такой параметр ничего не меняет по умолчанию. */
const gain = (key: string, label: string, hint?: string): ParamSpec => ({
  key, label, min: 0.2, max: 2, step: 0.05, def: 1, wide: [0, 6], format: 'multiplier', hint,
});

/** Доля 0..1 с дефолтом посередине набора. */
const share = (key: string, label: string, def: number, hint?: string): ParamSpec => ({
  key, label, min: 0, max: 1, step: 0.01, def, format: 'percent', hint,
});

const lineWidth: ParamSpec = {
  key: 'lineWidth',
  label: 'Толщина линии',
  // 1-2 физических пикселя — правило из разбора референсов. Тоньше единицы
  // линия начинает исчезать при сглаживании, толще двух — картинка мутнеет.
  min: 0.5, max: 2.5, step: 0.1, def: 1, wide: [0.1, 8], format: 'multiplier',
  hint: 'В физических пикселях, а не в CSS',
};

export const PRIMITIVE_PARAMS: Record<PrimitiveId, readonly ParamSpec[]> = {
  'waveform-terrain': [
    { key: 'depth', label: 'Глубина истории', min: 20, max: 190, step: 5, def: 120, format: 'plain',
      hint: 'Сколько кадров волны уходит вглубь' },
    share('perspective', 'Шаг перспективы', 0.5, 'Насколько дальние кадры поднимаются и сжимаются'),
    gain('verticalGain', 'Усиление по вертикали'),
    lineWidth,
    share('reflection', 'Сила отражения', 0.6, 'Зеркало ниже горизонта — «вода» из референса'),
    share('rain', 'Плотность штрихов', 0.5, 'Вертикальный «дождь» от гребней'),
  ],
  'wave-mesh': [
    { key: 'lines', label: 'Число линий', min: 20, max: 150, step: 1, def: 110, format: 'plain',
      wide: [4, 400] },
    gain('amplitude', 'Амплитуда'),
    gain('noiseScale', 'Частота шума'),
    gain('flow', 'Скорость течения'),
    share('spectrumMix', 'Вклад спектра', 0.55, 'Детализация линии от спектра поверх плавной формы'),
    lineWidth,
  ],
  spectrum: [
    { key: 'bars', label: 'Число столбцов', min: 64, max: 256, step: 8, def: 192, format: 'plain',
      wide: [8, 512] },
    share('gap', 'Зазор между столбцами', 0.4),
    gain('barHeight', 'Высота столбцов'),
    share('peaks', 'Пиковые метки', 0.7, 'Скорость опадания меток; 0 — выключить'),
    share('glitch', 'Сила глитча', 0.6, 'Блочные сдвиги, выпадения и заедание кадра'),
    share('rainbow', 'Радуга по частоте', 1, '0 — палитра трека вместо радуги'),
  ],
  'radial-waveform': [
    gain('radius', 'Радиус кольца'),
    gain('amplitude', 'Амплитуда'),
    { key: 'rings', label: 'Число колец', min: 1, max: 4, step: 1, def: 2, format: 'plain' },
    gain('spin', 'Скорость вращения'),
    lineWidth,
  ],
  oscilloscope: [
    share('persistence', 'Послесвечение', 0.6, 'Фосфорный след: 1 — почти не гаснет'),
    gain('gain', 'Усиление'),
    share('lissajous', 'Режим XY', 1, '0 — обычная развёртка, 1 — фигуры Лиссажу по стерео'),
    lineWidth,
  ],
  'flow-field': [
    gain('particles', 'Число частиц'),
    gain('speed', 'Скорость'),
    gain('fieldScale', 'Масштаб поля'),
    share('trail', 'Длина следа', 0.5),
    lineWidth,
  ],
  metaballs: [
    { key: 'balls', label: 'Число блобов', min: 2, max: 14, step: 1, def: 7, format: 'plain' },
    gain('ballRadius', 'Радиус блоба'),
    { key: 'shells', label: 'Число изолиний', min: 1, max: 4, step: 1, def: 2, format: 'plain',
      hint: 'Вложенные контуры поля вместо заливки' },
    gain('speed', 'Скорость'),
    lineWidth,
  ],
  voronoi: [
    gain('sites', 'Число точек'),
    share('edge', 'Резкость границы', 0.5),
    gain('speed', 'Скорость'),
    lineWidth,
  ],
  kaleidoscope: [
    { key: 'segments', label: 'Число секторов', min: 3, max: 12, step: 1, def: 6, format: 'plain' },
    share('twist', 'Закрутка', 0.35),
    gain('zoom', 'Приближение'),
  ],
  cellular: [
    gain('cellSize', 'Размер клетки'),
    share('birth', 'Порог рождения', 0.5),
    gain('speed', 'Скорость шага'),
    share('dots', 'Точки на живых клетках', 0.7),
  ],
  'l-system': [
    { key: 'depth', label: 'Глубина ветвления', min: 2, max: 8, step: 1, def: 5, format: 'plain' },
    gain('angle', 'Угол ветвления'),
    gain('length', 'Длина сегмента'),
    lineWidth,
  ],
  raymarch: [
    gain('radius', 'Радиус формы'),
    share('ripple', 'Глубина ряби', 0.5),
    share('facets', 'Грани и срезы', 0.5, 'Контурные линии по телу формы'),
    gain('glow', 'Свечение'),
  ],
};

/** Значения по умолчанию одного примитива. */
export function defaultPrimitiveParams(id: PrimitiveId): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of PRIMITIVE_PARAMS[id]) out[spec.key] = spec.def;
  return out;
}

/**
 * Дополняет сохранённые значения дефолтами и обрезает по допустимому
 * диапазону. Пресет из прошлой версии не должен ни ронять рендер, ни терять
 * параметры, которых тогда ещё не было.
 */
export function resolvePrimitiveParams(
  id: PrimitiveId,
  saved: Record<string, number> | undefined,
  advanced: boolean,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of PRIMITIVE_PARAMS[id]) {
    const raw = saved?.[spec.key];
    const [min, max] = advanced && spec.wide ? spec.wide : [spec.min, spec.max];
    out[spec.key] = typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(max, Math.max(min, raw))
      : spec.def;
  }
  return out;
}

/**
 * Нейтральная настройка примитива — ровно его дефолты.
 *
 * Именно per-id, а не один общий словарь: ключи у разных примитивов
 * совпадают по имени при разном смысле (`depth` у ландшафта — 120 кадров
 * истории, у L-системы — 5 уровней ветвления), и общий словарь их бы смешал.
 */
export function neutralTuning(id: PrimitiveId): Tuning {
  return defaultPrimitiveParams(id);
}
