/// <reference types="vite/client" />
import type { SoundVisionApi } from '@shared/ipc';

declare global {
  interface Window {
    sv: SoundVisionApi;
  }
}
