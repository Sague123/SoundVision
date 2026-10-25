/**
 * BPM и фаза доли: автокорреляция огибающей onset-силы.
 *
 * Огибающая пишется в буфер фиксированной частоты (независимо от fps рендера),
 * поэтому просадка кадров не уводит темп.
 */

const RATE_HZ = 100;
const WINDOW_SECONDS = 8;
const WINDOW = RATE_HZ * WINDOW_SECONDS;
const MIN_BPM = 60;
const MAX_BPM = 200;
/** Диапазон, в который сворачиваем октавные ошибки (половинный/двойной темп). */
const PREFERRED_LOW = 85;
const PREFERRED_HIGH = 175;
const ANALYSIS_INTERVAL_MS = 500;

export interface BeatState {
  bpm: number;
  /** 0..1 — где мы внутри доли; 0 — момент удара. */
  phase: number;
  confidence: number;
}

export class BeatTracker {
  private readonly envelope = new Float32Array(WINDOW);
  private writeIndex = 0;
  private filled = 0;

  private pendingMax = 0;
  private accumulatorMs = 0;
  private lastAnalysisMs = 0;

  private bpm = 120;
  private confidence = 0;
  private lastBeatMs = 0;

  /**
   * @param deltaMs — время с прошлого кадра
   * @param onsetStrength — сила удара в этом кадре (0, если onset'а не было)
   * @param flux — сглаженный flux, как «подложка» огибающей между ударами
   */
  update(nowMs: number, deltaMs: number, onsetStrength: number, flux: number): void {
    this.pendingMax = Math.max(this.pendingMax, onsetStrength * 0.8 + flux * 0.2);
    if (onsetStrength > 0) this.lastBeatMs = nowMs;

    const stepMs = 1000 / RATE_HZ;
    this.accumulatorMs += deltaMs;
    while (this.accumulatorMs >= stepMs) {
      this.accumulatorMs -= stepMs;
      this.envelope[this.writeIndex] = this.pendingMax;
      this.writeIndex = (this.writeIndex + 1) % WINDOW;
      this.filled = Math.min(WINDOW, this.filled + 1);
      this.pendingMax *= 0.5; // хвост удара тянется на пару шагов, но затухает
    }

    if (this.filled >= RATE_HZ * 3 && nowMs - this.lastAnalysisMs >= ANALYSIS_INTERVAL_MS) {
      this.lastAnalysisMs = nowMs;
      this.analyze();
    }
  }

  /** @param override — ручная коррекция темпа из панели настроек. */
  state(nowMs: number, override: number | null): BeatState {
    const bpm = override && override > 0 ? override : this.bpm;
    const beatMs = 60000 / bpm;
    const sinceBeat = this.lastBeatMs > 0 ? nowMs - this.lastBeatMs : 0;
    const phase = ((sinceBeat % beatMs) + beatMs) % beatMs / beatMs;
    return { bpm, phase, confidence: override ? 1 : this.confidence };
  }

  private analyze(): void {
    // Разворачиваем кольцевой буфер в хронологический порядок.
    const ordered = new Float32Array(this.filled);
    for (let i = 0; i < this.filled; i++) {
      ordered[i] = this.envelope[(this.writeIndex - this.filled + i + WINDOW) % WINDOW];
    }

    let mean = 0;
    for (const value of ordered) mean += value;
    mean /= ordered.length;
    for (let i = 0; i < ordered.length; i++) ordered[i] -= mean; // убираем постоянную составляющую

    const minLag = Math.floor((60 * RATE_HZ) / MAX_BPM);
    const maxLag = Math.min(ordered.length - 1, Math.ceil((60 * RATE_HZ) / MIN_BPM));

    let bestLag = 0;
    let bestScore = 0;
    let energy = 0;
    for (const value of ordered) energy += value * value;
    if (energy <= 1e-9) {
      this.confidence = Math.max(0, this.confidence - 0.2);
      return;
    }

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = lag; i < ordered.length; i++) sum += ordered[i] * ordered[i - lag];
      // Нормируем на длину перекрытия, иначе короткие лаги всегда выигрывают.
      const score = sum / (ordered.length - lag);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    if (bestLag === 0) {
      this.confidence = Math.max(0, this.confidence - 0.2);
      return;
    }

    let bpm = (60 * RATE_HZ) / bestLag;
    while (bpm < PREFERRED_LOW && bpm * 2 <= MAX_BPM) bpm *= 2;
    while (bpm > PREFERRED_HIGH && bpm / 2 >= MIN_BPM) bpm /= 2;

    const normalizedScore = Math.min(1, (bestScore * ordered.length) / energy);
    this.confidence = this.confidence * 0.6 + normalizedScore * 0.4;
    // Тянемся к новому значению, а не прыгаем: одиночный ложный пик не собьёт темп.
    this.bpm = this.bpm * 0.7 + bpm * 0.3;
  }
}
