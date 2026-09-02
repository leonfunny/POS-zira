/**
 * Turns a packaging-sticker request into a concrete print job for the Windows
 * driver path, and serialises those jobs.
 *
 * Kept apart from `hardware.module.ts` so the resolution rules (which printer,
 * what geometry, how many copies) can be tested without Electron.
 */
import { PrintersConfig, PrinterType } from '../../../shared/types';
import {
  PackagingStickerInput,
  buildPackagingStickerHtml,
  parsePackagingSticker,
} from '../../../shared/packaging-sticker';

/** Matches the Settings default for the LABEL slot. */
const DEFAULT_LABEL_WIDTH_MM = 50;
const DEFAULT_LABEL_HEIGHT_MM = 30;
const MAX_COPIES = 999;

export interface PackagingStickerRequest
  extends Omit<PackagingStickerInput, 'widthMm' | 'heightMm'> {
  quantity?: number;
}

export interface PackagingStickerJob {
  printerName: string;
  widthMm: number;
  heightMm: number;
  copies: number;
  html: string;
}

/**
 * Resolve a request against the current printer configuration.
 *
 * @throws with an operator-readable message when the LABEL slot cannot take the
 *   job, or when the sticker itself is invalid.
 */
export function resolvePackagingStickerJob(
  request: PackagingStickerRequest,
  printers: PrintersConfig | undefined,
): PackagingStickerJob {
  const config = printers?.[PrinterType.LABEL];
  if (!config) throw new Error('No label printer configured');
  if (!config.enabled) throw new Error('The label printer is disabled in Settings');

  const printerName = String(config.windowsPrinter || '').trim();
  if (!printerName) {
    throw new Error('The label printer has no Windows print queue selected');
  }

  const requested = request.quantity ?? 1;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    throw new Error('Packaging sticker: quantity must be a finite number');
  }
  const copies = Math.max(1, Math.min(MAX_COPIES, Math.round(requested)));

  const widthMm = positiveOr(config.labelWidth, DEFAULT_LABEL_WIDTH_MM);
  const heightMm = positiveOr(config.labelHeight, DEFAULT_LABEL_HEIGHT_MM);

  const sticker = parsePackagingSticker({ ...request, widthMm, heightMm });

  return { printerName, widthMm, heightMm, copies, html: buildPackagingStickerHtml(sticker) };
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * One sticker job at a time.
 *
 * The fabric lane has its own gate (`FabricTagPrintGate`); this one covers the
 * paper printer so a double-clicked Print cannot enqueue two runs. A rejected
 * call has sent nothing to the spooler.
 */
export class PackagingStickerPrintGate {
  private running: Promise<unknown> | null = null;

  isBusy(): boolean {
    return this.running !== null;
  }

  async runExclusive<T>(job: () => Promise<T>): Promise<T> {
    if (this.running) {
      throw new Error('A packaging sticker print run is already in progress');
    }
    const task = (async () => job())();
    this.running = task;
    try {
      return await task;
    } finally {
      this.running = null;
    }
  }
}
