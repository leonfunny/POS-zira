import type { AndroidDbPersistence } from '../../src/renderer/android-pos/shim/db/db';

/** Explicit test storage; production must never fall back to volatile memory. */
export class MemoryAndroidPersistence implements AndroidDbPersistence {
  image: Uint8Array | null = null;
  failSave = false;
  async loadImage() { return this.image?.slice() ?? null; }
  async saveImage(image: Uint8Array) {
    if (this.failSave) throw new Error('Test storage write failed');
    this.image = image.slice();
  }
  async quarantineImage() {}
}
