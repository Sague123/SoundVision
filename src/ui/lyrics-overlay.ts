/**
 * Оверлей с текстом песни.
 *
 * Текст рисуется DOM'ом, а не на канвасе: так он остаётся резким на 4K, к нему
 * применимы backdrop-filter и variable fonts, и он не участвует в композиции
 * слоёв. DOM трогаем только при смене строки — на каждом кадре меняются лишь
 * несколько CSS-переменных.
 *
 * Читаемость здесь — не украшение, а требование: чем плотнее фон, тем легче
 * потерять строку, поэтому цвет подбирается от измеренной яркости кадра, а под
 * текстом всегда есть подложка.
 */

import { clamp, clamp01 } from '../audio/features.ts';
import type { MoodVector } from '../audio/mood-vector.ts';
import { oklchToRgb, rgbToCss } from '../render/color/oklch.ts';
import type { Palette } from '../render/palette.ts';
import type { Settings } from '../settings.ts';
import type { LyricsPosition } from '../lyrics/sync-engine.ts';
import { chooseFont, findFont, FALLBACK_STACK, type FontChoice } from './fonts.ts';

/** Схемы появления строки. Резкие — для агрессивного материала, мягкие — для спокойного. */
export type LyricsAnimation = 'auto' | 'soft' | 'sharp' | 'stagger' | 'dissolve';

export const LYRICS_ANIMATIONS: Array<{ value: LyricsAnimation; label: string }> = [
  { value: 'auto', label: 'Авто (по характеру трека)' },
  { value: 'soft', label: 'Мягкая (blur + подъём)' },
  { value: 'sharp', label: 'Резкая (маска слева направо)' },
  { value: 'stagger', label: 'По буквам' },
  { value: 'dissolve', label: 'Проявление' },
];

/** Минимальный контраст по светлоте OKLCH между текстом и кадром. */
const MIN_CONTRAST = 0.45;

export class LyricsOverlay {
  readonly element = document.createElement('div');
  private readonly plate = document.createElement('div');
  private readonly current = document.createElement('div');
  private readonly outgoing = document.createElement('div');
  private wordSpans: HTMLSpanElement[] = [];
  private renderedIndex = -2;
  private renderedWord = -2;
  private appliedFont = '';
  private lastOnsetAt = -Infinity;

  constructor() {
    this.element.className = 'lyrics';
    this.plate.className = 'lyrics__plate';
    this.current.className = 'lyrics__line';
    this.outgoing.className = 'lyrics__line lyrics__line--out';
    this.plate.append(this.outgoing, this.current);
    this.element.append(this.plate);
  }

  /**
   * @param meanLuminance средняя яркость кадра 0..1 — от неё зависит цвет текста
   */
  update(
    position: LyricsPosition,
    settings: Settings,
    palette: Palette | null,
    mood: MoodVector,
    meanLuminance: number,
  ): void {
    const visible = settings.lyrics.enabled && position.line !== null;
    this.element.classList.toggle('lyrics--hidden', !visible);
    this.element.classList.toggle('lyrics--center', settings.lyrics.position === 'center');
    this.element.classList.toggle('lyrics--top', settings.lyrics.position === 'top');
    if (!visible) {
      this.renderedIndex = -2;
      return;
    }

    const font = this.applyFont(settings, mood);
    this.applyColours(settings, palette, meanLuminance);
    this.applyReaction(settings, mood, font);

    const animation = resolveAnimation(settings.lyrics.animation, mood);
    this.element.dataset.animation = animation;
    this.element.classList.toggle('lyrics--max-readability', settings.lyrics.readability === 'max');
    this.element.style.setProperty('--lyrics-size', `${settings.lyrics.fontSize}px`);

    if (position.lineIndex !== this.renderedIndex) {
      this.swapLine(position, settings, animation);
      this.renderedIndex = position.lineIndex;
      this.renderedWord = -2;
    }

    if (settings.lyrics.mode === 'karaoke' && this.wordSpans.length > 0) {
      this.highlightWord(position);
    } else {
      // Без потайминга по словам строка «заливается» по прогрессу целиком.
      this.current.style.setProperty('--lyrics-progress', `${(position.lineProgress * 100).toFixed(1)}%`);
    }
  }

  /** Гарнитура — часть настроения, поэтому по умолчанию выбирается автоматически. */
  private applyFont(settings: Settings, mood: MoodVector): FontChoice {
    const id = settings.lyrics.font === 'auto'
      ? chooseFont({
        noisiness: mood.noisiness,
        brightness: mood.brightness,
        energy: mood.energy,
        bpm: mood.bpm,
        mode: mood.key.mode,
      })
      : settings.lyrics.font;
    const font = findFont(id);

    if (font.id !== this.appliedFont) {
      this.appliedFont = font.id;
      this.element.style.setProperty('--lyrics-font', `${font.stack}, ${FALLBACK_STACK}`);
      this.element.style.setProperty('--lyrics-transform', font.uppercase ? 'uppercase' : 'none');
      this.element.style.setProperty('--lyrics-style', font.italic ? 'italic' : 'normal');
    }
    return font;
  }

  /**
   * Цвет текста с проверкой контраста.
   *
   * Белый текст на светлом кадре пропадает, поэтому светлота берётся не из
   * палитры напрямую: если она слишком близка к яркости кадра, уходим в
   * противоположную сторону. Оттенок при этом сохраняется — текст остаётся
   * частью палитры.
   */
  private applyColours(settings: Settings, palette: Palette | null, meanLuminance: number): void {
    const hue = palette?.hue ?? 0;

    if (settings.lyrics.color !== 'auto') {
      this.element.style.setProperty('--lyrics-color', settings.lyrics.color);
      this.element.style.setProperty('--lyrics-dim', `color-mix(in srgb, ${settings.lyrics.color} 45%, transparent)`);
      this.element.style.setProperty('--lyrics-glow', settings.lyrics.color);
      // Даже при ручном цвете подложка обязана быть контрастной к кадру.
      this.element.style.setProperty('--lyrics-plate',
        rgbToCss(oklchToRgb({ l: meanLuminance < 0.5 ? 0.04 : 0.99, c: 0.01, h: hue })));
      return;
    }
    // Уходим от яркости кадра минимум на MIN_CONTRAST по светлоте.
    const lightText = meanLuminance < 0.5;
    let lightness = lightText ? 0.97 : 0.18;
    if (Math.abs(lightness - meanLuminance) < MIN_CONTRAST) {
      lightness = lightText
        ? clamp(0.5, 1, meanLuminance + MIN_CONTRAST)
        : clamp(0, 0.5, meanLuminance - MIN_CONTRAST);
    }

    const main = rgbToCss(oklchToRgb({ l: lightness, c: 0.03, h: hue }));
    // Подложка всегда уходит в сторону, противоположную тексту: светлый текст
    // получает тёмную плашку и наоборот. Иначе на ярком кадре тёмный текст
    // лежит на почти таком же ярком фоне.
    const plate = rgbToCss(oklchToRgb({ l: lightText ? 0.04 : 0.99, c: 0.01, h: hue }));
    this.element.style.setProperty('--lyrics-plate', plate);
    const dim = rgbToCss(oklchToRgb({
      // Непропетая часть строки приглушается смещением к яркости кадра.
      l: lightness + (meanLuminance - lightness) * 0.55,
      c: 0.02,
      h: hue,
    }));
    this.element.style.setProperty('--lyrics-color', main);
    this.element.style.setProperty('--lyrics-dim', dim);
    // Ореол помогает только светлому тексту. Вокруг тёмного текста светящийся
    // контур съедает контраст, поэтому там он почти снимается.
    this.element.style.setProperty('--lyrics-glow', lightText ? (palette?.accent(0.8) ?? main) : plate);
    this.element.style.setProperty('--lyrics-glow-size', lightText ? '26px' : '6px');
    this.element.style.setProperty('--lyrics-shadow', lightText ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.5)');
  }

  /** Реакция на музыку: вес, трекинг и лёгкое смещение на удар. */
  private applyReaction(settings: Settings, mood: MoodVector, font: FontChoice): void {
    if (!settings.lyrics.reactive) {
      this.element.style.setProperty('--lyrics-weight', String(font.weightRange[0]));
      this.element.style.setProperty('--lyrics-tracking', `${font.tracking}em`);
      this.element.style.setProperty('--lyrics-nudge', '0px');
      return;
    }

    // Вес ведём энергией — это и есть смысл variable fonts здесь.
    const [minWeight, maxWeight] = font.weightRange;
    const weight = Math.round(minWeight + (maxWeight - minWeight) * clamp01(mood.energy));
    this.element.style.setProperty('--lyrics-weight', String(weight));
    // Трекинг чуть расширяется на пиках.
    this.element.style.setProperty('--lyrics-tracking', `${(font.tracking + mood.energy * 0.012).toFixed(4)}em`);

    if (mood.onset && mood.onsetStrength > 0.4) this.lastOnsetAt = mood.timeMs;
    // Смещение синхронно с тряской сцены, но заметно меньше по амплитуде:
    // прыгающий текст читать невозможно.
    const since = mood.timeMs - this.lastOnsetAt;
    const kick = since < 180 ? (1 - since / 180) ** 2 : 0;
    this.element.style.setProperty('--lyrics-nudge', `${(kick * 5).toFixed(2)}px`);
  }

  private swapLine(position: LyricsPosition, settings: Settings, animation: LyricsAnimation): void {
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
    const words = karaoke && line.words ? line.words.map((word) => word.text) : line.text.split(' ');

    let letterIndex = 0;
    words.forEach((text, index) => {
      const word = document.createElement('span');
      word.className = 'lyrics__word';
      word.style.setProperty('--wipe', '0%');

      // Два слоя вместо background-clip: спетая часть — это отдельная копия
      // с настоящим color, обрезанная clip-path. Через background-clip сюда
      // нельзя: заливка глифа становится фоном, а фон красится ДО теней, и
      // белая обводка ложится поверх, съедая цвет.
      const base = document.createElement('span');
      base.className = 'lyrics__word-base';
      const fill = document.createElement('span');
      fill.className = 'lyrics__word-fill';
      fill.setAttribute('aria-hidden', 'true');

      if (animation === 'stagger') {
        // Побуквенная задержка: буквы появляются друг за другом.
        for (const character of text) {
          const letter = document.createElement('span');
          letter.className = 'lyrics__letter';
          letter.textContent = character;
          letter.style.setProperty('--i', String(letterIndex++));
          base.append(letter);
        }
      } else {
        base.textContent = text;
      }
      fill.textContent = text;

      word.append(base, fill);
      this.wordSpans.push(word);
      this.current.append(word);
      if (index < words.length - 1) this.current.append(document.createTextNode(' '));
    });

    this.current.classList.remove('lyrics__line--in');
    void this.current.offsetWidth;
    this.current.classList.add('lyrics__line--in');
  }

  /**
   * Караоке: текущее слово заливается слева направо, спетые остаются яркими,
   * неспетые приглушены.
   */
  private highlightWord(position: LyricsPosition): void {
    const index = position.wordIndex;
    const line = position.line;

    if (index !== this.renderedWord) {
      this.renderedWord = index;
      for (let i = 0; i < this.wordSpans.length; i++) {
        const span = this.wordSpans[i];
        span.classList.toggle('lyrics__word--sung', i < index);
        span.classList.toggle('lyrics__word--active', i === index);
        if (i < index) span.style.setProperty('--wipe', '100%');
        if (i > index) span.style.setProperty('--wipe', '0%');
      }
    }

    // Заливка текущего слова идёт непрерывно — по времени до следующего слова.
    if (index < 0 || index >= this.wordSpans.length || !line?.words) return;
    const words = line.words;
    const start = words[index].timeMs;
    const end = words[index + 1]?.timeMs ?? start + 600;
    const elapsed = position.sinceLineMs + line.timeMs - start;
    const progress = clamp01(elapsed / Math.max(1, end - start));
    this.wordSpans[index].style.setProperty('--wipe', `${(progress * 100).toFixed(1)}%`);
  }
}

/** Характер трека → схема появления. Резкое на агрессивном, мягкое на спокойном. */
function resolveAnimation(setting: LyricsAnimation, mood: MoodVector): LyricsAnimation {
  if (setting !== 'auto') return setting;
  if (mood.noisiness > 0.6 || mood.section === 'drop') return 'sharp';
  if (mood.energy > 0.55) return 'stagger';
  if (mood.energy < 0.25) return 'dissolve';
  return 'soft';
}
