import { mkdirSync, copyFileSync, rmSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import type { TvAdMediaType } from './ad-types';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface AddedVideo { id: string; filename: string; type: TvAdMediaType; durationMs?: number; }

export class AdVideoStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  addVideo(srcPath: string): AddedVideo {
    const ext = extname(srcPath).toLowerCase();
    const type = this.mediaTypeForExtension(ext);
    if (!type) {
      throw new Error(`Unsupported ad media type "${ext}". Use mp4/m4v/mov video or jpg/png/webp image.`);
    }
    const id = `ad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const filename = `${id}${ext}`;
    copyFileSync(srcPath, join(this.baseDir, filename));
    return type === 'image' ? { id, filename, type, durationMs: 7000 } : { id, filename, type };
  }

  removeVideo(filename: string): void {
    // chỉ cho phép xoá file trong baseDir (chống path traversal)
    const safe = basename(filename);
    const full = join(this.baseDir, safe);
    if (existsSync(full)) rmSync(full, { force: true });
  }

  resolvePath(_id: string, filename: string): string {
    return join(this.baseDir, basename(filename));
  }

  exists(filename: string): boolean {
    return existsSync(join(this.baseDir, basename(filename)));
  }

  getContentType(filename: string): string {
    return CONTENT_TYPES[extname(filename).toLowerCase()] || 'application/octet-stream';
  }

  inferType(filename: string): TvAdMediaType {
    return this.mediaTypeForExtension(extname(filename).toLowerCase()) || 'video';
  }

  private mediaTypeForExtension(ext: string): TvAdMediaType | null {
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    return null;
  }
}
