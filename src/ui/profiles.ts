/**
 * Профили настроек в localStorage: последний рабочий набор восстанавливается
 * сам, именованные сохраняются и загружаются вручную.
 */

import { defaultSettings, mergeSettings, PRESET_PROFILES, type Settings } from '../settings.ts';

const STORAGE_CURRENT = 'soundvision.settings';
const STORAGE_PROFILES = 'soundvision.profiles';

export interface StoredProfile {
  name: string;
  settings: Settings;
  savedAt: number;
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
    console.warn('[profiles] не удалось сохранить настройки:', err);
  }
}

export function listProfiles(): StoredProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_PROFILES);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredProfile[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((profile) => ({
      name: String(profile.name),
      settings: mergeSettings(profile.settings),
      savedAt: Number(profile.savedAt) || 0,
    }));
  } catch {
    return [];
  }
}

export function saveProfile(name: string, settings: Settings): StoredProfile[] {
  const trimmed = name.trim();
  if (!trimmed) return listProfiles();

  const profiles = listProfiles().filter((profile) => profile.name !== trimmed);
  profiles.push({ name: trimmed, settings: structuredClone(settings), savedAt: Date.now() });
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  persist(profiles);
  return profiles;
}

export function deleteProfile(name: string): StoredProfile[] {
  const profiles = listProfiles().filter((profile) => profile.name !== name);
  persist(profiles);
  return profiles;
}

/** Стартовые шаблоны из плана — они не хранятся, а собираются поверх дефолтов. */
export function presetSettings(id: string): Settings | null {
  const preset = PRESET_PROFILES.find((profile) => profile.id === id);
  if (!preset) return null;
  const settings = defaultSettings();
  preset.apply(settings);
  return settings;
}

function persist(profiles: StoredProfile[]): void {
  try {
    localStorage.setItem(STORAGE_PROFILES, JSON.stringify(profiles));
  } catch (err) {
    console.warn('[profiles] не удалось сохранить профиль:', err);
  }
}
