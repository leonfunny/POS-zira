/**
 * TSC label printer driver (TSPL2 over the Windows spooler, RAW datatype).
 *
 * Shares ZebraDriver's lifecycle contract — connect / healthCheck /
 * recoverPrinter / getStatus — so HardwareModule can hold it in the same
 * printer map, but speaks TSPL instead of ZPL and sends Buffers instead of
 * strings, because a rasterised fabric tag is binary.
 */
import logger from '../../logger';
import {
  listWindowsPrinters,
  isWindowsPrinterPresent,
  flushStuckPrintJobs,
  getStuckPrintJobStatus,
} from '../port-utils';
import { BRAND_PATTERNS, type RecoveryResult } from '../detection/types';
import { sendRawToPrinter } from '../windows-raw-print';
import { TsplFormatter, type TsplMediaOptions } from './tspl-formatter';
import { renderFabricTagBitmap } from './fabric-tag-renderer';
import type { FabricTagData, LabelData, PrinterStatusInfo } from '../../../shared/types';

/**
 * Windows printer-name fragments that identify a TSC device, reused from the
 * detection registry so a new TSC model only has to be added in one place.
 */
const TSC_NAME_PATTERNS: string[] =
  BRAND_PATTERNS.find((b) => b.brand === 'TSC')?.namePatterns ?? ['tsc'];

export interface TscDriverOptions extends TsplMediaOptions {
  /** Print head resolution. TSC's 2-inch desktop range is 203 dpi. */
  dpi?: number;
}

/** A tag shorter than this is hard to handle and hard to sew in. */
const MIN_TAG_LENGTH_MM = 15;

export class TscDriver {
  private printerName: string;
  private connected = false;
  private formatter: TsplFormatter;

  constructor(
    printerName: string,
    labelWidthMm: number = 40,
    labelHeightMm: number = 60,
    options: TscDriverOptions = {},
  ) {
    this.printerName = printerName;
    const { dpi, ...media } = options;
    this.formatter = new TsplFormatter(labelWidthMm, labelHeightMm, dpi ?? 203, media);
    logger.info(
      `[TscDriver] Initialized for "${printerName}" (${labelWidthMm}x${labelHeightMm}mm, ` +
      `speed=${media.speed ?? 3}, density=${media.density ?? 10}, sensor=${media.sensor ?? 'gap'})`,
    );
  }

  static async listPrinters(): Promise<string[]> {
    return listWindowsPrinters();
  }

  setLabelDimensions(widthMm: number, heightMm: number): void {
    this.formatter.setDimensions(widthMm, heightMm);
  }

  setMedia(media: TsplMediaOptions): void {
    this.formatter.setMedia(media);
  }

  /**
   * Two-stage check, same as ZebraDriver: the spooler listing is cheap but
   * lies about unplugged USB printers, so physical presence is confirmed
   * before reporting a connection. Otherwise jobs silently pile up in the
   * queue and all print at once when the cable goes back in.
   */
  async connect(): Promise<boolean> {
    try {
      logger.info(`[TscDriver] Connecting to "${this.printerName}"...`);

      const printers = await TscDriver.listPrinters();
      const inSpooler = printers.some((p) => p.toLowerCase() === this.printerName.toLowerCase());
      if (!inSpooler) {
        logger.warn(
          `[TscDriver] Printer "${this.printerName}" not found in spooler. ` +
          `Available: ${printers.join(', ') || 'none'}`,
        );
        this.connected = false;
        return false;
      }

      const present = await isWindowsPrinterPresent(this.printerName);
      if (!present) {
        logger.warn(`[TscDriver] "${this.printerName}" is in the spooler but not physically present`);
        this.connected = false;
        return false;
      }

      this.connected = true;
      logger.info(`[TscDriver] Connected to "${this.printerName}" (verified present)`);
      return true;
    } catch (error) {
      logger.error('[TscDriver] Connect error:', error);
      this.connected = false;
      return false;
    }
  }

  disconnect(): void {
    this.connected = false;
    logger.info('[TscDriver] Disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Reconnect using a new Windows printer name (RecoverableDriver contract). */
  async reconnect(newPrinterName: string): Promise<void> {
    logger.info(`[TscDriver] Reconnecting: "${this.printerName}" -> "${newPrinterName}"`);
    this.printerName = newPrinterName;
    this.connected = await isWindowsPrinterPresent(newPrinterName);
    if (!this.connected) {
      logger.warn(`[TscDriver] Reconnect failed — "${newPrinterName}" not physically present`);
    }
  }

  async healthCheck(cachedPrinters?: string[]): Promise<boolean> {
    const printers = cachedPrinters ?? await listWindowsPrinters();
    const inSpooler = printers.some((p) => p.toLowerCase() === this.printerName.toLowerCase());

    // With a caller-supplied snapshot, trust it and skip the PnP round-trip —
    // the periodic health check runs across every printer at once.
    let available = inSpooler;
    if (!cachedPrinters && inSpooler) {
      try {
        available = await isWindowsPrinterPresent(this.printerName);
      } catch {
        available = inSpooler;
      }
    }

    if (this.connected && !available) {
      logger.warn(`[TscDriver] Health check: "${this.printerName}" gone — marking disconnected`);
      this.connected = false;
    } else if (!this.connected && available) {
      logger.info(`[TscDriver] Health check: "${this.printerName}" present again — marking connected`);
      this.connected = true;
    }
    return this.connected;
  }

  /**
   * Look for the printer under a different name after it disappeared.
   * Pure: does not mutate driver state — the caller uses reconnect().
   */
  async recoverPrinter(cachedPrinters?: string[]): Promise<RecoveryResult> {
    const oldName = this.printerName;
    logger.info(`[TscDriver] Attempting recovery for "${oldName}"...`);

    try {
      const printers = cachedPrinters ?? await listWindowsPrinters();

      if (printers.some((p) => p.toLowerCase() === oldName.toLowerCase())) {
        return { recovered: true, newIdentifier: oldName, oldIdentifier: oldName, message: `Printer "${oldName}" reappeared` };
      }

      for (const name of printers) {
        const nameLower = name.toLowerCase();
        if (TSC_NAME_PATTERNS.some((p) => nameLower.includes(p))) {
          return { recovered: true, newIdentifier: name, oldIdentifier: oldName, message: `TSC printer recovered as "${name}"` };
        }
      }

      return { recovered: false, oldIdentifier: oldName, message: 'No TSC printer found in Windows' };
    } catch (err: any) {
      return { recovered: false, oldIdentifier: oldName, message: `Recovery failed: ${err.message}` };
    }
  }

  /**
   * Send a TSPL payload.
   *
   * `fast` skips the queue housekeeping. Use it for bulk label runs, where
   * paying two PowerShell round-trips per label would dominate the job.
   */
  private async printRaw(payload: Buffer, options: { fast?: boolean; docName?: string } = {}): Promise<void> {
    const present = await isWindowsPrinterPresent(this.printerName);
    if (!present) {
      this.connected = false;
      throw new Error(
        `Printer "${this.printerName}" is not physically connected. ` +
        `Check the USB cable and power, then click Detect Printers.`,
      );
    }

    if (!options.fast) {
      try {
        const flushed = await flushStuckPrintJobs(this.printerName);
        if (flushed > 0) {
          logger.warn(`[TscDriver] Pre-flight flushed ${flushed} stale job(s) from "${this.printerName}"`);
        }
      } catch { /* best-effort */ }
    }

    await sendRawToPrinter(this.printerName, payload, {
      docName: options.docName || 'Zira TSPL Label',
      tempPrefix: 'zira_tspl',
    });

    if (options.fast) return;

    // A RAW write succeeds as soon as the spooler accepts the bytes, which it
    // will do for a powered-off printer. Re-check the queue so a "success"
    // here actually means the label came out.
    await new Promise((r) => setTimeout(r, 800));
    const stuckStatus = await getStuckPrintJobStatus(this.printerName);
    if (stuckStatus) {
      logger.error(`[TscDriver] Post-flight queue check found stuck job: ${stuckStatus}`);
      try { await flushStuckPrintJobs(this.printerName); } catch { /* best-effort */ }
      this.connected = false;
      throw new Error(
        `Printer "${this.printerName}" did not accept the job (${stuckStatus}). ` +
        `Check the printer is powered on, has media loaded, and the head is closed.`,
      );
    }
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('Printer not connected');
  }

  /** Print a barcode/price label using the printer's internal fonts. */
  async printLabel(data: LabelData): Promise<void> {
    this.assertConnected();
    logger.info(`[TscDriver] Printing label (barcode: ${data.barcode}, qty: ${data.quantity})...`);
    await this.printRaw(this.formatter.formatLabel(data), { fast: true });
    logger.info('[TscDriver] Label printed successfully');
  }

  /**
   * Print a garment care tag.
   *
   * The graphic block is rasterised first so the logo, Vietnamese text, and
   * ISO 3758 care symbols all come out; the barcode is then drawn natively
   * underneath it by the printer firmware.
   */
  async printFabricTag(data: FabricTagData): Promise<void> {
    this.assertConnected();
    const hasBarcode = !!String(data.barcode || '').trim();
    logger.info(
      `[TscDriver] Printing fabric tag "${data.brandName}" ` +
      `(size: ${data.size || '-'}, symbols: ${data.careSymbols?.length ?? 0}, qty: ${data.quantity})...`,
    );

    // The configured length is a ceiling, not a target: fabric arrives as a
    // continuous ribbon, so a tag that needs 18mm should advance 18mm and not
    // feed 14mm of blank between tags. The barcode zone, when there is one,
    // still has to fit under whatever the graphic ends up using.
    const graphicCeilingMm = this.formatter.graphicHeightMm(hasBarcode);
    const graphic = await renderFabricTagBitmap(
      data,
      this.formatter.widthDots,
      this.formatter.mmToDots(graphicCeilingMm),
      { fitHeight: true, minHeightDots: this.formatter.mmToDots(MIN_TAG_LENGTH_MM) },
    );
    const dotsPerMm = this.formatter.mmToDots(1);
    const configuredMm = this.formatter.getDimensions().heightMm;
    // Clamped here rather than trusted from the rasteriser: this number is how
    // far the printer advances the media, so a bad one wastes ribbon on every
    // tag, and the driver is the last place that can still catch it.
    const graphicMm = Math.min(
      graphicCeilingMm,
      Math.ceil(graphic.heightDots / dotsPerMm),
    );
    const labelHeightMm = hasBarcode
      ? graphicMm + (configuredMm - graphicCeilingMm)
      : graphicMm;

    await this.printRaw(this.formatter.formatFabricTag(data, graphic, labelHeightMm), { docName: 'Zira Fabric Tag' });
    logger.info('[TscDriver] Fabric tag printed successfully');
  }

  async printTest(): Promise<void> {
    this.assertConnected();
    logger.info('[TscDriver] Printing test label...');
    await this.printRaw(this.formatter.formatTestPrint(), { docName: 'Zira TSPL Test' });
    logger.info('[TscDriver] Test label printed successfully');
  }

  /**
   * Run the media sensor calibration so the printer learns the gap position
   * and label length. It feeds a few labels — that is the command working,
   * not a fault.
   */
  async calibrate(sensor: 'gap' | 'bline' | 'none' = 'gap'): Promise<void> {
    this.assertConnected();
    const command = sensor === 'bline' ? 'BLINEDETECT' : 'GAPDETECT';
    logger.info(`[TscDriver] Sending calibration (${command})...`);
    await this.printRaw(Buffer.from(`${command}\r\n`, 'latin1'), { docName: 'Zira TSPL Calibration' });
    logger.info('[TscDriver] Calibration complete');
  }

  /** Expose printer name for external callers (e.g. Windows-side rendering). */
  getPrinterName(): string {
    return this.printerName;
  }

  /**
   * A garment-tag printer has no receipt media, and the config layer never
   * routes a RECEIPT slot to TSPL. Throwing keeps the driver union uniform
   * while making a misrouted receipt loud instead of silently swallowed.
   */
  async printReceipt(): Promise<never> {
    throw new Error('Receipt printing is not supported on a TSC label printer');
  }

  /** Not applicable to label printers — kept so the driver union stays uniform. */
  async displayMessage(line1: string, line2?: string): Promise<void> {
    logger.debug(`[TscDriver] displayMessage not supported: ${line1} | ${line2 || ''}`);
  }

  /** Not applicable to label printers — kept so the driver union stays uniform. */
  async openDrawer(): Promise<void> {
    logger.debug('[TscDriver] openDrawer not supported on label printers');
  }

  async getStatus(): Promise<PrinterStatusInfo> {
    const { widthMm, heightMm } = this.formatter.getDimensions();
    return {
      connected: this.connected,
      printerName: this.printerName,
      type: 'TSC',
      protocol: 'TSPL',
      connectionType: 'USB',
      paperWidth: widthMm,
      connectionState: this.connected ? 'protocol_ready' : 'disconnected',
      diagnostic: { code: 'TSPL_READY', detail: `${widthMm}x${heightMm}mm` },
    };
  }
}
