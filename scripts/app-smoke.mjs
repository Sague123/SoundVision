// Запускает собранное приложение с самопроверкой и печатает итоги отчёта.
// Проверяет цепочку «запуск → интерфейс → воркер → помощник → отчёт» на
// настоящей сборке; звук берётся тестовый, потому что на сборочной машине
// нет ни музыки, ни права на захват.
//
//   node scripts/app-smoke.mjs <путь-к-исполняемому> <файл-отчёта>

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const [, , binary, reportPath] = process.argv;
if (!binary || !reportPath) {
  console.error('Использование: app-smoke.mjs <исполняемый> <отчёт.json>');
  process.exit(2);
}
rmSync(reportPath, { force: true });

// Для проверки вне сборки: SMOKE_PREARGS='.' запускает electron . , SMOKE_EXTRA='--fake-helper' добавляет флаги.
const pre = (process.env.SMOKE_PREARGS ?? '').split(' ').filter(Boolean);
const extra = (process.env.SMOKE_EXTRA ?? '').split(' ').filter(Boolean);
const args = [...pre, ...extra, '--selfcheck-exit', '--audio=test', '--windowed', `--report=${reportPath}`];
if (process.platform === 'linux') args.push('--no-sandbox');
const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

const code = await new Promise((resolve) => {
  const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 150_000);
  child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
});
console.log(`приложение завершилось: ${code}`);

if (!existsSync(reportPath)) {
  console.log(output.split('\n').slice(-25).join('\n'));
  console.log('::error::отчёт самопроверки не появился');
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
console.log(`отчёт за ${report.durationMs} мс; ${report.app.platform} ${report.app.arch}, ОС ${report.app.osRelease}`);
for (const check of report.checks) {
  const level = check.status === 'fail' ? 'warning' : 'notice';
  console.log(`::${level}::[${check.status}] ${check.title}: ${check.summary.slice(0, 500)}`);
}
const audio = report.checks.find((c) => c.id === 'audio');
const helper = report.checks.find((c) => c.id === 'helper');
// Цепочка должна работать всегда: тестовый звук прошёл воркер, помощник представился.
let broken = false;
if (audio?.status !== 'info' || !(audio.data?.workletRateHz > 20)) { console.log('::error::воркер не отдаёт уровни'); broken = true; }
if (helper?.status !== 'pass') { console.log('::error::помощник «Сейчас играет» не работает в собранном приложении'); broken = true; }
process.exit(broken ? 1 : 0);
