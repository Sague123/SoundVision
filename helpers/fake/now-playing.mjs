// Заглушка помощника «Сейчас играет»: те же сообщения, что у настоящих
// помощников, но трек выдуманный. Нужна, чтобы гонять всю цепочку на машине,
// где настоящего помощника нет (Linux, сборочный сервер).
//
// Запуск: node helpers/fake/now-playing.mjs
// Переменные: FAKE_EXIT_AFTER_MS — упасть через столько мс (проверка перезапуска),
//             FAKE_NO_COVER=1 — не слать обложки.

const TRACKS = [
  { artist: 'Тестовый артист', title: 'Первая композиция', album: 'Альбом А', app: 'Spotify', durationMs: 212_000, hue: 330 },
  { artist: 'Другой артист', title: 'Вторая композиция', album: 'Альбом Б', app: 'Chrome', durationMs: 187_000, hue: 200 },
  { artist: 'Третий артист', title: 'Третья композиция', album: 'Альбом В', app: 'Spotify', durationMs: 243_000, hue: 40 },
];

function cover(hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,28%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},85%,58%)"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><circle cx="320" cy="300" r="120" fill="hsla(${hue},30%,96%,0.85)"/></svg>`;
  return Buffer.from(svg).toString('base64');
}

const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
out({ type: 'hello', helper: 'fake', version: '1' });

let index = 0;
let startedAt = Date.now();
let coverSent = false;

function tick() {
  const track = TRACKS[index % TRACKS.length];
  let position = Date.now() - startedAt;
  if (position >= track.durationMs) {
    index++;
    startedAt = Date.now();
    position = 0;
    coverSent = false;
  }
  const sendCover = !coverSent && process.env.FAKE_NO_COVER !== '1';
  coverSent = true;
  out({
    type: 'track', artist: track.artist, title: track.title, album: track.album, app: track.app,
    durationMs: track.durationMs, positionMs: position, positionAt: Date.now(), isPlaying: true,
    cover: sendCover ? cover(track.hue) : null, coverMime: sendCover ? 'image/svg+xml' : null,
  });
}

tick();
setInterval(tick, 1000);

if (process.env.FAKE_EXIT_AFTER_MS) setTimeout(() => process.exit(3), Number(process.env.FAKE_EXIT_AFTER_MS));
