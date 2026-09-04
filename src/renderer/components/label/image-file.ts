/**
 * A product photo picked on the label tab, and how it reaches the catalogue.
 *
 * The photo is taken on a phone and lands here at several megabytes; a style
 * has up to a dozen rows and each one is uploaded separately, so the picture
 * is shrunk once on this machine before any of that. Shrinking is best effort:
 * where the picture cannot be decoded — a harness, or a file the browser does
 * not understand — the original is sent instead, and the server's own ceiling
 * is what refuses it.
 */

export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface PickedImage {
  /** Base64 data URL, as the upload bridge takes it. */
  dataUrl: string;
  fileName: string;
  mimeType: ImageMimeType;
}

const ACCEPTED: readonly ImageMimeType[] = ['image/jpeg', 'image/png', 'image/webp'];

/** What the file input offers, in the form `accept` wants. */
export const IMAGE_ACCEPT = ACCEPTED.join(',');

/** Longest side of a photo kept on the sheet, which lives in browser storage. */
export const SHEET_IMAGE_MAX_PX = 512;

/** Longest side of a photo sent to the catalogue. */
export const CATALOG_IMAGE_MAX_PX = 1024;

/** How long a decode may take before the original is used as it is. */
const DECODE_TIMEOUT_MS = 1500;

function isAcceptedMime(value: string): value is ImageMimeType {
  return (ACCEPTED as readonly string[]).includes(value);
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('no Image'));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('undecodable image'));
    image.src = dataUrl;
  });
}

/**
 * The picture at no more than `maxPx` on its longest side, as a JPEG. Null
 * when it cannot be decoded or drawn here, or when it is already small enough
 * — the caller keeps what it had in either case.
 */
export async function shrinkDataUrl(dataUrl: string, maxPx: number): Promise<string | null> {
  let image: HTMLImageElement;
  try {
    image = await Promise.race([
      decode(dataUrl),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('decode timed out')), DECODE_TIMEOUT_MS),
      ),
    ]);
  } catch {
    return null;
  }
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return null;
  const scale = Math.min(1, maxPx / Math.max(width, height));
  if (scale >= 1) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    const out = canvas.toDataURL('image/jpeg', 0.85);
    return out.startsWith('data:image/jpeg') ? out : null;
  } catch {
    return null;
  }
}

/**
 * Read a picked file. Null for a type the catalogue will not take, so the
 * picker can say so before anything is uploaded.
 */
export async function readImageFile(file: File, maxPx: number): Promise<PickedImage | null> {
  if (!isAcceptedMime(file.type)) return null;
  const original = await readAsDataUrl(file);
  if (!original) return null;
  const shrunk = await shrinkDataUrl(original, maxPx);
  return shrunk
    ? { dataUrl: shrunk, fileName: file.name.replace(/\.[^.]+$/, '') + '.jpg', mimeType: 'image/jpeg' }
    : { dataUrl: original, fileName: file.name, mimeType: file.type };
}

export interface ImageUploadOutcome {
  uploaded: string[];
  failed: string[];
}

/**
 * Put one picture on every row of a style, one upload each — the catalogue
 * keeps images per row, and the label tab reads the picture off whichever row
 * it is showing. Rows are done in turn, not at once: the server treats each as
 * a revision of the same product, and a dozen at once is how they collide.
 * A failure on one row does not stop the rest; the caller hears about both.
 */
export async function uploadImageToVariants(
  variantIds: readonly string[],
  image: PickedImage,
): Promise<ImageUploadOutcome> {
  const outcome: ImageUploadOutcome = { uploaded: [], failed: [] };
  const bridge = (window as any).electronAPI?.pos?.productAdmin;
  for (const variantId of variantIds) {
    try {
      const result = await Promise.resolve().then(() =>
        bridge?.uploadMainImage?.(variantId, {
          dataUrl: image.dataUrl,
          fileName: image.fileName,
          mimeType: image.mimeType,
        }),
      );
      (result?.ok ? outcome.uploaded : outcome.failed).push(variantId);
    } catch {
      outcome.failed.push(variantId);
    }
  }
  return outcome;
}
