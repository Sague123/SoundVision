/**
 * Единый поток «что сейчас играет». Рендеру и тексту песни всё равно,
 * пришли данные из Spotify или из расширения YouTube Music.
 */

export type NowPlayingSource = 'spotify' | 'youtube-music';

export interface NowPlayingTrack {
  title: string;
  artist: string;
  coverUrl: string | null;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
  source: NowPlayingSource;
  /** `performance.now()` в момент получения — база для интерполяции позиции. */
  receivedAt: number;
}

export type NowPlayingListener = (track: NowPlayingTrack | null, trackChanged: boolean) => void;

/** Идентичность трека: по ней решаем, менять ли seed и перезапрашивать ли текст. */
export function trackIdentity(track: NowPlayingTrack | null): string {
  return track ? `${track.artist.toLowerCase()}|${track.title.toLowerCase()}` : '';
}

export class NowPlaying {
  private readonly sources = new Map<NowPlayingSource, NowPlayingTrack | null>();
  private readonly listeners: NowPlayingListener[] = [];
  private lastIdentity = '';

  update(source: NowPlayingSource, track: NowPlayingTrack | null): void {
    this.sources.set(source, track);
    const merged = this.pick();
    const identity = trackIdentity(merged);
    const changed = identity !== this.lastIdentity;
    this.lastIdentity = identity;
    for (const listener of this.listeners) listener(merged, changed);
  }

  onChange(listener: NowPlayingListener): void {
    this.listeners.push(listener);
  }

  /**
   * Текущая позиция с интерполяцией: источники опрашиваются раз в несколько
   * секунд, а тексту песни нужна позиция на каждом кадре.
   */
  current(nowMs = performance.now()): NowPlayingTrack | null {
    const track = this.pick();
    if (!track) return null;
    if (!track.isPlaying) return track;
    const elapsed = nowMs - track.receivedAt;
    return { ...track, progressMs: Math.min(track.durationMs, track.progressMs + elapsed) };
  }

  /** Активный источник, если он есть, — для индикатора в панели настроек. */
  get activeSource(): NowPlayingSource | null {
    return this.pick()?.source ?? null;
  }

  /**
   * Играющий источник важнее молчащего; при равенстве — тот, от кого
   * обновление пришло позже. Так переключение между Spotify и YT Music
   * не требует ничего выключать вручную.
   */
  private pick(): NowPlayingTrack | null {
    let best: NowPlayingTrack | null = null;
    for (const track of this.sources.values()) {
      if (!track) continue;
      if (!best) {
        best = track;
        continue;
      }
      if (track.isPlaying !== best.isPlaying) {
        if (track.isPlaying) best = track;
        continue;
      }
      if (track.receivedAt > best.receivedAt) best = track;
    }
    return best;
  }
}
