/**
 * Пресеты: полный снимок всех настроек с именем и меткой времени.
 *
 * План просил хранить их в файле конфига (`%APPDATA%`). Это возможно только в
 * Electron; здесь приложение живёт в браузерной вкладке и до файловой системы
 * не дотягивается. Честный эквивалент — localStorage плюс экспорт и импорт
 * JSON: снимок так же переносится на другую машину и так же бэкапится, просто
 * файл сохраняет пользователь, а не программа.
 */

import { defaultSettings, mergeSettings, PRESET_PROFILES, type Settings } from '../settings.ts';

const STORAGE_CURRENT = 'soundvision.settings';
const STORAGE_PRESETS = 'soundvision.presets';
/** Какой пресет был выбран последним — от него считается «изменено». */
const STORAGE_ACTIVE = 'soundvision.preset.active';

/** Версия формата: импорт из будущей версии не должен молча ломать настройки. */
export const PRESET_FORMAT = 2;

export interface StoredPreset {
  name: string;
  settings: Settings;
  savedAt: number;
  /** Встроенные не удаляются и не перезаписываются. */
  builtIn?: boolean;
}

export interface PresetFile {
  format: number;
  app: 'soundvision';
  exportedAt: number;
  presets: Array<{ name: string; savedAt: number; settings: Settings }>;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_CURRENT);
    return raw ? mergeSettings(JSON.parse(raw)) : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_CURRENT, JSON.stringify(settings));
  } catch (err) {
    // Приватный режим или переполненное хранилище — настройки просто не переживут перезапуск.
    console.warn('[presets] не удалось сохранить настройки:', err);
  }
}

/** Встроенные пресеты: не хранятся, а собираются поверх дефолтов. */
export function builtInPresets(): StoredPreset[] {
  return PRESET_PROFILES.map((preset) => ({
    name: preset.name,
    settings: presetSettings(preset.id) ?? defaultSettings(),
    savedAt: 0,
    builtIn: true,
  }));
}

export function presetSettings(id: string): Settings | null {
  const preset = PRESET_PROFILES.find((profile) => profile.id === id);
  if (!preset) return null;
  const settings = defaultSettings();
  preset.apply(settings);
  return settings;
}

export function listPresets(): StoredPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_PRESETS)
      // Пресеты выросли из профилей — старый ключ читаем, чтобы не потерять
      // сохранённое пользователем при обновлении.
      ?? localStorage.getItem('soundvision.profiles');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredPreset[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalize).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function savePreset(name: string, settings: Settings): StoredPreset[] {
  const trimmed = name.trim();
  if (!trimmed) return listPresets();

  const presets = listPresets().filter((preset) => preset.name !== trimmed);
  presets.push({ name: trimmed, settings: structuredClone(settings), savedAt: Date.now() });
  presets.sort((a, b) => a.name.localeCompare(b.name));
  persist(presets);
  setActivePreset(trimmed);
  return presets;
}

export function renamePreset(from: string, to: string): StoredPreset[] {
  const trimmed = to.trim();
  const presets = listPresets();
  const target = presets.find((preset) => preset.name === from);
  if (!target || !trimmed) return presets;

  const rest = presets.filter((preset) => preset.name !== from && preset.name !== trimmed);
  rest.push({ ...target, name: trimmed });
  rest.sort((a, b) => a.name.localeCompare(b.name));
  persist(rest);
  if (activePreset() === from) setActivePreset(trimmed);
  return rest;
}

export function deletePreset(name: string): StoredPreset[] {
  const presets = listPresets().filter((preset) => preset.name !== name);
  persist(presets);
  if (activePreset() === name) setActivePreset(null);
  return presets;
}

/** Имя пресета, от которого считается «изменено». */
export function activePreset(): string | null {
  try {
    return localStorage.getItem(STORAGE_ACTIVE);
  } catch {
    return null;
  }
}

export function setActivePreset(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(STORAGE_ACTIVE);
    else localStorage.setItem(STORAGE_ACTIVE, name);
  } catch {
    // Без хранилища индикация «изменено» просто не переживёт перезагрузку.
  }
}

/** Настройки активного пресета — встроенного или пользовательского. */
export function activePresetSettings(): Settings | null {
  const name = activePreset();
  if (name === null) return null;
  const found = [...builtInPresets(), ...listPresets()].find((preset) => preset.name === name);
  return found ? found.settings : null;
}

/**
 * Изменены ли настройки относительно активного пресета.
 *
 * Сравниваем сериализованные снимки: настройки — простой JSON без функций и
 * циклов, и порядок ключей у обоих объектов один, потому что оба собраны
 * `mergeSettings` поверх одних и тех же дефолтов.
 */
export function isModified(settings: Settings): boolean {
  const base = activePresetSettings();
  if (!base) return false;
  return JSON.stringify(base) !== JSON.stringify(settings);
}

/** Снимок для выгрузки в файл. */
export function exportPresets(presets: StoredPreset[]): string {
  const file: PresetFile = {
    format: PRESET_FORMAT,
    app: 'soundvision',
    exportedAt: Date.now(),
    presets: presets.map((preset) => ({
      name: preset.name,
      savedAt: preset.savedAt,
      settings: preset.settings,
    })),
  };
  return JSON.stringify(file, null, 2);
}

export interface ImportResult {
  added: string[];
  /** Почему импорт не удался; пусто — всё хорошо. */
  error: string | null;
}

/**
 * Разбор выгруженного файла. Чужой или битый JSON не должен стереть то, что
 * уже сохранено, поэтому до записи проверяется и формат, и каждый пресет.
 */
export function importPresets(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { added: [], error: 'Это не JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { added: [], error: 'Файл пуст или не является объектом' };
  }
  const file = parsed as Partial<PresetFile>;
  if (file.app !== 'soundvision') {
    return { added: [], error: 'Файл не от SoundVision' };
  }
  if (typeof file.format !== 'number' || file.format > PRESET_FORMAT) {
    return { added: [], error: `Формат ${String(file.format)} новее, чем понимает эта версия` };
  }
  if (!Array.isArray(file.presets) || file.presets.length === 0) {
    return { added: [], error: 'В файле нет пресетов' };
  }

  const existing = listPresets();
  const added: string[] = [];
  for (const entry of file.presets) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    // mergeSettings дополняет дефолтами: пресет из старой версии не уронит рендер.
    const settings = mergeSettings(entry.settings);
    const name = uniqueName(entry.name.trim(), existing);
    existing.push({ name, settings, savedAt: Number(entry.savedAt) || Date.now() });
    added.push(name);
  }
  if (added.length === 0) return { added: [], error: 'Ни один пресет не удалось прочитать' };

  existing.sort((a, b) => a.name.localeCompare(b.name));
  persist(existing);
  return { added, error: null };
}

/** Импорт не затирает одноимённый пресет: к имени добавляется номер. */
function uniqueName(name: string, presets: StoredPreset[]): string {
  if (!presets.some((preset) => preset.name === name)) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name} (${n})`;
    if (!presets.some((preset) => preset.name === candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
}

function normalize(preset: StoredPreset): StoredPreset {
  return {
    name: String(preset.name),
    settings: mergeSettings(preset.settings),
    savedAt: Number(preset.savedAt) || 0,
  };
}

function persist(presets: StoredPreset[]): void {
  try {
    localStorage.setItem(STORAGE_PRESETS, JSON.stringify(presets));
  } catch (err) {
    console.warn('[presets] не удалось сохранить пресет:', err);
  }
}
