/**
 * Где лежит помощник «Сейчас играет».
 *
 * В собранном приложении — в `resources/helpers/`, куда его кладёт сборщик.
 * При разработке — в `helpers-bin/<система>/`, куда его кладёт скрипт сборки
 * помощников. Не нашли — это не падение, а понятная причина для отчёта.
 */

import { join } from 'node:path';

export interface HelperSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  label: string;
}

export interface ResolveOptions {
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  /** Корень проекта (`app.getAppPath()`). */
  appPath: string;
  fake: boolean;
  /** Путь к исполняемому файлу Electron — запускает заглушку как Node. */
  execPath: string;
  exists: (path: string) => boolean;
}

export type Resolved = { spec: HelperSpec; reason?: undefined } | { spec?: undefined; reason: string };

export const HELPER_FILE: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'NowPlaying.exe',
  darwin: 'NowPlayingHelper',
};

export function resolveHelper(options: ResolveOptions): Resolved {
  if (options.fake) {
    const script = options.packaged
      ? join(options.resourcesPath, 'helpers', 'fake-now-playing.mjs')
      : join(options.appPath, 'helpers', 'fake', 'now-playing.mjs');
    if (!options.exists(script)) return { reason: `заглушка не найдена: ${script}` };
    return {
      spec: { command: options.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'fake' },
    };
  }

  const file = HELPER_FILE[options.platform];
  if (!file) {
    return { reason: `«Сейчас играет» для системы ${options.platform} не поддерживается` };
  }
  const folder = options.platform === 'win32' ? 'win' : 'mac';
  const path = options.packaged
    ? join(options.resourcesPath, 'helpers', file)
    : join(options.appPath, 'helpers-bin', folder, file);
  if (!options.exists(path)) {
    return {
      reason: options.packaged
        ? `помощник не вошёл в сборку: ${path}`
        : `помощник не собран: ${path} (npm run helpers)`,
    };
  }
  return { spec: { command: path, args: [], env: {}, label: file } };
}
