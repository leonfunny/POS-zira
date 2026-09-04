// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readImageFile,
  shrinkDataUrl,
  uploadImageToVariants,
} from '../src/renderer/components/label/image-file';

/** An Image that cannot decode anything — what a harness has. */
class FailingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

/** An Image that decodes to a fixed size, so the shrink maths can be pinned. */
function imageOf(width: number, height: number) {
  return class {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  };
}

describe('readImageFile', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FailingImage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a type the catalogue will not take', async () => {
    const file = new File(['%PDF'], 'sheet.pdf', { type: 'application/pdf' });
    expect(await readImageFile(file, 512)).toBeNull();
  });

  it('sends the original when the picture cannot be shrunk here', async () => {
    const file = new File(['abc'], 'moon.png', { type: 'image/png' });
    const picked = await readImageFile(file, 512);
    expect(picked).toEqual({
      dataUrl: 'data:image/png;base64,YWJj',
      fileName: 'moon.png',
      mimeType: 'image/png',
    });
  });
});

describe('shrinkDataUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves a picture alone that is already small enough', async () => {
    vi.stubGlobal('Image', imageOf(400, 300));
    expect(await shrinkDataUrl('data:image/png;base64,YWJj', 512)).toBeNull();
  });

  it('gives up rather than hang on a picture that never decodes', async () => {
    vi.stubGlobal('Image', FailingImage);
    expect(await shrinkDataUrl('data:image/png;base64,YWJj', 512)).toBeNull();
  });

  it('draws a large picture down to the ceiling as a JPEG', async () => {
    vi.stubGlobal('Image', imageOf(4000, 3000));
    const drawImage = vi.fn();
    const created = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'canvas') return created(tag);
      const canvas: any = { width: 0, height: 0 };
      canvas.getContext = () => ({ drawImage });
      canvas.toDataURL = (type: string) => `data:${type};base64,c2hydW5r`;
      return canvas;
    });
    const out = await shrinkDataUrl('data:image/png;base64,YWJj', 1024);
    expect(out).toBe('data:image/jpeg;base64,c2hydW5r');
    // 4000x3000 at a 1024 ceiling: 1024x768.
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1024, 768);
    vi.restoreAllMocks();
  });
});

describe('uploadImageToVariants', () => {
  const image = { dataUrl: 'data:image/jpeg;base64,YWJj', fileName: 'a.jpg', mimeType: 'image/jpeg' as const };

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it('uploads to every row in turn and keeps score', async () => {
    const calls: string[] = [];
    const uploadMainImage = vi.fn(async (variantId: string) => {
      calls.push(variantId);
      if (variantId === 'v2') return { ok: false, error: 'stale' };
      if (variantId === 'v3') throw new Error('offline');
      return { ok: true, data: {} };
    });
    (window as any).electronAPI = { pos: { productAdmin: { uploadMainImage } } };

    const outcome = await uploadImageToVariants(['v1', 'v2', 'v3', 'v4'], image);
    expect(calls).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(outcome).toEqual({ uploaded: ['v1', 'v4'], failed: ['v2', 'v3'] });
    expect(uploadMainImage.mock.calls[0][1]).toEqual({
      dataUrl: image.dataUrl,
      fileName: 'a.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('counts every row as failed when the bridge is missing', async () => {
    (window as any).electronAPI = { pos: {} };
    expect(await uploadImageToVariants(['v1'], image)).toEqual({ uploaded: [], failed: ['v1'] });
  });
});
