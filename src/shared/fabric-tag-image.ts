import type { FabricTagRasterMime } from './types';

export interface RasterImageDimensions {
  width: number;
  height: number;
}

function invalidImage(detail: string): never {
  throw new TypeError(`Invalid fabric tag logo image: ${detail}`);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) return '';
  let out = '';
  for (let index = offset; index < offset + length; index += 1) {
    out += String.fromCharCode(bytes[index]);
  }
  return out;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function pngDimensions(bytes: Uint8Array): RasterImageDimensions {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < 33
    || signature.some((value, index) => bytes[index] !== value)
    || view(bytes).getUint32(8, false) !== 13
    || ascii(bytes, 12, 4) !== 'IHDR'
  ) {
    invalidImage('PNG signature or IHDR is missing');
  }
  const data = view(bytes);
  const dimensions = { width: data.getUint32(16, false), height: data.getUint32(20, false) };

  let offset = 8;
  let foundEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = data.getUint32(offset, false);
    if (chunkLength > bytes.byteLength - offset - 12) invalidImage('PNG chunk is truncated');
    const chunkType = ascii(bytes, offset + 4, 4);
    if (chunkType === 'acTL') invalidImage('animated PNG logos are not supported');
    offset += chunkLength + 12;
    if (chunkType === 'IEND') {
      foundEnd = true;
      break;
    }
  }
  if (!foundEnd) invalidImage('PNG end marker is missing');
  return dimensions;
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.byteLength) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return offset;
    if (length > bytes.byteLength - offset) invalidImage('GIF data block is truncated');
    offset += length;
  }
  return invalidImage('GIF data terminator is missing');
}

function gifDimensions(bytes: Uint8Array): RasterImageDimensions {
  const signature = ascii(bytes, 0, 6);
  if (bytes.byteLength < 13 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
    invalidImage('GIF signature or logical screen descriptor is missing');
  }
  const data = view(bytes);
  let width = data.getUint16(6, true);
  let height = data.getUint16(8, true);
  let offset = 13;
  if ((bytes[10] & 0x80) !== 0) {
    offset += 3 * (1 << ((bytes[10] & 0x07) + 1));
  }
  if (offset > bytes.byteLength) invalidImage('GIF global colour table is truncated');

  let frames = 0;
  let foundEnd = false;
  while (offset < bytes.byteLength) {
    const marker = bytes[offset];
    if (marker === 0x3b) {
      foundEnd = true;
      break;
    }
    if (marker === 0x21) {
      if (offset + 2 > bytes.byteLength) invalidImage('GIF extension is truncated');
      offset = skipGifSubBlocks(bytes, offset + 2);
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 10 > bytes.byteLength) invalidImage('GIF image descriptor is truncated');
      frames += 1;
      if (frames > 1) invalidImage('animated GIF logos are not supported');
      const left = data.getUint16(offset + 1, true);
      const top = data.getUint16(offset + 3, true);
      const frameWidth = data.getUint16(offset + 5, true);
      const frameHeight = data.getUint16(offset + 7, true);
      width = Math.max(width, left + frameWidth);
      height = Math.max(height, top + frameHeight);
      const packed = bytes[offset + 9];
      offset += 10;
      if ((packed & 0x80) !== 0) {
        offset += 3 * (1 << ((packed & 0x07) + 1));
      }
      if (offset >= bytes.byteLength) invalidImage('GIF image data is missing');
      offset += 1; // LZW minimum code size
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (marker === 0x00) {
      offset += 1;
      continue;
    }
    invalidImage('GIF block marker is invalid');
  }
  if (!foundEnd || frames !== 1) invalidImage('GIF image or trailer is missing');
  return { width, height };
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): RasterImageDimensions {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    invalidImage('JPEG start-of-image marker is missing');
  }

  const data = view(bytes);
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.byteLength) break;

    const segmentLength = data.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      invalidImage('JPEG segment length is invalid');
    }
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (segmentLength < 7) invalidImage('JPEG frame header is truncated');
      return {
        height: data.getUint16(offset + 3, false),
        width: data.getUint16(offset + 5, false),
      };
    }
    offset += segmentLength;
  }

  return invalidImage('JPEG dimensions were not found before image data');
}

function uint24le(bytes: Uint8Array, offset: number): number {
  if (offset + 3 > bytes.byteLength) invalidImage('WebP dimension field is truncated');
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes: Uint8Array): RasterImageDimensions {
  if (
    bytes.byteLength < 20
    || ascii(bytes, 0, 4) !== 'RIFF'
    || ascii(bytes, 8, 4) !== 'WEBP'
  ) {
    invalidImage('WebP RIFF header is missing');
  }

  const data = view(bytes);
  let offset = 12;
  let dimensions: RasterImageDimensions | null = null;
  const includeDimensions = (next: RasterImageDimensions): void => {
    dimensions = dimensions
      ? {
        width: Math.max(dimensions.width, next.width),
        height: Math.max(dimensions.height, next.height),
      }
      : next;
  };
  while (offset + 8 <= bytes.byteLength) {
    const chunk = ascii(bytes, offset, 4);
    const chunkLength = data.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + chunkLength > bytes.byteLength) invalidImage('WebP chunk is truncated');

    if (chunk === 'VP8X') {
      if (chunkLength < 10) invalidImage('WebP VP8X header is truncated');
      if ((bytes[payload] & 0x02) !== 0) invalidImage('animated WebP logos are not supported');
      includeDimensions({
        width: uint24le(bytes, payload + 4) + 1,
        height: uint24le(bytes, payload + 7) + 1,
      });
    }
    if (chunk === 'VP8 ') {
      if (
        chunkLength < 10
        || bytes[payload + 3] !== 0x9d
        || bytes[payload + 4] !== 0x01
        || bytes[payload + 5] !== 0x2a
      ) {
        invalidImage('WebP VP8 frame header is invalid');
      }
      includeDimensions({
        width: data.getUint16(payload + 6, true) & 0x3fff,
        height: data.getUint16(payload + 8, true) & 0x3fff,
      });
    }
    if (chunk === 'VP8L') {
      if (chunkLength < 5 || bytes[payload] !== 0x2f) {
        invalidImage('WebP VP8L frame header is invalid');
      }
      const b1 = bytes[payload + 1];
      const b2 = bytes[payload + 2];
      const b3 = bytes[payload + 3];
      const b4 = bytes[payload + 4];
      includeDimensions({
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      });
    }
    if (chunk === 'ANIM' || chunk === 'ANMF') invalidImage('animated WebP logos are not supported');

    offset = payload + chunkLength + (chunkLength & 1);
  }

  return dimensions ?? invalidImage('WebP dimensions were not found');
}

/**
 * Read dimensions from bounded header bytes without asking an image decoder to
 * allocate the declared canvas. This is the first line of defence against a
 * tiny compressed file that claims a multi-gigapixel output surface.
 */
export function readRasterImageDimensions(
  bytes: Uint8Array,
  mimeType: FabricTagRasterMime,
): RasterImageDimensions {
  if (mimeType === 'image/png') return pngDimensions(bytes);
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return jpegDimensions(bytes);
  if (mimeType === 'image/gif') return gifDimensions(bytes);
  if (mimeType === 'image/webp') return webpDimensions(bytes);
  return invalidImage(`unsupported MIME type ${String(mimeType)}`);
}
