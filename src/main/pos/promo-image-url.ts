import { extname, isAbsolute, relative, resolve } from 'path';

export const PROMO_IMAGE_PROTOCOL = 'zira-promo';
export const PROMO_IMAGE_HOST = 'local';
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.jfif', '.avif']);

export function toPromoImageUrl(filePath: string): string {
  return `${PROMO_IMAGE_PROTOCOL}://${PROMO_IMAGE_HOST}/${encodeURIComponent(filePath)}`;
}

export function promoImageUrlToPath(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    if (url.protocol !== `${PROMO_IMAGE_PROTOCOL}:` || url.hostname !== PROMO_IMAGE_HOST) return null;

    const encodedPath = url.pathname.replace(/^\/+/, '');
    if (!encodedPath) return null;
    return decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
}

export function isSupportedPromoImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const resolvedFile = resolve(filePath);
  const resolvedDirectory = resolve(directory);
  const rel = relative(resolvedDirectory, resolvedFile);

  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
