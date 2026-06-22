import { describe, expect, it } from 'vitest';
import {
  getRendererDevServerUrl,
  shouldUseRendererDevServer,
} from '../src/main/windows/renderer-dev-server';

describe('renderer dev server selection', () => {
  it('does not use the Vite dev server just because NODE_ENV is development', () => {
    expect(shouldUseRendererDevServer({ NODE_ENV: 'development' })).toBe(false);
  });

  it('uses the Vite dev server when explicitly requested', () => {
    expect(shouldUseRendererDevServer({ ZIRA_RENDERER_DEV_SERVER: '1' })).toBe(true);
    expect(shouldUseRendererDevServer({ ZIRA_RENDERER_DEV_SERVER: 'true' })).toBe(true);
  });

  it('returns the configured dev server URL or the local Vite default', () => {
    expect(getRendererDevServerUrl({})).toBe('http://localhost:3100');
    expect(getRendererDevServerUrl({ ZIRA_RENDERER_DEV_SERVER_URL: 'http://127.0.0.1:4173' }))
      .toBe('http://127.0.0.1:4173');
  });
});
