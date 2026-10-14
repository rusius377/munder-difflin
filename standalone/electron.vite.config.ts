/**
 * The standalone trading desk reuses the Munder Difflin sources one folder up
 * (src/main/trading, src/shared/trading.ts, the trading screens and locales)
 * instead of copying them. Bare imports from those files resolve to THIS
 * folder's node_modules (dedupe), so the desk builds without installing the
 * office app's dependencies.
 */
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const repo = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const define = { __APP_VERSION__: JSON.stringify(pkg.version) };
const shared = ['react', 'react-dom', 'react-i18next', 'i18next', 'react-markdown', 'remark-gfm'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    define,
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    resolve: {
      alias: {
        '@': resolve(repo, 'src/renderer/src'),
        '@shared': resolve(repo, 'src/shared'),
        '@desk': resolve(__dirname, 'src/renderer')
      },
      dedupe: shared
    },
    server: { fs: { allow: [repo] } }
  }
});
