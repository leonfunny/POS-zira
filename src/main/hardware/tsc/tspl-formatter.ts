/**
 * TSPL / TSPL2 formatter for TSC label printers.
 *
 * TSC printers do NOT speak ZPL. A few models ship a ZPL emulation mode, but
 * it is off by default and lossy, so driving them through the Zebra path only
 * works by accident. Their native language is TSPL2, which is a display list:
 * set up the media, clear the buffer with CLS, emit drawing commands, PRINT.
 *
 * Two output shapes are produced here:
 *
 *  - `formatLabel()` — a plain barcode/price label drawn with the printer's
 *    internal bitmap fonts. Fast, crisp, and what LABEL jobs use. Internal
 *    fonts are code-page based, so text is transliterated to ASCII first.
 *
 *  - `formatFabricTag()` — a garment care tag. Everything except the barcode
 *    arrives pre-rasterised (see fabric-tag-renderer.ts) and goes out as one
 *    BITMAP block, because a fabric tag needs Vietnamese diacritics, a logo,
 *    and ISO 3758 care symbols that no internal font can render.
 */
import type { BarcodeType, FabricTagData, LabelData } from '../../../shared/types';
import type { MonoBitmap } from './fabric-tag-renderer';

/** TSPL barcode selector per symbology. QR has its own command. */
const BARCODE_COMMANDS: Record<Exclude<BarcodeType, 'AUTO' | 'QR'>, string> = {
  CODE128: '128',
  EAN13: 'EAN13',
};

/** Control characters would terminate a TSPL command line early. */
function isControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** Unicode combining diacritical marks (U+0300-U+036F). */
function isCombiningMark(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x0300 && code <= 0x036f;
}

/** Printable ASCII, the only range the internal bitmap fonts cover. */
function isPrintableAscii(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

/** Non-ASCII characters that survive NFD stripping and still need a stand-in. */
const ASCII_TRANSLITERATION: Record<string, string> = {
  'đ': 'd', 'Đ': 'D',   // đ Đ — Vietnamese d-with-stroke
  'ł': 'l', 'Ł': 'L',   // ł Ł — Polish l-with-stroke
  'ı': 'i', 'İ': 'I',   // ı İ — Turkish dotless/dotted i
  '–': '-', '—': '-',   // en/em dash
  '‘': "'", '’': "'",   // curly single quotes
  '“': '"', '”': '"',   // curly double quotes
  '…': '...',
  '·': '-',                  // middle dot, used as a composition separator
  '€': 'EUR',
};

/** Millimetres of tag height reserved for the natively-drawn barcode zone. */
const BARCODE_ZONE_MM = 13;

/**
 * Thinnest bar a 1D symbol may use, in dots. At 203dpi one dot is 0.125mm —
 * about half the EAN13 minimum module, and fabric spreads ink enough to close
 * the gaps at that width. Below this the caller switches to a QR code.
 */
const MIN_BARCODE_MODULE_DOTS = 2;

export interface TsplMediaOptions {
  /** Gap between labels in mm. Ignored when sensor is 'none'. */
  gapMm?: number;
  /** Print speed in inches/second. */
  speed?: number;
  /** Burn darkness, 0-15. */
  density?: number;
  /** Media sensor type. */
  sensor?: 'gap' | 'bline' | 'none';
}

/**
 * Accumulates TSPL into a Buffer.
 *
 * A Buffer rather than a string because BITMAP embeds raw binary bytes that
 * any multi-byte text encoding would mangle on the way to the spooler.
 */
export class TsplBuilder {
  private chunks: Buffer[] = [];

  /** Append one CRLF-terminated TSPL command. */
  cmd(line: string): this {
    this.chunks.push(Buffer.from(`${line}\r\n`, 'latin1'));
    return this;
  }

  /** Append text with no terminator — for a command that is followed by binary. */
  partial(text: string): this {
    this.chunks.push(Buffer.from(text, 'latin1'));
    return this;
  }

  /** Append raw bytes (BITMAP payload). */
  raw(buffer: Buffer): this {
    this.chunks.push(buffer);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class TsplFormatter {
  constructor(
    private labelWidthMm: number = 40,
    private labelHeightMm: number = 60,
    private dpi: number = 203,
    private media: TsplMediaOptions = {},
  ) {}

  setDimensions(widthMm: number, heightMm: number): void {
    this.labelWidthMm = widthMm;
    this.labelHeightMm = heightMm;
  }

  setMedia(media: TsplMediaOptions): void {
    this.media = { ...this.media, ...media };
  }

  getDimensions(): { widthMm: number; heightMm: number } {
    return { widthMm: this.labelWidthMm, heightMm: this.labelHeightMm };
  }

  /** Dots for a millimetre value at the printer's head resolution. */
  mmToDots(mm: number): number {
    return Math.round((mm / 25.4) * this.dpi);
  }

  get widthDots(): number {
    return this.mmToDots(this.labelWidthMm);
  }

  get heightDots(): number {
    return this.mmToDots(this.labelHeightMm);
  }

  /**
   * Height in mm available to the rasterised graphic block on a fabric tag.
   * The barcode zone is only reserved when there is actually a barcode.
   */
  graphicHeightMm(hasBarcode: boolean): number {
    if (!hasBarcode) return this.labelHeightMm;
    return Math.max(this.labelHeightMm * 0.4, this.labelHeightMm - BARCODE_ZONE_MM);
  }

  /**
   * TSPL string literal escaping. Strings are double-quoted and TSPL2 uses
   * backslash as the escape character, so both must be escaped. Control
   * characters would terminate the command early, so they are dropped.
   */
  private quote(text: string): string {
    const escaped = String(text ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .split('')
      .map((ch) => (isControl(ch) ? ' ' : ch))
      .join('');
    return `"${escaped}"`;
  }

  /** Internal fonts are code-page based — fold anything outside ASCII. */
  private toAscii(text: string, maxLength = 60): string {
    const folded = String(text ?? '')
      .normalize('NFD')
      .split('')
      // Drop combining marks so Vietnamese/Polish letters keep their base form.
      .filter((ch) => !isCombiningMark(ch))
      .map((ch) => ASCII_TRANSLITERATION[ch] ?? ch)
      .join('')
      .split('')
      .filter(isPrintableAscii)
      .join('');
    return folded.trim().slice(0, maxLength);
  }

  private resolveBarcodeType(barcode: string, requested?: BarcodeType): Exclude<BarcodeType, 'AUTO'> {
    if (requested && requested !== 'AUTO') return requested;
    return /^\d{13}$/.test(barcode) ? 'EAN13' : 'CODE128';
  }

  /**
   * Total modules a symbol occupies, quiet zones included.
   * EAN13 is a fixed 95 modules; CODE128-B is start + 11 per character +
   * checksum + a 13-module stop pattern.
   */
  private barcodeModules(type: Exclude<BarcodeType, 'AUTO' | 'QR'>, content: string): number {
    if (type === 'EAN13') return 95 + 18;
    return 11 * (content.length + 2) + 13 + 20;
  }

  /**
   * Widest module that still fits the media, in dots.
   *
   * Narrow media is the reason this exists: a 20mm fabric ribbon is 160 dots,
   * and a fixed 2-dot module puts an EAN13 at 190 dots — off the edge of the
   * ribbon, printing a symbol that cannot scan.
   *
   * Returns 0 when the symbol cannot be drawn at a scannable size, which tells
   * the caller to use a QR instead. "Fits" is not the bar: a 1-dot module at
   * 203dpi is 0.125mm, roughly half the EAN13 minimum, and woven fabric
   * spreads ink enough to close the gaps at that size. 2 dots (0.25mm) is the
   * practical floor.
   */
  private barcodeModuleWidth(type: Exclude<BarcodeType, 'AUTO' | 'QR'>, content: string, usableDots: number): number {
    const modules = this.barcodeModules(type, content);
    if (modules <= 0) return 0;
    const fitted = Math.floor(usableDots / modules);
    if (fitted < MIN_BARCODE_MODULE_DOTS) return 0;
    // Cap at 3: wider bars waste tag length without helping a 203dpi scanner.
    return Math.min(3, fitted);
  }

  /**
   * QR cell size in dots, sized to the media.
   *
   * A version-2 QR is 25 modules across. It is square, so it has to fit the
   * shorter of the two axes: constraining only the width lets the symbol run
   * off the bottom of a short tag. Clamped to 3..8 — below 3 a phone camera
   * struggles at 203dpi.
   */
  private qrCellSize(usableDots: number, availableHeightDots?: number): number {
    const box = availableHeightDots !== undefined
      ? Math.min(usableDots, availableHeightDots)
      : usableDots;
    return Math.max(3, Math.min(8, Math.floor(box / 25)));
  }

  private copies(quantity: number): number {
    const n = Number(quantity);
    return Number.isFinite(n) ? Math.max(1, Math.min(999, Math.round(n))) : 1;
  }

  /**
   * Media setup + CLS. Every job starts here so a tag never inherits the
   * geometry of whatever was printed before it.
   */
  header(builder: TsplBuilder, labelHeightMmOverride?: number): TsplBuilder {
    const sensor = this.media.sensor ?? 'gap';
    const gapMm = this.media.gapMm ?? 2;
    // Continuous media has no pitch to honour, so a tag may declare the length
    // its content actually needs instead of the configured maximum.
    const heightMm = labelHeightMmOverride ?? this.labelHeightMm;
    builder.cmd(`SIZE ${this.labelWidthMm} mm,${heightMm} mm`);
    if (sensor === 'bline') builder.cmd(`BLINE ${gapMm} mm,0 mm`);
    else if (sensor === 'none') builder.cmd('GAP 0 mm,0 mm');
    else builder.cmd(`GAP ${gapMm} mm,0 mm`);
    builder.cmd('DIRECTION 1,0');
    builder.cmd('REFERENCE 0,0');
    builder.cmd(`SPEED ${this.media.speed ?? 3}`);
    builder.cmd(`DENSITY ${Math.max(0, Math.min(15, Math.round(this.media.density ?? 10)))}`);
    builder.cmd('SET TEAR ON');
    builder.cmd('CLS');
    return builder;
  }

  /**
   * Emit `BITMAP x,y,widthBytes,heightDots,mode,<binary>`.
   *
   * The payload starts immediately after the last comma with no separator, so
   * the command text and the bytes have to be written as one unterminated run
   * — a CRLF there would be consumed as the first two pixels of the image.
   */
  private bitmap(builder: TsplBuilder, x: number, y: number, image: MonoBitmap): void {
    builder.partial(`BITMAP ${x},${y},${image.widthBytes},${image.heightDots},0,`);
    builder.raw(image.data);
    builder.partial('\r\n');
  }

  /**
   * Plain product label: name, barcode, price, detail line.
   * Mirrors what ZplFormatter.formatLabel produces so LABEL jobs look the
   * same whichever brand of printer they land on.
   */
  formatLabel(data: LabelData): Buffer {
    const b = this.header(new TsplBuilder());
    const margin = this.mmToDots(2);
    const inner = this.widthDots - margin * 2;

    // Font "3" is the 16x24 internal font; multipliers scale it in whole steps.
    let y = margin;
    const title = this.toAscii(data.text1 || data.barcode, 40);
    if (title) {
      b.cmd(`BLOCK ${margin},${y},${inner},${this.mmToDots(8)},"3",0,1,1,0,2,${this.quote(title)}`);
      y += this.mmToDots(8);
    }

    const barcode = String(data.barcode || '').trim();
    if (barcode) {
      const type = this.resolveBarcodeType(barcode, data.barcodeType);
      const module = type === 'QR' ? 0 : this.barcodeModuleWidth(type, barcode, inner);
      if (type === 'QR' || module === 0) {
        // Too narrow for bars — a QR still scans in the space a 1D symbol needs.
        const cell = this.qrCellSize(inner, this.heightDots - y - margin);
        b.cmd(`QRCODE ${margin},${y},M,${cell},A,0,${this.quote(barcode)}`);
        y += this.mmToDots(20);
      } else {
        const barHeight = Math.max(this.mmToDots(8), Math.round(this.heightDots * 0.3));
        b.cmd(`BARCODE ${margin},${y},"${BARCODE_COMMANDS[type]}",${barHeight},1,0,${module},${module * 2},${this.quote(barcode)}`);
        // +6mm clears the human-readable digits the printer draws under the bars.
        y += barHeight + this.mmToDots(6);
      }
    }

    const price = this.toAscii(data.text2 || '', 24);
    if (price) {
      b.cmd(`TEXT ${margin},${y},"3",0,2,2,${this.quote(price)}`);
      y += this.mmToDots(7);
    }

    const detail = this.toAscii(data.text3 || '', 40);
    if (detail) {
      b.cmd(`TEXT ${margin},${y},"2",0,1,1,${this.quote(detail)}`);
    }

    b.cmd(`PRINT 1,${this.copies(data.quantity)}`);
    return b.build();
  }

  /**
   * Garment care tag.
   *
   * `graphic` is the pre-rendered top block (logo/brand, size, composition,
   * care symbols, price). The barcode is drawn natively underneath it: printer
   * firmware rasterises bars far more accurately than a downsampled bitmap,
   * and a fabric tag that will not scan at the till is a defective tag.
   */
  formatFabricTag(
    data: FabricTagData,
    graphic: MonoBitmap | null,
    labelHeightMmOverride?: number,
  ): Buffer {
    const b = this.header(new TsplBuilder(), labelHeightMmOverride);
    const margin = this.mmToDots(2);
    const barcode = String(data.barcode || '').trim();

    if (graphic) this.bitmap(b, 0, 0, graphic);

    if (barcode) {
      const y = graphic ? graphic.heightDots + this.mmToDots(1) : margin;
      const inner = this.widthDots - margin * 2;
      const type = this.resolveBarcodeType(barcode, data.barcodeType);
      const module = type === 'QR' ? 0 : this.barcodeModuleWidth(type, barcode, inner);
      // A narrow fabric ribbon cannot hold a 1D symbol at a scannable module
      // width, so fall back to QR rather than print bars that run off the edge.
      if (data.useQrCode || type === 'QR' || module === 0) {
        const cell = this.qrCellSize(inner, this.heightDots - y - margin);
        b.cmd(`QRCODE ${margin},${y},M,${cell},A,0,${this.quote(barcode)}`);
      } else {
        const barHeight = Math.max(this.mmToDots(6), this.heightDots - y - this.mmToDots(5));
        b.cmd(`BARCODE ${margin},${y},"${BARCODE_COMMANDS[type]}",${barHeight},1,0,${module},${module * 2},${this.quote(barcode)}`);
      }
    }

    b.cmd(`PRINT 1,${this.copies(data.quantity)}`);
    return b.build();
  }

  /** Print a self-test tag so the user can eyeball media alignment and darkness. */
  formatTestPrint(): Buffer {
    const b = this.header(new TsplBuilder());
    const margin = this.mmToDots(2);
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    b.cmd(`TEXT ${margin},${margin},"3",0,1,1,${this.quote('ZIRA TSPL TEST')}`);
    b.cmd(`TEXT ${margin},${margin + this.mmToDots(7)},"2",0,1,1,${this.quote(`${this.labelWidthMm} x ${this.labelHeightMm} mm`)}`);
    b.cmd(`TEXT ${margin},${margin + this.mmToDots(12)},"2",0,1,1,${this.quote(stamp)}`);
    b.cmd(`BOX ${margin},${margin + this.mmToDots(17)},${this.widthDots - margin},${this.heightDots - margin},3`);
    b.cmd('PRINT 1,1');
    return b.build();
  }
}
