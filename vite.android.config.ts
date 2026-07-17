import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer/android-pos'),
  base: './',
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
      },
    },
  },
});
