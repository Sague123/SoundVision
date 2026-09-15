/**
 * Карточка «сейчас играет».
 *
 * Появляется на смену трека, держится несколько секунд и уходит — либо живёт
 * постоянно мелко в углу. Компоновка взята из референса: угол, компактно,
 * название крупнее и ярче, артист мельче капителью, полоса прогресса по
 * кромке и таймкод справа. Если текст песни стоит у той же кромки, карточка
 * сама уезжает к противоположной: две плашки в одном углу друг друга
 * перекрывают.
 */

import type { NowPlayingTrack } from '../cover/now-playing.ts';
import type { Settings } from '../settings.ts';

const SOURCE_LABELS: Record<NowPlayingTrack['source'], string> = {
  spotify: 'Spotify',
  'youtube-music': 'YouTube Music',
};

export class NowPlayingCard {
  readonly element = document.createElement('div');
  /** Линия прогресса живёт отдельно: она по кромке экрана, а не в карточке. */
  readonly progressLine = document.createElement('div');

  private readonly cover = document.createElement('img');
  private readonly title = document.createElement('div');
  private readonly artist = document.createElement('div');
  private readonly source = document.createElement('div');
  private readonly time = document.createElement('div');
  private readonly progressBar = document.createElement('div');
  private renderedKey = '';
  private shownAt = -Infinity;

  constructor() {
    this.element.className = 'now-playing now-playing--hidden';
    this.cover.className = 'now-playing__cover';
    this.cover.alt = '';

    this.title.className = 'now-playing__title';
    this.artist.className = 'now-playing__artist';
    this.source.className = 'now-playing__source';

    this.time.className = 'now-playing__time';

    const text = document.createElement('div');
    text.className = 'now-playing__text';
    text.append(this.title, this.artist, this.source);
    this.element.append(this.cover, text, this.time);

    this.progressLine.className = 'track-progress track-progress--hidden';
    this.progressBar.className = 'track-progress__bar';
    this.progressLine.append(this.progressBar);
  }

  update(track: NowPlayingTrack | null, settings: Settings, nowMs: number): void {
    const mode = settings.cover.card;
    const key = track ? `${track.artist}|${track.title}` : '';

    if (key !== this.renderedKey) {
      this.renderedKey = key;
      this.shownAt = nowMs;
      if (track) this.render(track);
    }

    // При смене трека карточка живёт заданное время; в режиме «всегда» — постоянно.
    const withinHold = nowMs - this.shownAt < settings.cover.cardHoldSec * 1000;
    const visible = Boolean(track) && mode !== 'never' && (mode === 'always' || withinHold);

    this.element.classList.toggle('now-playing--hidden', !visible);
    // Мелкий вариант — для постоянного показа: он не должен спорить с картинкой.
    this.element.classList.toggle('now-playing--compact', mode === 'always' && !withinHold);
    // Угол задаётся настройкой, но текст песни сильнее: две плашки в одном
    // углу перекрывают друг друга, и уступает та, что менее важна.
    const corner = cornerFor(settings);
    for (const name of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      this.element.classList.toggle(`now-playing--${name}`, name === corner);
    }
    // Полоса прогресса идёт по той же кромке, у которой стоит карточка.
    this.progressLine.classList.toggle('track-progress--bottom', corner.startsWith('bottom'));

    this.updateProgress(track, settings);
  }

  private render(track: NowPlayingTrack): void {
    this.title.textContent = track.title;
    this.artist.textContent = track.artist;
    this.source.textContent = SOURCE_LABELS[track.source];
    if (track.coverUrl) {
      this.cover.src = track.coverUrl;
      this.cover.hidden = false;
    } else {
      this.cover.removeAttribute('src');
      this.cover.hidden = true;
    }

    // Перезапуск анимации входа: без reflow браузер переиспользует старую.
    this.element.classList.remove('now-playing--enter');
    void this.element.offsetWidth;
    this.element.classList.add('now-playing--enter');
  }

  private updateProgress(track: NowPlayingTrack | null, settings: Settings): void {
    const show = Boolean(track) && track!.durationMs > 0
      && settings.cover.progressLine && settings.cover.card !== 'never';
    this.progressLine.classList.toggle('track-progress--hidden', !show);
    if (!show || !track) return;
    const ratio = Math.min(1, track.progressMs / track.durationMs);
    this.progressBar.style.transform = `scaleX(${ratio.toFixed(4)})`;
    this.time.textContent = `${clock(track.progressMs)} / ${clock(track.durationMs)}`;
  }
}

/**
 * Угол карточки. Настройка задаёт желаемый, но если там же стоит текст песни,
 * карточка уходит на противоположную кромку: перекрывать текст она не должна.
 */
function cornerFor(settings: Settings): Settings['cover']['cardCorner'] {
  const wanted = settings.cover.cardCorner;
  if (!settings.lyrics.enabled) return wanted;
  const side = wanted.endsWith('left') ? 'left' : 'right';
  if (settings.lyrics.position === 'bottom' && wanted.startsWith('bottom')) return `top-${side}`;
  if (settings.lyrics.position === 'top' && wanted.startsWith('top')) return `bottom-${side}`;
  return wanted;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}
