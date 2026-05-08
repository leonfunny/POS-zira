import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { toPromoImageUrl } from '../src/main/pos/promo-image-url';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  getPromoImages: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/main/config/store', () => ({
  getConfigValue: vi.fn((key: string) => mocks.config[key]),
  getSecureAuthToken: vi.fn(() => 'token'),
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: {
    getPromoImages: mocks.getPromoImages,
  },
}));

import { PromoLoader } from '../src/main/pos/promo-loader';

describe('PromoLoader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'zira-promo-'));
    mocks.getPromoImages.mockReset();
    for (const key of Object.keys(mocks.config)) delete mocks.config[key];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses configured local folder images before the backend API', async () => {
    const imagePath = join(tempDir, 'banner.jpg');
    writeFileSync(imagePath, 'fake image');
    mocks.config.customerDisplayPromoFolder = tempDir;

    const images = await new PromoLoader().getImages();

    expect(images).toEqual([toPromoImageUrl(imagePath)]);
    expect(mocks.getPromoImages).not.toHaveBeenCalled();
  });

  it('falls back to backend API when the local folder has no images', async () => {
    mocks.config.customerDisplayPromoFolder = tempDir;
    mocks.getPromoImages.mockResolvedValue(['https://example.test/banner.jpg']);

    const images = await new PromoLoader().getImages();

    expect(images).toEqual(['https://example.test/banner.jpg']);
    expect(mocks.getPromoImages).toHaveBeenCalledTimes(1);
  });
});
