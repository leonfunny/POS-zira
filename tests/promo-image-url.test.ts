import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  isPathInsideDirectory,
  isSupportedPromoImagePath,
  promoImageUrlToPath,
  toPromoImageUrl,
} from '../src/main/pos/promo-image-url';

describe('promo image URL helpers', () => {
  it('round-trips a local image path through the app promo protocol', () => {
    const imagePath = join('C:\\Users\\pc\\display-banner', 'best salon 1.jpg');
    const url = toPromoImageUrl(imagePath);

    expect(url.startsWith('zira-promo://local/')).toBe(true);
    expect(promoImageUrlToPath(url)).toBe(imagePath);
  });

  it('allows only supported image extensions', () => {
    expect(isSupportedPromoImagePath('banner.JPG')).toBe(true);
    expect(isSupportedPromoImagePath('banner.webp')).toBe(true);
    expect(isSupportedPromoImagePath('notes.txt')).toBe(false);
  });

  it('rejects paths outside the configured promo directory', () => {
    const folder = join('C:\\Users\\pc', 'display-banner');

    expect(isPathInsideDirectory(join(folder, 'banner.jpg'), folder)).toBe(true);
    expect(isPathInsideDirectory(join('C:\\Users\\pc', 'other', 'banner.jpg'), folder)).toBe(false);
  });
});
