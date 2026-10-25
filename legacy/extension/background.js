/**
 * Фоновый service worker: держит WebSocket к локальному мосту и пересылает
 * туда всё, что присылает content script: название и позицию трека JSON-ом,
 * кадры звука — двоичными сообщениями.
 *
 * Почему сокет живёт здесь, а не в content script: CSP страницы
 * music.youtube.com блокирует исходящие соединения на localhost, а запросы
 * из service worker расширения ей не подчиняются.
 */

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8787';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

let socket = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let pending = null;

async function bridgeUrl() {
  const stored = await chrome.storage.local.get('bridgeUrl');
  return stored.bridgeUrl || DEFAULT_BRIDGE_URL;
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const url = await bridgeUrl();
  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.warn('[SoundVision] мост недоступен:', err);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
    socket.send(JSON.stringify({ type: 'hello', role: 'extension' }));
    if (pending) send(pending);
  });

  socket.addEventListener('close', () => {
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // close придёт следом и запустит переподключение.
  });
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(payload) {
  pending = payload;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connect();
    return;
  }
  socket.send(JSON.stringify(payload));
}

/** Больше этого в очереди сокета — мост не успевает, кадр звука пропускаем. */
const MAX_BUFFERED_BYTES = 256 * 1024;

/** base64 → байты: сообщения расширения ходят JSON-ом, а в мост — двоичным. */
function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Кадры звука идут по долгоживущему порту: 60 отдельных sendMessage в
// секунду заметно дороже, а открытый порт ещё и держит service worker живым.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'soundvision-audio') return;
  port.onMessage.addListener((message) => {
    if (message?.kind !== 'soundvision:audio' || typeof message.data !== 'string') return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connect();
      return;
    }
    // Звук из прошлого картинке не нужен: при заторе кадр выбрасываем.
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    socket.send(decodeBase64(message.data));
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind !== 'soundvision:update') return;
  send(message.payload);
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
