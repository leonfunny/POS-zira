import { ipcMain } from 'electron';
import logger from '../../logger';

/**
 * HID Barcode Scanner handler
 *
 * Most barcode scanners operate in "keyboard wedge" mode,
 * sending scanned data as keyboard input very rapidly.
 *
 * This class detects rapid keystroke sequences that are
 * characteristic of barcode scanner input.
 */
export class HidScanner {
  private buffer: string = '';
  private timeout: NodeJS.Timeout | null = null;
  private onScan: ((barcode: string) => void) | null = null;
  private active = false;
  private ipcRegistered = false;

  // Timing thresholds
  private readonly CHAR_TIMEOUT = 50; // Max ms between chars (scanners are very fast)
  private readonly MIN_LENGTH = 4; // Minimum barcode length
  private readonly MAX_LENGTH = 100; // Maximum barcode length

  /**
   * Start listening for barcode scans
   */
  start(callback: (barcode: string) => void): void {
    if (this.active) {
      logger.warn('[HidScanner] Already active');
      return;
    }

    this.onScan = callback;
    this.active = true;
    this.setupInputMonitor();

    logger.info('[HidScanner] Barcode scanner listener started');
  }

  /**
   * Stop listening
   */
  stop(): void {
    this.active = false;
    this.onScan = null;
    this.buffer = '';

    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    logger.info('[HidScanner] Barcode scanner listener stopped');
  }

  /**
   * Check if active
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Setup IPC to receive keyboard events from renderer
   * Only register once to avoid duplicate handlers
   */
  private setupInputMonitor(): void {
    if (this.ipcRegistered) {
      return;
    }

    ipcMain.on('keyboard-input', (_event: any, char: string) => {
      this.handleCharacter(char);
    });

    this.ipcRegistered = true;
    logger.info('[HidScanner] IPC handler registered');
  }

  /**
   * Handle incoming character
   */
  private handleCharacter(char: string): void {
    if (!this.active) return;

    // Check for Enter key (end of barcode)
    if (char === '\r' || char === '\n' || char === 'Enter') {
      this.processScan();
      return;
    }

    // Add to buffer
    this.buffer += char;

    // Reset timeout
    if (this.timeout) {
      clearTimeout(this.timeout);
    }

    // Set timeout for end of input
    this.timeout = setTimeout(() => {
      // If timeout reached, it might be manual typing
      // Clear buffer if it doesn't look like a valid barcode
      if (this.buffer.length < this.MIN_LENGTH) {
        this.buffer = '';
      } else {
        // Process what we have
        this.processScan();
      }
    }, this.CHAR_TIMEOUT);
  }

  /**
   * Process completed scan
   */
  private processScan(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    const barcode = this.buffer.trim();
    this.buffer = '';

    // Validate barcode
    if (!this.isValidBarcode(barcode)) {
      return;
    }

    logger.info(`[HidScanner] Barcode detected: ${barcode}`);

    // Call callback
    if (this.onScan) {
      this.onScan(barcode);
    }
  }

  /**
   * Validate barcode format
   */
  private isValidBarcode(barcode: string): boolean {
    // Check length
    if (barcode.length < this.MIN_LENGTH || barcode.length > this.MAX_LENGTH) {
      return false;
    }

    // Check for common barcode patterns
    // EAN-13: 13 digits
    // EAN-8: 8 digits
    // UPC-A: 12 digits
    // Code 128: Variable length alphanumeric
    // Code 39: Alphanumeric with special chars

    // For now, accept alphanumeric strings
    return /^[A-Za-z0-9\-\_\.]+$/.test(barcode);
  }

  /**
   * Manually submit a barcode (for testing)
   */
  submitBarcode(barcode: string): void {
    if (this.onScan && this.isValidBarcode(barcode)) {
      this.onScan(barcode);
    }
  }
}
