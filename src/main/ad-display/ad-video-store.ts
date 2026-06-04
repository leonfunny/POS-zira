import { mkdirSync, copyFileSync, rmSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';

const ALLOWED = new Set(['.mp4', '.m4v', '.mov']);

export interface AddedVideo { id: string; filename: string; }

export class AdVideoStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  addVideo(srcPath: string): AddedVideo {
    const ext = extname(srcPath).toLowerCase();
    if (!ALLOWED.has(ext)) {
      throw new Error(`Unsupported video type "${ext}". Use mp4 (H.264).`);
    }
    const id = `ad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const filename = `${id}${ext}`;
    copyFileSync(srcPath, join(this.baseDir, filename));
    return { id, filename };
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
}
