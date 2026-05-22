import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'fs';
import { open, rename } from 'fs/promises';

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

/**
 * Async sibling of {@link atomicWriteFileSync}. Same atomic semantics
 * (write `<targetPath>.tmp`, fsync, rename) but lets the Node event loop keep
 * running while the write is in flight, so renderer IPC calls don't stall
 * behind a multi-megabyte sync write.
 */
export async function atomicWriteFile(targetPath: string, data: Buffer): Promise<void> {
  const tmpPath = `${targetPath}.tmp`;
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, targetPath);
}
