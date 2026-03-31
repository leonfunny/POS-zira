let cachedServerUrl: string | null = null;

async function getServerUrl(): Promise<string> {
  if (cachedServerUrl) return cachedServerUrl;
  try {
    const config = await window.electronAPI.getConfig();
    cachedServerUrl = config?.serverUrl || 'https://api.enail.pro';
  } catch {
    cachedServerUrl = 'https://api.enail.pro';
  }
  return cachedServerUrl;
}

// Synchronous version using cached value
export function getUploadUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const base = cachedServerUrl || 'https://api.enail.pro';
  if (path.startsWith('/uploads')) return `${base}${path}`;
  return `${base}/uploads/${path}`;
}

// Initialize cache early
export function initImageUtils() {
  getServerUrl();
}
