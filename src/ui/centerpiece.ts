/**
 * Обложка и название трека в центре кадра.
 *
 * Появляется, когда сцена строит кадр вокруг центра (кольцо, радиальный
 * эквалайзер): тогда обложка — сердцевина композиции, как в плеере, а
 * угловая карточка на это время уходит, чтобы название не стояло дважды.
 * Долю показа решает режиссёр, рендер держит под неё пустой круг — размеры
 * общие, из `centerpiece-geometry`.
 *
 * Обложка дышит басом: едва заметный масштаб на ударе связывает её с
 * музыкой, а не оставляет наклейкой поверх картинки. Нет обложки — вместо
 * неё монограмма из первых букв.
 */

import type { NowPlayingTrack } from '../cover/now-playing.ts';
import { CENTERPIECE_DISC, CENTERPIECE_HOLE, CENTERPIECE_LIFT } from '../render/centerpiece-geometry.ts';

export class Centerpiece {
  readonly element = document.createElement('div');

  private readonly disc = document.createElement('div');
  private readonly cover = document.createElement('img');
  private readonly monogram = document.createElement('div');
  private readonly title = document.createElement('div');
  private readonly artist = document.createElement('div');
  private renderedKey = '';
  private shownAmount = -1;
  private shownPulse = -1;

  constructor() {
    this.element.className = 'centerpiece';
    this.disc.className = 'centerpiece__disc';
    this.cover.className = 'centerpiece__cover';
    this.cover.alt = '';
    this.monogram.className = 'centerpiece__monogram';
    this.title.className = 'centerpiece__title';
    this.artist.className = 'centerpiece__artist';
    this.disc.append(this.monogram, this.cover);
    this.element.append(this.disc, this.title, this.artist);
    this.element.style.opacity = '0';
    this.element.style.visibility = 'hidden';
  }

  /** Размеры — от меньшей стороны сцены, как и пустой круг в рендере. */
  resize(width: number, height: number): void {
    const min = Math.min(width, height);
    const style = this.element.style;
    style.setProperty('--cp-disc', `${(min * CENTERPIECE_DISC).toFixed(1)}px`);
    style.setProperty('--cp-lift', `${(min * CENTERPIECE_LIFT).toFixed(1)}px`);
    // Ширина текста — хорда пустого круга на высоте строк под обложкой.
    style.setProperty('--cp-text', `${(min * CENTERPIECE_HOLE * 1.55).toFixed(1)}px`);
    style.setProperty('--cp-min', `${min.toFixed(1)}px`);
  }

  /**
   * @param amount доля показа 0..1 — уже с учётом настроек и наличия трека.
   * @param pulse удар баса 0..1: обложка на нём чуть вырастает.
   */
  update(track: NowPlayingTrack | null, amount: number, pulse: number): void {
    const key = track ? `${track.artist}|${track.title}|${track.coverUrl ?? ''}` : '';
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      if (track) this.render(track);
    }

    // DOM трогаем только при заметной разнице: стиль на каждом кадре —
    // лишний пересчёт вёрстки на слабом мини-ПК.
    const shown = track ? amount : 0;
    if (Math.abs(shown - this.shownAmount) > 0.01) {
      this.shownAmount = shown;
      this.element.style.opacity = shown.toFixed(3);
      this.element.style.visibility = shown > 0.01 ? 'visible' : 'hidden';
      this.element.style.setProperty('--cp-enter', (0.92 + shown * 0.08).toFixed(3));
    }
    const beat = Math.max(0, Math.min(1, pulse));
    if (Math.abs(beat - this.shownPulse) > 0.02) {
      this.shownPulse = beat;
      this.disc.style.setProperty('--cp-pulse', (1 + beat * 0.035).toFixed(4));
    }
  }

  private render(track: NowPlayingTrack): void {
    this.title.textContent = track.title;
    this.artist.textContent = track.artist;
    this.monogram.textContent = initials(track);
    if (track.coverUrl) {
      this.cover.src = track.coverUrl;
      this.cover.hidden = false;
    } else {
      this.cover.removeAttribute('src');
      this.cover.hidden = true;
    }
  }
}

/** Монограмма: первые буквы артиста и названия. */
function initials(track: NowPlayingTrack): string {
  const first = (text: string): string => (text.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase();
  return `${first(track.artist)}${first(track.title)}` || '♪';
}
