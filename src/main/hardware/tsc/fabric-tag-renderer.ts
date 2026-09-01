/**
 * Fabric tag rasteriser.
 *
 * A garment care tag carries three things no label-printer font can draw:
 * Vietnamese diacritics, a brand logo, and ISO 3758 care symbols. So the tag's
 * graphic block is laid out in HTML, painted by an offscreen BrowserWindow at
 * exactly one CSS pixel per printer dot, then thresholded into the 1-bit
 * bitmap that TSPL/ZPL want. Same pipeline the check-in label already uses to
 * print Polish text (see hardware/pdf/pdf-printer.ts), one step further: we
 * keep the pixels instead of handing them to the Windows spooler, so the
 * printer receives a byte-exact image and nothing re-renders it at driver
 * defaults.
 *
 * Care symbols are drawn as vector art rather than glyphs from a symbol font,
 * because no care-symbol font ships with Windows and a missing font would
 * silently print tofu boxes onto physical garments.
 */
import { BrowserWindow } from 'electron';
import type { FabricTagData } from '../../../shared/types';
import { careSymbolSvg } from '../../../shared/care-symbols';
import logger from '../../logger';
import {
  FabricTagInputError,
  parseFabricTagLogoDataUrl,
  type ParsedFabricTagLogo,
} from './fabric-tag-input';

/** A packed monochrome image, one bit per dot, rows padded to whole bytes. */
export interface MonoBitmap {
  widthDots: number;
  heightDots: number;
  /** Bytes per row = ceil(widthDots / 8). This is what TSPL BITMAP wants. */
  widthBytes: number;
  /**
   * Packed rows, MSB = leftmost dot.
   * Bit value 0 = black (burn), 1 = white — the TSPL BITMAP convention.
   */
  data: Buffer;
}

/** Pixels above this luminance count as white. Below it, the dot burns. */
const BLACK_THRESHOLD = 150;

/** Bound Chromium's backing surface before constructing BrowserWindow. */
export const FABRIC_TAG_RENDER_LIMITS = {
  maxDimensionDots: 8_192,
  maxPixels: 16 * 1024 * 1024,
} as const;

export function validateFabricTagRasterDimensions(widthDots: number, heightDots: number): void {
  if (
    !Number.isSafeInteger(widthDots)
    || !Number.isSafeInteger(heightDots)
    || widthDots < 1
    || heightDots < 1
  ) {
    throw new RangeError('Fabric tag raster dimensions must be positive finite integers');
  }
  if (
    widthDots > FABRIC_TAG_RENDER_LIMITS.maxDimensionDots
    || heightDots > FABRIC_TAG_RENDER_LIMITS.maxDimensionDots
  ) {
    throw new RangeError(
      `Fabric tag raster dimensions may not exceed ${FABRIC_TAG_RENDER_LIMITS.maxDimensionDots} dots`,
    );
  }
  if (widthDots * heightDots > FABRIC_TAG_RENDER_LIMITS.maxPixels) {
    throw new RangeError(
      `Fabric tag raster may not exceed ${FABRIC_TAG_RENDER_LIMITS.maxPixels} pixels`,
    );
  }
}

interface DecodedLogoState {
  decodedOk: boolean;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
}

async function assertFabricTagLogoDecoded(
  webContents: Electron.WebContents,
  expected: ParsedFabricTagLogo,
): Promise<void> {
  // Header parsing prevents declared-canvas bombs, but it cannot prove that
  // Chromium can decode the full file. Await the actual image decoder before
  // capture; a broken image otherwise suppresses the brand and produces a
  // plausible all-white bitmap that the spooler reports as successful.
  const state = await webContents.executeJavaScript(`(() => {
    const image = document.querySelector('img.logo');
    if (!image) return null;
    const read = (decodedOk) => ({
      decodedOk,
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    });
    if (typeof image.decode === 'function') {
      return image.decode().then(() => read(true), () => read(false));
    }
    if (image.complete) return read(image.naturalWidth > 0 && image.naturalHeight > 0);
    return new Promise((resolve) => {
      image.addEventListener('load', () => resolve(read(true)), { once: true });
      image.addEventListener('error', () => resolve(read(false)), { once: true });
    });
  })()`);
  const decoded = state as DecodedLogoState | null;
  if (
    !decoded?.decodedOk
    || !decoded.complete
    || decoded.naturalWidth !== expected.width
    || decoded.naturalHeight !== expected.height
  ) {
    throw new FabricTagInputError(
      'logoDataUrl',
      'a raster image that decodes to its declared dimensions',
    );
  }
}

function esc(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(grosze: number, currency: string): string {
  return `${(grosze / 100).toFixed(2)} ${currency}`;
}

// ─── HTML layout ───────────────────────────────────────────────────────────

/**
 * Build the tag's graphic block as HTML sized in printer dots.
 *
 * Sizes are derived from the tag width so a 30mm and a 60mm tag both stay
 * balanced instead of one overflowing and the other looking empty.
 */
export function buildFabricTagHtml(
  data: FabricTagData,
  widthDots: number,
  /** null lays the tag out at its natural height so it can be measured. */
  heightDots: number | null,
): string {
  const pad = Math.round(widthDots * 0.06);
  const brandSize = Math.round(widthDots * 0.13);
  const sizeSize = Math.round(widthDots * 0.16);
  const bodySize = Math.round(widthDots * 0.075);
  // Below roughly 11 dots the strokes of a lowercase letter fall between the
  // dot grid and threshold away, which is how "NATURALNY LEN" printed as
  // "ATURALNY LE" on the first fabric run. Keep the small line above that
  // floor even on a narrow 20mm ribbon.
  const smallSize = Math.max(11, Math.round(widthDots * 0.068));
  // A care label reads as one row of symbols. Size them to the count so five
  // symbols on a 20mm ribbon still fit on a single line instead of wrapping
  // and pushing the composition off the tag.
  const symbolCount = data.careSymbols?.length ?? 0;
  const symbolGapRatio = 0.18;
  const symbolRowWidth = widthDots - pad * 2;
  const symbolFit = symbolCount > 0
    ? Math.floor(symbolRowWidth / (symbolCount + symbolGapRatio * (symbolCount - 1)))
    : Number.MAX_SAFE_INTEGER;
  // Below ~14px the glyphs turn to mush, so a very long row is allowed to wrap.
  const symbolPx = Math.max(14, Math.min(Math.round(widthDots * 0.155), symbolFit));

  // Revalidate at the final HTML boundary so direct/internal callers cannot
  // bypass the IPC/socket parser or smuggle active SVG into Chromium.
  const parsedLogo = parseFabricTagLogoDataUrl(data.logoDataUrl);
  const logo = parsedLogo
    ? `<img class="logo" src="${parsedLogo.dataUrl}" alt="">`
    : '';

  const brand = !logo && data.brandName
    ? `<div class="brand">${esc(data.brandName)}</div>`
    : '';
  const size = data.size ? `<div class="size">${esc(data.size)}</div>` : '';
  const composition = data.composition
    ? `<div class="composition">${esc(data.composition)}</div>`
    : '';
  const symbols = data.careSymbols?.length
    ? `<div class="symbols">${data.careSymbols.map((s) => careSymbolSvg(s, symbolPx)).join('')}</div>`
    : '';
  const careText = data.careText ? `<div class="care-text">${esc(data.careText)}</div>` : '';
  const price = typeof data.priceGrosze === 'number' && data.priceGrosze > 0
    ? `<div class="price">${esc(formatPrice(data.priceGrosze, data.currency || 'zł'))}</div>`
    : '';

  // 'care-first' mirrors a mass-produced garment care label: symbol row on top,
  // composition under it, size anchoring the bottom.
  const body = data.layout === 'care-first'
    ? `${logo}${brand}${symbols}${composition}${size}${careText}${price}`
    : `${logo}${brand}${size}${composition}${symbols}${careText}${price}`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${widthDots}px; height: ${heightDots === null ? 'auto' : `${heightDots}px`};
    background: #fff; color: #000;
    /* Antialiasing turns into speckle once we threshold to 1 bit. */
    -webkit-font-smoothing: none;
    text-rendering: geometricPrecision;
  }
  body {
    display: flex; flex-direction: column;
    align-items: center;
    justify-content: ${heightDots === null ? 'flex-start' : (data.layout === 'care-first' ? 'space-evenly' : 'center')};
    gap: ${Math.round(pad * 0.5)}px;
    padding: ${pad}px;
    font-family: "Segoe UI", "Noto Sans", Arial, sans-serif;
    /* Bold survives thresholding; regular weight breaks up at 203 dpi. */
    font-weight: 700;
    text-align: center;
    overflow: hidden;
  }
  .logo { max-width: 100%; max-height: ${Math.round((heightDots ?? widthDots * 3) * 0.3)}px; object-fit: contain; }
  .brand, .size, .composition, .care-text, .price {
    max-width: 100%; min-width: 0;
    overflow-wrap: anywhere; word-break: break-word;
  }
  .brand { font-size: ${brandSize}px; letter-spacing: ${Math.round(brandSize * 0.08)}px; line-height: 1.1; text-transform: uppercase; }
  .size { font-size: ${sizeSize}px; line-height: 1.05; }
  .composition { font-size: ${bodySize}px; line-height: 1.25; }
  .symbols { display: flex; flex-wrap: wrap; justify-content: center; max-width: 100%; min-width: 0; gap: ${Math.round(symbolPx * symbolGapRatio)}px; }
  .care { display: block; }
  .care-text { font-size: ${smallSize}px; line-height: 1.25; }
  .price { font-size: ${bodySize}px; }
</style></head>
<body>${body}</body></html>`;
}

// ─── Rasterisation ─────────────────────────────────────────────────────────

/**
 * Pack a BGRA buffer into TSPL's 1-bit-per-dot layout.
 * Bit 0 = black so the head burns; bit 1 = white so it does not.
 */
export function packFabricTagMonochrome(
  bgra: Buffer,
  widthDots: number,
  heightDots: number,
): MonoBitmap {
  validateFabricTagRasterDimensions(widthDots, heightDots);
  const expectedBytes = widthDots * heightDots * 4;
  if (bgra.byteLength !== expectedBytes) {
    throw new RangeError(
      `Fabric tag bitmap must contain exactly ${expectedBytes} BGRA bytes; got ${bgra.byteLength}`,
    );
  }
  const widthBytes = Math.ceil(widthDots / 8);
  // Start all-white (0xFF); clear a bit to burn its dot.
  const data = Buffer.alloc(widthBytes * heightDots, 0xff);

  for (let y = 0; y < heightDots; y++) {
    const rowStart = y * widthDots * 4;
    const outRow = y * widthBytes;
    for (let x = 0; x < widthDots; x++) {
      const i = rowStart + x * 4;
      // Electron's nativeImage bitmap is BGRA.
      const b = bgra[i];
      const g = bgra[i + 1];
      const r = bgra[i + 2];
      const a = bgra[i + 3];
      // Composite onto white so a transparent logo background stays unburnt.
      const alpha = a / 255;
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) * alpha + 255 * (1 - alpha);
      if (luminance < BLACK_THRESHOLD) {
        data[outRow + (x >> 3)] &= ~(0x80 >> (x & 7));
      }
    }
  }

  return { widthDots, heightDots, widthBytes, data };
}

/**
 * Paint the tag's graphic block and return it as a packed 1-bit bitmap.
 *
 * The offscreen window is sized in dots, but a HiDPI display can still hand
 * back a 2x capture, so the image is resized to the exact dot grid before it
 * is packed — otherwise every tag would print at double scale on some
 * machines and correctly on others.
 */
export interface RenderFabricTagOptions {
  /**
   * Shrink the tag to the height its content actually needs, using
   * `heightDots` only as the ceiling. Continuous fabric has no label pitch to
   * respect, so a fixed height just feeds blank ribbon between tags.
   */
  fitHeight?: boolean;
  /** Floor for `fitHeight`, so a one-line tag is still handleable. */
  minHeightDots?: number;
}

/** Round up to a whole millimetre: TSPL takes label length in mm. */
function ceilToMm(dots: number, dotsPerMm = 8): number {
  return Math.ceil(dots / dotsPerMm) * dotsPerMm;
}

/**
 * Resolve a continuous-ribbon tag length without ever clipping content.
 * Returning the configured ceiling for overflowing content used to hide the
 * last row with `overflow:hidden` and send a plausible-looking bad tag to RAW.
 */
export function resolveFabricTagFitHeight(
  naturalHeightDots: number,
  configuredHeightDots: number,
  minHeightDots = 8,
): number {
  if (!Number.isSafeInteger(configuredHeightDots) || configuredHeightDots < 1) {
    throw new RangeError('Configured fabric tag height must be a positive finite integer');
  }
  if (!Number.isSafeInteger(naturalHeightDots) || naturalHeightDots < 1) {
    throw new RangeError('Fabric tag content height must be a positive finite integer');
  }
  if (naturalHeightDots > configuredHeightDots) {
    throw new RangeError(
      `Fabric tag content needs ${naturalHeightDots} dots but configured media allows `
      + `${configuredHeightDots}; increase label height or shorten the content`,
    );
  }
  const floor = Number.isFinite(minHeightDots)
    ? Math.max(1, Math.ceil(minHeightDots))
    : 8;
  return Math.min(
    configuredHeightDots,
    Math.max(floor, ceilToMm(naturalHeightDots)),
  );
}

/**
 * Reject when ink reaches a side edge. On a 20mm ribbon there is no room to
 * spare, and silent clipping is how "NATURALNY LEN" first printed as
 * "ATURALNY LE" -- the kind of fault nobody notices until the garments ship.
 */
export function assertNoHorizontalEdgeContact(bitmap: MonoBitmap): void {
  const columnHasInk = (x: number): boolean => {
    for (let y = 0; y < bitmap.heightDots; y++) {
      const bit = (bitmap.data[y * bitmap.widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bit === 0) return true;
    }
    return false;
  };
  const left = columnHasInk(0);
  const right = columnHasInk(bitmap.widthDots - 1);
  if (left || right) {
    throw new RangeError(
      `[FabricTag] Ink reaches the ${left && right ? 'left and right edges' : left ? 'left edge' : 'right edge'} ` +
      `of a ${(bitmap.widthDots / 8).toFixed(1)}mm tag -- content is being cut off. ` +
      'Shorten the text or widen the media.',
    );
  }
}

export async function renderFabricTagBitmap(
  data: FabricTagData,
  widthDots: number,
  heightDots: number,
  options: RenderFabricTagOptions = {},
): Promise<MonoBitmap> {
  validateFabricTagRasterDimensions(widthDots, heightDots);
  const fit = options.fitHeight === true;
  const parsedLogo = parseFabricTagLogoDataUrl(data.logoDataUrl);
  const html = buildFabricTagHtml(data, widthDots, fit ? null : heightDots);
  const win = new BrowserWindow({
    show: false,
    width: widthDots,
    height: heightDots,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (parsedLogo) await assertFabricTagLogoDecoded(win.webContents, parsedLogo);
    // Give the compositor a frame to paint the logo and web fonts.
    await new Promise((r) => setTimeout(r, 350));

    let targetHeight = heightDots;
    if (fit) {
      // Measure the laid-out content rather than trusting the configured
      // length. scrollHeight already includes the body padding.
      const natural = Number(await win.webContents.executeJavaScript(
        'Math.ceil(document.body.getBoundingClientRect().height)',
      ));
      targetHeight = resolveFabricTagFitHeight(
        natural,
        heightDots,
        options.minHeightDots,
      );
      win.setContentSize(widthDots, targetHeight);
      // The resize needs a frame of its own before the capture is valid.
      await new Promise((r) => setTimeout(r, 120));
      logger.info(
        `[FabricTag] Content measured ${natural} dots -> label length ${targetHeight} dots ` +
        `(${(targetHeight / 8).toFixed(0)}mm, ceiling ${(heightDots / 8).toFixed(0)}mm)`,
      );
    }

    let image = await win.webContents.capturePage();
    const captured = image.getSize();
    if (captured.width !== widthDots || captured.height !== targetHeight) {
      logger.debug(
        `[FabricTag] Capture ${captured.width}x${captured.height} != ${widthDots}x${targetHeight}, resizing`,
      );
      image = image.resize({ width: widthDots, height: targetHeight, quality: 'best' });
    }

    const bgra = image.toBitmap();
    const expected = widthDots * targetHeight * 4;
    if (bgra.length < expected) {
      throw new Error(`Rasteriser returned ${bgra.length} bytes, expected ${expected}`);
    }

    const bitmap = packFabricTagMonochrome(bgra, widthDots, targetHeight);
    assertNoHorizontalEdgeContact(bitmap);
    logger.info(`[FabricTag] Rasterised ${widthDots}x${targetHeight} dots (${bitmap.data.length} bytes)`);
    return bitmap;
  } finally {
    win.destroy();
  }
}
