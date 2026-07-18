import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// S2: the Android web entry now mounts the REAL Windows POS renderer
// (src/renderer/windows/pos/POSApp), which is React + JSX (.tsx). The React
// plugin is required to transform that JSX, and the shared aliases mirror
// vite.config.ts so any renderer/shared module resolves identically. The
// renderer itself is byte-identical — this config only changes how it builds.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/renderer/android-pos'),
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/android-web'),
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/android-pos/index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        // S6+S7: isolate the sql.js UMD (guarded typeof-process environment
        // probes) into one vendor chunk so the boundary verifier can exempt
        // exactly that file in shim graphs while scanning all app chunks.
        manualChunks(id: string) {
          if (/node_modules\/sql\.js\//.test(id)) return 'vendor-sqljs';
          return undefined;
        },
      },
    },
  },
});
