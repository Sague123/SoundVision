/**
 * Локальный WebSocket-мост между расширением YouTube Music и визуализатором.
 *
 * Роли различаются по первому сообщению `hello`. Всё, что приходит от
 * расширения, рассылается визуализаторам; последнее состояние запоминается,
 * чтобы только что открытая вкладка сразу увидела текущий трек.
 *
 * Слушаем только 127.0.0.1: наружу мост не смотрит.
 */

import { WebSocketServer, type WebSocket } from 'ws';

const PORT = Number(process.env.SOUNDVISION_BRIDGE_PORT ?? 8787);
const HOST = '127.0.0.1';

type Role = 'extension' | 'visualizer' | 'unknown';

interface Client {
  socket: WebSocket;
  role: Role;
}

const clients = new Set<Client>();
let lastState: string | null = null;

const server = new WebSocketServer({ port: PORT, host: HOST });

server.on('connection', (socket) => {
  const client: Client = { socket, role: 'unknown' };
  clients.add(client);

  // Новый визуализатор должен сразу получить текущее состояние, а не ждать
  // следующего тика расширения.
  if (lastState) socket.send(lastState);

  socket.on('message', (raw) => {
    const text = raw.toString();
    let message: { type?: string; role?: string };
    try {
      message = JSON.parse(text) as { type?: string; role?: string };
    } catch {
      return;
    }

    if (message.type === 'hello') {
      client.role = message.role === 'extension' ? 'extension' : 'visualizer';
      log(`подключён ${client.role}`);
      return;
    }

    if (message.type === 'now-playing' || message.type === 'stopped') {
      client.role = 'extension';
      lastState = text;
      broadcast(text, client);
    }
  });

  socket.on('close', () => {
    clients.delete(client);
  });

  socket.on('error', (err) => {
    log(`ошибка сокета: ${err.message}`);
    clients.delete(client);
  });
});

server.on('listening', () => {
  log(`мост слушает ws://${HOST}:${PORT}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`порт ${PORT} занят — вероятно, мост уже запущен`);
    process.exit(1);
  }
  throw err;
});

function broadcast(payload: string, from: Client): void {
  for (const client of clients) {
    if (client === from) continue;
    if (client.socket.readyState !== client.socket.OPEN) continue;
    client.socket.send(payload);
  }
}

function log(message: string): void {
  console.log(`[soundvision-bridge] ${message}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('остановка');
    server.close(() => process.exit(0));
  });
}
