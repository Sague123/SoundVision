/**
 * Настройки приложения: один маленький JSON в папке данных. Читается
 * терпимо (битый файл — значения по умолчанию), пишется атомарно: сначала во
 * временный файл, потом переименованием, чтобы обрыв питания не оставил
 * полфайла.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AppConfig {
  /** Идентификатор монитора, на котором идёт шоу. */
  displayId: number | null;
  /** Показывать ли отладочную панель при запуске. */
  showPanel: boolean;
}

export const DEFAULT_CONFIG: AppConfig = { displayId: null, showPanel: true };

export function loadConfig(file: string): AppConfig {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
    return {
      displayId: typeof raw.displayId === 'number' && Number.isFinite(raw.displayId) ? raw.displayId : null,
      showPanel: typeof raw.showPanel === 'boolean' ? raw.showPanel : DEFAULT_CONFIG.showPanel,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(file: string, config: AppConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2));
  renameSync(temp, file);
}
