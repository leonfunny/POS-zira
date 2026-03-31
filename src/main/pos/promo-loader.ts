import { readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { pathToFileURL } from 'url';
import logger from '../logger';
import { getConfigValue, getSecureAuthToken } from '../config/store';
import { apiClient } from '../network/api-client';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.jfif', '.avif']);

export class PromoLoader {
  private cachedImages: string[] = [];
  private lastFetchTime: number = 0;
  private cacheTtlMs: number = 300000; // 5 min cache

  async getImages(): Promise<string[]> {
    // 1. Try backend API (if auth token exists + cache expired)
    if (Date.now() - this.lastFetchTime > this.cacheTtlMs) {
      const apiImages = await this.fetchFromApi();
      if (apiImages.length > 0) {
        this.cachedImages = apiImages;
        this.lastFetchTime = Date.now();
        return this.cachedImages;
      }
    }
    if (this.cachedImages.length > 0) return this.cachedImages;

    // 2. Fallback: scan local folder
    const localImages = this.scanLocalFolder();
    if (localImages.length > 0) return localImages;

    return [];
  }

  private async fetchFromApi(): Promise<string[]> {
    try {
      const authToken = getSecureAuthToken();
      if (!authToken) return [];
      const images = await apiClient.getPromoImages(authToken);
      if (images.length > 0) {
        logger.info(`[PromoLoader] Fetched ${images.length} promo images from API`);
      }
      return images;
    } catch (err) {
      logger.debug(`[PromoLoader] API fetch failed: ${err}`);
      return [];
    }
  }

  private scanLocalFolder(): string[] {
    try {
      const folder = getConfigValue('customerDisplayPromoFolder') as string | undefined;
      if (!folder) return [];

      const files = readdirSync(folder);
      const images: string[] = [];

      for (const file of files) {
        const ext = extname(file).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(ext)) continue;
        const fullPath = join(folder, file);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile()) {
            images.push(pathToFileURL(fullPath).toString());
          }
        } catch {
          // skip unreadable files
        }
      }

      if (images.length > 0) {
        logger.info(`[PromoLoader] Found ${images.length} local promo images in ${folder}`);
      }
      return images;
    } catch (err) {
      logger.debug(`[PromoLoader] Local folder scan failed: ${err}`);
      return [];
    }
  }

  clearCache(): void {
    this.cachedImages = [];
    this.lastFetchTime = 0;
  }
}
