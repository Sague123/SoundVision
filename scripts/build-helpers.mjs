// Собирает помощника «Сейчас играет» для текущей системы и кладёт в
// helpers-bin/<win|mac>/, откуда его берут и разработка, и сборщик.
//
//   node scripts/build-helpers.mjs
//
// Нужны: на Windows — .NET 8 SDK; на macOS — Swift (Xcode Command Line Tools).

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Команда завершилась с кодом ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

if (process.platform === 'win32') {
  const project = join(root, 'helpers', 'windows', 'NowPlaying');
  const out = join(root, 'helpers-bin', 'win');
  mkdirSync(out, { recursive: true });
  run('dotnet', ['publish', '-c', 'Release', '-o', join(project, 'publish')], project);
  copyFileSync(join(project, 'publish', 'NowPlaying.exe'), join(out, 'NowPlaying.exe'));
  console.log(`Готово: ${join(out, 'NowPlaying.exe')}`);
} else if (process.platform === 'darwin') {
  const project = join(root, 'helpers', 'macos', 'NowPlaying');
  const out = join(root, 'helpers-bin', 'mac');
  mkdirSync(out, { recursive: true });
  // Универсальный бинарник: приложение собирается под arm64, но помощник
  // не должен зависеть от того, на каком Mac его собрали.
  run('swift', ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64'], project);
  const built = join(project, '.build', 'apple', 'Products', 'Release', 'NowPlayingHelper');
  if (!existsSync(built)) {
    console.error(`Не нашёл собранный файл: ${built}`);
    process.exit(1);
  }
  const target = join(out, 'NowPlayingHelper');
  copyFileSync(built, target);
  chmodSync(target, 0o755);
  console.log(`Готово: ${target}`);
} else {
  console.log(`Для ${process.platform} помощника нет: «Сейчас играет» там не поддерживается.`);
}
