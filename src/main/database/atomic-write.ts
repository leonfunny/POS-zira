import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'fs';

/**
 * Write `data` to `targetPath` atomically: write to `<targetPath>.tmp`, fsync
 * to flush the OS page cache, then rename over the target. If the process is
 * killed mid-write, the original target file remains intact — at worst a stale
 * `.tmp` is left behind, which the next write truncates. `fs.renameSync` on
 * Windows uses `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` and is atomic for files
 * on the same volume; on POSIX it's a single `rename(2)` call.
 */
export function atomicWriteFileSync(targetPath: string, data: Buffer): void {
  const tmpPath = `${targetPath}.tmp`;
  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
}
