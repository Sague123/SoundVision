/**
 * Карточка «сейчас играет».
 *
 * Появляется на смену трека, держится несколько секунд и уходит — либо живёт
 * постоянно мелко в углу. Если текст песни стоит внизу, карточка сама уезжает
 * наверх: две плашки в одном углу друг друга перекрывают.
 */

import type { NowPlayingTrack } from '../cover/now-playing.ts';
import type { Settings } from '../settings.ts';

const SOURCE_LABELS: Record<NowPlayingTrack['source'], string> = {
  spotify: 'Spotify',
  'youtube-music': 'YouTube Music',
};

/** Сколько карточка держится на экране после смены трека. */
const HOLD_MS = 7000;

export class NowPlayingCard {
  readonly element = document.createElement('div');
  /** Линия прогресса живёт отдельно: она по кромке экрана, а не в карточке. */
  readonly progressLine = document.createElement('div');

  private readonly cover = document.createElement('img');
  private readonly title = document.createElement('div');
  private readonly artist = document.createElement('div');
  private readonly source = document.createElement('div');
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

    const text = document.createElement('div');
    text.className = 'now-playing__text';
    text.append(this.title, this.artist, this.source);
    this.element.append(this.cover, text);

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

    // При смене трека карточка живёт HOLD_MS; в режиме «всегда» — постоянно.
    const withinHold = nowMs - this.shownAt < HOLD_MS;
    const visible = Boolean(track) && mode !== 'never' && (mode === 'always' || withinHold);

    this.element.classList.toggle('now-playing--hidden', !visible);
    // Мелкий вариант — для постоянного показа: он не должен спорить с картинкой.
    this.element.classList.toggle('now-playing--compact', mode === 'always' && !withinHold);
    // Текст внизу — карточка наверх, иначе они дерутся за один угол.
    this.element.classList.toggle(
      'now-playing--top',
      settings.lyrics.enabled && settings.lyrics.position === 'bottom',
    );

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
  }
}
