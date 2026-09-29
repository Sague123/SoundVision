/**
 * Синтетическая «песня» для проверок режиссёра.
 *
 * Режиссёр живёт на смене музыкальных состояний, а их на ровном тестовом
 * сигнале не бывает. Здесь песня собрана по частям — тишина, интро,
 * нарастание, дроп, спад, куплет с голосом, — и каждая часть узнаваема по
 * тем же признакам, по которым её узнаёт живой анализ: энергия, частота
 * ударов, форма спектра, голосовая полоса.
 *
 * Сигнал детерминирован: одна и та же секунда всегда даёт одно и то же,
 * поэтому проверки воспроизводимы.
 */

import { idleMood, type MoodVector } from '../src/audio/mood-vector.ts';

export type SongPart = 'silence' | 'intro' | 'build' | 'drop' | 'breakdown' | 'vocal';

export interface SongSegment {
  part: SongPart;
  fromSec: number;
  toSec: number;
}

/** Классическая форма: тишина, интро, нарастание, дроп, спад, куплет. */
export const DEFAULT_SONG: SongSegment[] = [
  { part: 'silence', fromSec: 0, toSec: 3 },
  { part: 'intro', fromSec: 3, toSec: 18 },
  { part: 'build', fromSec: 18, toSec: 30 },
  { part: 'drop', fromSec: 30, toSec: 50 },
  { part: 'breakdown', fromSec: 50, toSec: 62 },
  { part: 'vocal', fromSec: 62, toSec: 80 },
];

const BPM = 128;
const WAVE = 2048;
const BINS = 1024;
const BIN_HZ = 48000 / 2048;

export class SongSimulator {
  private readonly waveform = new Float32Array(WAVE);
  private readonly waveformRight = new Float32Array(WAVE);
  private readonly spectrum = new Float32Array(BINS);

  constructor(private readonly song: SongSegment[] = DEFAULT_SONG) {}

  get durationSec(): number {
    return this.song[this.song.length - 1].toSec;
  }

  partAt(sec: number): SongSegment {
    return this.song.find((s) => sec >= s.fromSec && sec < s.toSec) ?? this.song[this.song.length - 1];
  }

  mood(timeMs: number, deltaMs = 1000 / 60): MoodVector {
    const t = timeMs / 1000;
    const seg = this.partAt(t);
    const local = (t - seg.fromSec) / Math.max(0.001, seg.toSec - seg.fromSec);

    const beatPeriod = 60 / BPM;
    const beatPhase = (t / beatPeriod) % 1;
    // Удары: в интро — только на сильную долю, в нарастании — всё чаще, на
    // дропе — каждая доля и восьмые.
    let onsetEvery = 4;
    let energy = 0;
    let flux = 0;
    let vocal = 0;
    let bass = 0.3;
    let treble = 0.3;
    switch (seg.part) {
      case 'silence':
        energy = 0;
        break;
      case 'intro':
        energy = 0.2 + Math.sin(t * 0.7) * 0.03;
        onsetEvery = 4;
        flux = 0.1;
        bass = 0.25;
        break;
      case 'build':
        // Энергия ползёт вверх, удары учащаются вдвое каждые четыре секунды.
        energy = 0.25 + local * 0.5;
        onsetEvery = local < 0.33 ? 2 : local < 0.66 ? 1 : 0.5;
        flux = 0.2 + local * 0.4;
        treble = 0.4 + local * 0.5;
        break;
      case 'drop':
        energy = 0.9 + Math.sin(t * 2) * 0.05;
        onsetEvery = 0.5;
        flux = 0.6;
        bass = 1;
        treble = 0.7;
        break;
      case 'breakdown':
        energy = 0.22;
        onsetEvery = 8;
        flux = 0.08;
        bass = 0.15;
        break;
      case 'vocal':
        energy = 0.45;
        onsetEvery = 1;
        flux = 0.25;
        vocal = 1;
        bass = 0.4;
        treble = 0.2;
        break;
    }

    const beatsElapsed = t / beatPeriod;
    const stepLength = onsetEvery;
    const stepPhase = (beatsElapsed / stepLength) % 1;
    const stepSec = stepLength * beatPeriod;
    // Атака — первые ~40 мс шага.
    const onset = seg.part !== 'silence' && stepPhase * stepSec < deltaMs / 1000 * 1.01;
    const onsetStrength = onset ? Math.min(1, 0.5 + energy * 0.5) : 0;

    this.fillSignal(t, energy, bass, treble, vocal, stepPhase);

    return {
      ...idleMood(timeMs),
      energy,
      brightness: 0.3 + treble * 0.4,
      noisiness: 0.2 + treble * 0.3,
      flux: onset ? Math.min(1, flux + 0.3) : flux * 0.5,
      onset,
      onsetStrength,
      bpm: BPM,
      beatPhase,
      beatConfidence: seg.part === 'silence' ? 0 : 0.8,
      section: seg.part === 'drop' ? 'drop' : seg.part === 'build' ? 'buildup'
        : seg.part === 'silence' || seg.part === 'breakdown' ? 'calm' : 'steady',
      energySlope: seg.part === 'build' ? 0.5 : 0,
      bands: { low: bass * energy, mid: 0.4 * energy, high: treble * energy },
      onsetProfile: onset ? { low: bass, mid: 0.4, high: treble } : { low: 0, mid: 0, high: 0 },
      waveform: this.waveform,
      waveformRight: this.waveformRight,
      spectrum: this.spectrum,
      binHz: BIN_HZ,
      stereo: true,
      silent: seg.part === 'silence',
      timeMs,
      deltaMs,
    };
  }

  private fillSignal(t: number, energy: number, bass: number, treble: number, vocal: number, step: number): void {
    const level = energy * 0.8;
    const hit = Math.exp(-step * 6);
    for (let i = 0; i < WAVE; i++) {
      const u = (i / WAVE) * Math.PI * 2;
      const noise = ((Math.sin(i * 12.9898 + t * 78.233) * 43758.5453) % 1) * treble * 0.3;
      const v = (Math.sin(u * 3) * bass * (0.5 + hit) + Math.sin(u * 40 + t) * 0.3 + noise) * level;
      this.waveform[i] = v;
      this.waveformRight[i] = v * 0.8 + Math.sin(u * 7 + t * 3) * level * 0.2;
    }
    // Спектр в масштабе анализатора: линейная магнитуда около 0.01..0.15.
    for (let b = 0; b < BINS; b++) {
      const hz = b * BIN_HZ;
      let m = 0;
      if (hz < 150) m += bass * (0.6 + hit * 0.8);
      if (hz >= 150 && hz < 2000) m += 0.25;
      if (hz >= 2000) m += treble * 0.35 * Math.exp(-(hz - 2000) / 6000);
      // Голос: гармоники основного тона 220 Гц в полосе формант, с
      // модуляцией уровня около 5 раз в секунду — это слоги. Бас при этом
      // слоговой модуляции не получает: так и отличается голос от ударных.
      if (vocal > 0 && hz >= 300 && hz <= 3400) {
        const harmonic = (hz / 220) % 1;
        const peak = Math.exp(-((harmonic - 0.5) ** 2) * 30);
        const syllable = 0.25 + 0.75 * Math.max(0, Math.sin(t * Math.PI * 2 * 4.7));
        m += vocal * peak * 1.6 * syllable;
      }
      this.spectrum[b] = energy * m * 0.13;
    }
  }
}
