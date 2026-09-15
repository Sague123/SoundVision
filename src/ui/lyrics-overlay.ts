/**
 * Оверлей с текстом песни. Текст рисуется DOM'ом, а не на канвасе: так он
 * остаётся резким на 4K-телике и не мешает композиции слоёв.
 *
 * DOM трогаем только при смене строки — на каждом кадре меняется максимум
 * класс подсвеченного слова.
 */

import type { Palette } from '../render/palette.ts';
import type { Settings } from '../settings.ts';
import type { LyricsPosition } from '../lyrics/sync-engine.ts';

export class LyricsOverlay {
  readonly element = document.createElement('div');
  private readonly current = document.createElement('div');
  private readonly outgoing = document.createElement('div');
  private wordSpans: HTMLSpanElement[] = [];
  private renderedIndex = -2;
  private renderedWord = -2;

  constructor() {
    this.element.className = 'lyrics';
    this.current.className = 'lyrics__line';
    this.outgoing.className = 'lyrics__line lyrics__line--out';
    this.element.append(this.outgoing, this.current);
  }

  update(position: LyricsPosition, settings: Settings, palette: Palette | null): void {
    const visible = settings.lyrics.enabled && position.line !== null;
    this.element.classList.toggle('lyrics--hidden', !visible);
    this.element.classList.toggle('lyrics--center', settings.lyrics.position === 'center');
    if (!visible) {
      this.renderedIndex = -2;
      return;
    }

    this.element.style.setProperty('--lyrics-size', `${settings.lyrics.fontSize}px`);
    const color = settings.lyrics.color === 'auto' ? palette?.ink ?? '#fff' : settings.lyrics.color;
    this.element.style.setProperty('--lyrics-color', color);
    const glow = settings.lyrics.color === 'auto' ? palette?.accent(0.8) ?? '#fff' : color;
    this.element.style.setProperty('--lyrics-glow', glow);

    if (position.lineIndex !== this.renderedIndex) {
      this.swapLine(position, settings);
      this.renderedIndex = position.lineIndex;
      this.renderedWord = -2;
    }

    if (settings.lyrics.mode === 'karaoke' && this.wordSpans.length > 0) {
      this.highlightWord(position.wordIndex);
    } else {
      // Без word-level таймингов строка «заливается» по прогрессу целиком.
      this.current.style.setProperty('--lyrics-progress', `${(position.lineProgress * 100).toFixed(1)}%`);
    }
  }

  private swapLine(position: LyricsPosition, settings: Settings): void {
    this.outgoing.innerHTML = this.current.innerHTML;
    // Перезапуск CSS-анимации: без reflow браузер переиспользует старую.
    this.outgoing.classList.remove('lyrics__line--out');
    void this.outgoing.offsetWidth;
    this.outgoing.classList.add('lyrics__line--out');

    const line = position.line;
    this.wordSpans = [];
    this.current.replaceChildren();

    if (!line) return;
    const karaoke = settings.lyrics.mode === 'karaoke' && line.words !== null;

    if (karaoke && line.words) {
      for (const word of line.words) {
        const span = document.createElement('span');
        span.className = 'lyrics__word';
        span.textContent = word.text;
        this.wordSpans.push(span);
        this.current.append(span, document.createTextNode(' '));
      }
    } else {
      this.current.textContent = line.text;
    }

    this.current.classList.remove('lyrics__line--in');
    void this.current.offsetWidth;
    this.current.classList.add('lyrics__line--in');
  }

  private highlightWord(wordIndex: number): void {
    if (wordIndex === this.renderedWord) return;
    this.renderedWord = wordIndex;
    for (let i = 0; i < this.wordSpans.length; i++) {
      this.wordSpans[i].classList.toggle('lyrics__word--sung', i <= wordIndex);
    }
  }
}
