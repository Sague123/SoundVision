// Запускает помощника «Сейчас играет» на несколько секунд и проверяет, что он
// живой: представился и не упал. Что именно играет — неважно; на сборочной
// машине обычно «ничего». Печатает всё, что сказал помощник.
//
//   node scripts/helper-smoke.mjs <путь-к-помощнику> [секунд]

import { spawn } from 'node:child_process';

const [, , path, secondsArg] = process.argv;
if (!path) {
  console.error('Укажите путь к помощнику');
  process.exit(2);
}
const seconds = Number(secondsArg ?? 5);

// stdin держим открытым: закрытие — сигнал помощнику завершиться.
const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const lines = [];
let stderr = '';
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  const parts = buffer.split(/\r?\n/);
  buffer = parts.pop() ?? '';
  for (const line of parts) if (line.trim()) lines.push(line.trim());
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
if (!exited) child.kill();

const messages = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } });
const hello = messages.find((m) => m?.type === 'hello');
const types = [...new Set(messages.filter(Boolean).map((m) => m.type))];
console.log(`строк: ${lines.length}, типы: ${types.join(', ') || '—'}`);
for (const line of lines.slice(0, 6)) console.log(`  ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
if (stderr.trim()) console.log(`stderr: ${stderr.trim().slice(0, 600)}`);
for (const m of messages) if (m?.type === 'error') console.log(`::warning::помощник сообщил об ошибке: ${m.message} (${m.code ?? '—'})`);

if (exited) {
  console.log(`::error::помощник завершился сам за ${seconds} с: ${JSON.stringify(exited)}`);
  process.exit(1);
}
if (!hello) {
  console.log('::error::помощник не представился (нет сообщения hello)');
  process.exit(1);
}
console.log(`::notice::помощник живой: ${hello.helper} v${hello.version}; сообщения: ${types.join(', ')}`);
