import { mergeConfig, type Plugin } from 'vite';

import androidConfig from './vite.android.config';

const LIVE_HOST = '100.72.205.122';
const requestedLivePort = Number(process.env.ANDROID_LIVE_PORT || 5173);
if (!Number.isInteger(requestedLivePort) || requestedLivePort < 1024 || requestedLivePort > 65_535) {
  throw new Error(`ANDROID_LIVE_PORT must be an integer from 1024 to 65535; received ${process.env.ANDROID_LIVE_PORT}`);
}
const LIVE_PORT = requestedLivePort;
const LIVE_BOOTSTRAP_ID = '/@android-live-bootstrap';
const RESOLVED_LIVE_BOOTSTRAP_ID = `\0${LIVE_BOOTSTRAP_ID}`;

function allowLiveReloadSocket(): Plugin {
  return {
    name: 'android-live-reload-csp',
    resolveId(id) {
      if (id === LIVE_BOOTSTRAP_ID) return RESOLVED_LIVE_BOOTSTRAP_ID;
    },
    load(id) {
      if (id === RESOLVED_LIVE_BOOTSTRAP_ID) {
        return `localStorage.setItem('zira.dev.apiUrl', window.location.origin);`;
      }
    },
    transformIndexHtml(html) {
      return html
        .replace(
          "connect-src 'self' https://api.enail.pro",
          `connect-src 'self' https://api.enail.pro ws://${LIVE_HOST}:${LIVE_PORT}`,
        )
        .replace(
          '</head>',
          `<script type="module" src="${LIVE_BOOTSTRAP_ID}"></script></head>`,
        );
    },
  };
}

export default mergeConfig(androidConfig, {
  plugins: [allowLiveReloadSocket()],
  server: {
    host: LIVE_HOST,
    port: LIVE_PORT,
    strictPort: true,
    hmr: {
      host: LIVE_HOST,
      port: LIVE_PORT,
      protocol: 'ws',
    },
    proxy: {
      '/api': {
        target: 'https://api.enail.pro',
        changeOrigin: true,
        secure: true,
        headers: {
          Origin: 'https://api.enail.pro',
          Referer: 'https://api.enail.pro/',
        },
      },
      '/print-agent': {
        target: 'https://api.enail.pro',
        changeOrigin: true,
        secure: true,
        ws: true,
        headers: {
          Origin: 'https://api.enail.pro',
        },
      },
    },
  },
  clearScreen: false,
});
