/**
 * Spotify: OAuth 2.0 Authorization Code + PKCE.
 *
 * PKCE выбран потому, что client secret в браузерном приложении хранить негде.
 * Client ID пользователь заводит сам в Spotify Developer Dashboard и вбивает
 * в панели настроек — это не секрет, но и зашивать чужой в репозиторий нельзя.
 */

import type { NowPlayingTrack } from './now-playing.ts';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1/me/player/currently-playing';
const SCOPES = 'user-read-currently-playing user-read-playback-state';

const STORAGE_TOKENS = 'soundvision.spotify.tokens';
const STORAGE_VERIFIER = 'soundvision.spotify.verifier';
const STORAGE_CLIENT_ID = 'soundvision.spotify.clientId';

const POLL_INTERVAL_MS = 4000;
const TOKEN_MARGIN_MS = 60_000;

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export type SpotifyStatus = 'disabled' | 'connecting' | 'connected' | 'error';

export class SpotifyClient {
  private tokens: Tokens | null = readJson<Tokens>(STORAGE_TOKENS);
  private timer: number | null = null;
  private status: SpotifyStatus = 'disabled';
  private lastError: string | null = null;
  private listeners: Array<(track: NowPlayingTrack | null) => void> = [];

  get clientId(): string {
    return localStorage.getItem(STORAGE_CLIENT_ID) ?? '';
  }

  set clientId(value: string) {
    localStorage.setItem(STORAGE_CLIENT_ID, value.trim());
  }

  get connected(): boolean {
    return this.tokens !== null;
  }

  get state(): { status: SpotifyStatus; error: string | null } {
    return { status: this.status, error: this.lastError };
  }

  onTrack(listener: (track: NowPlayingTrack | null) => void): void {
    this.listeners.push(listener);
  }

  /** Redirect URI должен быть в точности таким же в настройках приложения Spotify. */
  get redirectUri(): string {
    return `${window.location.origin}${window.location.pathname}`;
  }

  /** Шаг 1: уводим пользователя на страницу согласия Spotify. */
  async authorize(): Promise<void> {
    if (!this.clientId) throw new Error('Не задан Spotify Client ID');
    const verifier = randomString(96);
    localStorage.setItem(STORAGE_VERIFIER, verifier);

    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: await sha256Base64Url(verifier),
    });
    window.location.assign(`${AUTH_URL}?${params.toString()}`);
  }

  /**
   * Шаг 2: вызывается при загрузке страницы. Если в URL есть `code`,
   * обменивает его на токены и вычищает query-строку.
   * @returns true, если обмен произошёл.
   */
  async handleRedirect(): Promise<boolean> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) {
      this.lastError = `Spotify отказал в доступе: ${error}`;
      this.status = 'error';
      cleanUrl();
      return false;
    }
    if (!code) return false;

    const verifier = localStorage.getItem(STORAGE_VERIFIER);
    if (!verifier) {
      this.lastError = 'Потерян code_verifier — авторизуйтесь заново';
      this.status = 'error';
      cleanUrl();
      return false;
    }

    try {
      await this.exchange(new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: verifier,
      }));
      localStorage.removeItem(STORAGE_VERIFIER);
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.status = 'error';
      return false;
    } finally {
      cleanUrl();
    }
  }

  start(): void {
    if (this.timer !== null || !this.tokens) return;
    this.status = 'connecting';
    void this.poll();
    this.timer = window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer === null && this.status === 'disabled') return;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.status = 'disabled';
  }

  disconnect(): void {
    this.stop();
    this.tokens = null;
    localStorage.removeItem(STORAGE_TOKENS);
    this.emit(null);
  }

  private async poll(): Promise<void> {
    const token = await this.accessToken();
    if (!token) return;

    let response: Response;
    try {
      response = await fetch(API_URL, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      this.status = 'error';
      this.lastError = `Сеть недоступна: ${(err as Error).message}`;
      return;
    }

    if (response.status === 204) {
      // Ничего не играет — это нормальное состояние, не ошибка.
      this.status = 'connected';
      this.lastError = null;
      this.emit(null);
      return;
    }
    if (response.status === 401) {
      this.tokens = null;
      localStorage.removeItem(STORAGE_TOKENS);
      this.status = 'error';
      this.lastError = 'Токен отозван, нужна повторная авторизация';
      return;
    }
    if (!response.ok) {
      this.status = 'error';
      this.lastError = `Spotify API: ${response.status}`;
      return;
    }

    const payload = (await response.json()) as SpotifyCurrentlyPlaying;
    this.status = 'connected';
    this.lastError = null;
    this.emit(toTrack(payload));
  }

  private async accessToken(): Promise<string | null> {
    if (!this.tokens) return null;
    if (Date.now() < this.tokens.expiresAt - TOKEN_MARGIN_MS) return this.tokens.accessToken;
    if (!this.tokens.refreshToken) return null;

    try {
      await this.exchange(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: this.clientId,
      }));
      return this.tokens?.accessToken ?? null;
    } catch (err) {
      this.status = 'error';
      this.lastError = `Не удалось обновить токен: ${(err as Error).message}`;
      return null;
    }
  }

  private async exchange(body: URLSearchParams): Promise<void> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`token endpoint: ${response.status}`);

    const payload = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    this.tokens = {
      accessToken: payload.access_token,
      // При refresh Spotify не всегда присылает новый refresh_token — храним старый.
      refreshToken: payload.refresh_token ?? this.tokens?.refreshToken ?? null,
      expiresAt: Date.now() + payload.expires_in * 1000,
    };
    localStorage.setItem(STORAGE_TOKENS, JSON.stringify(this.tokens));
    this.status = 'connected';
    this.lastError = null;
  }

  private emit(track: NowPlayingTrack | null): void {
    for (const listener of this.listeners) listener(track);
  }
}

interface SpotifyCurrentlyPlaying {
  is_playing: boolean;
  progress_ms: number | null;
  item: {
    name: string;
    duration_ms: number;
    artists: Array<{ name: string }>;
    album: { images: Array<{ url: string; width: number }> };
  } | null;
}

function toTrack(payload: SpotifyCurrentlyPlaying): NowPlayingTrack | null {
  if (!payload.item) return null;
  const images = payload.item.album.images ?? [];
  // Берём самую крупную: она же идёт в фон, мелкая там мылится.
  const cover = images.reduce<{ url: string; width: number } | null>(
    (best, image) => (!best || image.width > best.width ? image : best),
    null,
  );
  return {
    title: payload.item.name,
    artist: payload.item.artists.map((artist) => artist.name).join(', '),
    coverUrl: cover?.url ?? null,
    progressMs: payload.progress_ms ?? 0,
    durationMs: payload.item.duration_ms,
    isPlaying: payload.is_playing,
    source: 'spotify',
    receivedAt: performance.now(),
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function cleanUrl(): void {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url.toString());
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes).slice(0, length);
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
