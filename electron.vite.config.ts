import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { target: 'chrome140' },
  },
});
