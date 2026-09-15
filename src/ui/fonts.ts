/**
 * Гарнитуры под характер трека.
 *
 * Треки могут быть русскими, поэтому поддержка кириллицы обязательна — но
 * доверять списку на слово нельзя: часть популярных гарнитур кириллицы не
 * содержит, и браузер молча подставит запасную. Поэтому каждая гарнитура
 * проверяется в рантайме измерением ширины кириллической строки: если она
 * совпадает с запасной, значит шрифт не применился, и мы им не пользуемся.
 *
 * Variable fonts важны отдельно: только они позволяют плавно вести вес под
 * энергию, а не переключать начертания ступенями.
 */

export type FontMoodKey = 'rock' | 'electronic' | 'major' | 'minor' | 'glitch';

export interface FontChoice {
  id: FontMoodKey;
  name: string;
  /** Что уходит в CSS font-family. */
  stack: string;
  /** Семейство для запроса в Google Fonts. */
  family: string;
  /** Поддерживает ли плавную анимацию веса. */
  variable: boolean;
  /** Диапазон веса, который можно вести энергией. */
  weightRange: [number, number];
  /** Капслок — часть характера, а не отдельная настройка. */
  uppercase: boolean;
  /** Базовый трекинг в em. */
  tracking: number;
  italic: boolean;
  description: string;
}

export const FONT_CHOICES: FontChoice[] = [
  {
    id: 'rock',
    // Archivo из спецификации отпал: проверка показала, что кириллицы в нём нет.
    // Oswald закрывает ту же роль — узкий, тяжёлый, хорош капсом — и кириллицу
    // содержит.
    name: 'Oswald',
    family: 'Oswald:wght@200..700',
    stack: "'Oswald', 'Archivo Narrow', 'Arial Narrow', system-ui, sans-serif",
    variable: true,
    weightRange: [500, 700],
    uppercase: true,
    tracking: 0.02,
    italic: false,
    description: 'Рок и агрессия: узкий, плотный, жёсткий',
  },
  {
    id: 'electronic',
    name: 'Unbounded',
    family: 'Unbounded:wght@200..900',
    stack: "'Unbounded', 'Space Grotesk', system-ui, sans-serif",
    variable: true,
    weightRange: [300, 800],
    uppercase: false,
    tracking: 0.08,
    italic: false,
    description: 'Электроника: геометричный, холодный, широкий трекинг',
  },
  {
    id: 'major',
    name: 'Inter',
    family: 'Inter:opsz,wght@14..32,300..800',
    stack: "'Inter', 'Manrope', system-ui, sans-serif",
    variable: true,
    weightRange: [400, 750],
    uppercase: false,
    tracking: 0,
    italic: false,
    description: 'Мажор и лёгкое: нейтральный, чистый',
  },
  {
    id: 'minor',
    name: 'Cormorant',
    family: 'Cormorant:ital,wght@0,300..700;1,300..700',
    stack: "'Cormorant', 'Playfair Display', Georgia, serif",
    variable: true,
    weightRange: [400, 700],
    uppercase: false,
    tracking: 0.01,
    italic: true,
    description: 'Минор и меланхолия: контрастная антиква, драматичная',
  },
  {
    id: 'glitch',
    name: 'JetBrains Mono',
    family: 'JetBrains+Mono:wght@300..800',
    stack: "'JetBrains Mono', ui-monospace, monospace",
    variable: true,
    weightRange: [400, 800],
    uppercase: false,
    tracking: 0.02,
    italic: false,
    description: 'Эксперимент и глитч: моноширинный, технический',
  },
];

/**
 * Гарнитуры, у которых кириллица подтвердилась в этом запуске.
 * Пока проверка не прошла, считаем пригодными все: иначе до её завершения
 * текст остался бы вообще без гарнитуры.
 */
const usable = new Set<FontMoodKey>(FONT_CHOICES.map((choice) => choice.id));

/** Гарнитура на случай, если ни одна выбранная не подошла. */
export const FALLBACK_STACK = "system-ui, 'Segoe UI', Roboto, sans-serif";

const GOOGLE_FONTS_BASE = 'https://fonts.googleapis.com/css2';
/** Сколько ждём таблицу стилей, прежде чем признать гарнитуры недоступными. */
const STYLESHEET_TIMEOUT_MS = 8000;
/** Строка с буквами, которых нет в латинице: по ней и проверяем кириллицу. */
const CYRILLIC_PROBE = 'Ждёшь щупальце Юлия';

export interface FontReport {
  id: FontMoodKey;
  name: string;
  loaded: boolean;
  cyrillic: boolean;
}

/**
 * Подключает гарнитуры и проверяет каждую на кириллицу.
 * @returns отчёт по каждой — им пользуется дев-страница и панель настроек.
 */
export async function loadFonts(): Promise<FontReport[]> {
  const families = FONT_CHOICES.map((choice) => `family=${choice.family}`).join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // display=swap: текст не должен пропадать, пока грузится гарнитура.
  link.href = `${GOOGLE_FONTS_BASE}?${families}&display=swap&subset=cyrillic,latin`;

  // Дождаться разбора таблицы стилей обязательно: document.fonts.load не ждёт
  // её сам и на неразобранной таблице молча возвращает пустой список — то есть
  // «шрифт не загрузился» вместо реальной проверки.
  const stylesheetReady = new Promise<boolean>((resolve) => {
    link.addEventListener('load', () => resolve(true), { once: true });
    link.addEventListener('error', () => resolve(false), { once: true });
    window.setTimeout(() => resolve(false), STYLESHEET_TIMEOUT_MS);
  });
  document.head.append(link);
  await stylesheetReady;

  const reports: FontReport[] = [];
  for (const choice of FONT_CHOICES) {
    let loaded = false;
    try {
      // Ждём именно ту гарнитуру: document.fonts.load возвращает применённые.
      const faces = await document.fonts.load(`700 32px ${JSON.stringify(choice.name)}`, CYRILLIC_PROBE);
      loaded = faces.length > 0;
    } catch {
      loaded = false;
    }
    reports.push({ id: choice.id, name: choice.name, loaded, cyrillic: loaded && hasCyrillic(choice.name) });
  }
  usable.clear();
  for (const item of reports) if (item.cyrillic) usable.add(item.id);
  // Если не подтвердилась ни одна, оставляем все: системный запасной шрифт
  // кириллицу почти наверняка нарисует, а совсем без гарнитуры хуже.
  if (usable.size === 0) for (const choice of FONT_CHOICES) usable.add(choice.id);
  return reports;
}

/**
 * Проверка кириллицы измерением.
 *
 * Если гарнитура не содержит нужных глифов, браузер подставит запасную, и
 * ширина совпадёт с запасной до пикселя. Разница в ширине — доказательство,
 * что рисует именно запрошенный шрифт.
 */
export function hasCyrillic(family: string): boolean {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const measure = (font: string): number => {
    ctx.font = font;
    return ctx.measureText(CYRILLIC_PROBE).width;
  };

  // monospace и serif как две независимые базы: совпасть с обеими случайно
  // практически невозможно, а совпадение с одной ещё ничего не доказывает.
  const mono = measure('32px monospace');
  const serif = measure('32px serif');
  const target = measure(`32px ${JSON.stringify(family)}, monospace`);
  const targetSerif = measure(`32px ${JSON.stringify(family)}, serif`);

  // Шрифт применился, если обе подстановки дали одинаковый результат и он
  // отличается хотя бы от одной из баз.
  const consistent = Math.abs(target - targetSerif) < 0.5;
  const distinct = Math.abs(target - mono) > 0.5 || Math.abs(targetSerif - serif) > 0.5;
  return consistent && distinct;
}

/** Выбор гарнитуры по характеру трека. */
export function chooseFont(mood: {
  noisiness: number;
  brightness: number;
  energy: number;
  bpm: number;
  mode: 'major' | 'minor';
}): FontMoodKey {
  // Порядок проверок — от самого характерного к нейтральному.
  if (mood.noisiness > 0.75) return 'glitch';
  if (mood.noisiness > 0.5 && mood.energy > 0.55) return 'rock';
  if (mood.brightness > 0.55 && mood.bpm > 118) return 'electronic';
  if (mood.mode === 'minor') return 'minor';
  return 'major';
}

/**
 * Гарнитура по идентификатору — но только из подтверждённых.
 *
 * Проверка кириллицы здесь не совет, а фильтр: если у выбранной гарнитуры
 * нужных глифов нет, русский текст молча уехал бы в запасной шрифт и потерял
 * заданный характер. Лучше сразу взять другую подходящую.
 */
export function findFont(id: FontMoodKey): FontChoice {
  const requested = FONT_CHOICES.find((choice) => choice.id === id);
  if (requested && usable.has(requested.id)) return requested;
  const fallback = FONT_CHOICES.find((choice) => usable.has(choice.id));
  return fallback ?? FONT_CHOICES[2];
}

/** Подтвердилась ли кириллица у гарнитуры — нужно панели настроек. */
export function isFontUsable(id: FontMoodKey): boolean {
  return usable.has(id);
}
