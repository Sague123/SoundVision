/** Небольшая карточка «сейчас играет» в углу экрана. */

import type { NowPlayingTrack } from '../cover/now-playing.ts';

const SOURCE_LABELS: Record<NowPlayingTrack['source'], string> = {
  spotify: 'Spotify',
  'youtube-music': 'YouTube Music',
};

export class NowPlayingCard {
  readonly element = document.createElement('div');
  private readonly cover = document.createElement('img');
  private readonly title = document.createElement('div');
  private readonly artist = document.createElement('div');
  private readonly source = document.createElement('div');
  private readonly progress = document.createElement('div');
  private readonly progressBar = document.createElement('div');
  private renderedKey = '';

  constructor() {
    this.element.className = 'now-playing now-playing--hidden';
    this.cover.className = 'now-playing__cover';
    this.cover.alt = '';

    this.title.className = 'now-playing__title';
    this.artist.className = 'now-playing__artist';
    this.source.className = 'now-playing__source';
    this.progress.className = 'now-playing__progress';
    this.progressBar.className = 'now-playing__progress-bar';
    this.progress.append(this.progressBar);

    const text = document.createElement('div');
    text.className = 'now-playing__text';
    text.append(this.title, this.artist, this.source, this.progress);
    this.element.append(this.cover, text);
  }

  update(track: NowPlayingTrack | null, visible: boolean): void {
    const show = visible && track !== null;
    this.element.classList.toggle('now-playing--hidden', !show);
    if (!track || !show) return;

    const key = `${track.artist}|${track.title}|${track.coverUrl ?? ''}`;
    if (key !== this.renderedKey) {
      this.renderedKey = key;
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
    }

    const ratio = track.durationMs > 0 ? Math.min(1, track.progressMs / track.durationMs) : 0;
    this.progress.hidden = track.durationMs <= 0;
    this.progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
  }
}
