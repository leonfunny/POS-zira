const DEFAULT_RENDERER_DEV_SERVER_URL = 'http://localhost:3100';

export function shouldUseRendererDevServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.ZIRA_RENDERER_DEV_SERVER || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function getRendererDevServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = String(env.ZIRA_RENDERER_DEV_SERVER_URL || DEFAULT_RENDERER_DEV_SERVER_URL).trim()
    || DEFAULT_RENDERER_DEV_SERVER_URL;
  return url.replace(/\/+$/, '');
}
