/**
 * Keyboard-wedge scan discrimination for the POS search input.
 *
 * In retail mode every wedge scan is routed into the visible search box
 * (POSLayout.focusBarcode), so the box can hold BOTH leftover human search
 * text and a freshly scanned code. Submitting the whole field as a "barcode"
 * is what put Vietnamese search text in front of the bare-create modal
 * (2026-08-22): "dưa bao tử" + <scan> missed every lookup and offered to
 * create a product named after the search text.
 *
 * The main-process HidScanner already discriminates by keystroke timing
 * (50ms between chars) and charset for the unfocused path; this module gives
 * the focused-input path the same discipline. Insertions are chained while
 * they arrive faster than any human types; on Enter/Tab only that burst is
 * treated as the scanned code, and whatever the human typed stays search
 * text.
 */

/** Max ms between input events that still belong to one wedge burst.
 * Scanners emit chars every 1–30ms; sustained sub-80ms typing is beyond
 * human cadence. Slightly looser than HidScanner's 50ms because renderer
 * input events can jitter under load. */
export const SCAN_CHAIN_GAP_MS = 80;

/** Max ms between the last burst char and its terminating Enter/Tab. */
export const SCAN_ENTER_GRACE_MS = 500;

/** Shortest burst accepted as a scan — mirrors HidScanner.MIN_LENGTH. */
export const MIN_SCAN_BURST_LENGTH = 4;

/** Charset/length a code must have before the scan-import / bare-create
 * modal may open for it — mirrors HidScanner.isValidBarcode, so the focused
 * and unfocused scanner paths accept the same shapes. Anything with spaces
 * or non-ASCII (i.e. search text) can never reach the create-product form. */
const PLAUSIBLE_SCAN_CODE_RE = /^[A-Za-z0-9\-_.]{3,100}$/;

/** A code the cashier typed by hand and submitted with Enter: numeric only
 * (EAN/UPC/internal codes), long enough to not collide with short search
 * words. Alphanumeric SKUs are found via live search results instead. */
const MANUAL_CODE_ENTRY_RE = /^\d{6,20}$/;

export interface ScanChain {
  /** Concatenated text of the current rapid-insertion chain. */
  text: string;
  /** Timestamp (ms) of the last tracked input event. */
  lastEventAt: number;
}

export function createScanChain(): ScanChain {
  return { text: '', lastEventAt: 0 };
}

export function resetScanChain(chain: ScanChain): void {
  chain.text = '';
  chain.lastEventAt = 0;
}

/**
 * Track one controlled-input change. Pure appends chain up while rapid;
 * deletions/replacements (human edits, IME rewrites) break the chain — a
 * scanner never rewrites what it already typed.
 */
export function trackScanChain(
  chain: ScanChain,
  prevValue: string,
  nextValue: string,
  nowMs: number,
): void {
  if (nextValue.length > prevValue.length && nextValue.startsWith(prevValue)) {
    const inserted = nextValue.slice(prevValue.length);
    if (chain.text && nowMs - chain.lastEventAt <= SCAN_CHAIN_GAP_MS) {
      chain.text += inserted;
    } else {
      chain.text = inserted;
    }
    chain.lastEventAt = nowMs;
    return;
  }
  chain.text = '';
  chain.lastEventAt = nowMs;
}

export type EnterResolution =
  | { kind: 'scan'; code: string }
  | { kind: 'manual-code'; code: string }
  | { kind: 'search-text' };

export function isPlausibleScanCode(code: string): boolean {
  return PLAUSIBLE_SCAN_CODE_RE.test(code);
}

export function isManualCodeEntry(value: string): boolean {
  return MANUAL_CODE_ENTRY_RE.test(value);
}

/** Longest printable-ASCII (no space) suffix of the chain — scanner wedge
 * charset. Strips IME residue (e.g. a committed "tử") that the composition
 * merged into the same insertion as the first digits. */
function asciiTail(text: string): string {
  const match = text.match(/[\x21-\x7E]+$/);
  return match ? match[0] : '';
}

/**
 * Decide what an Enter/Tab in the search input means.
 *  - A fresh rapid burst → that burst alone is the scanned code.
 *  - Otherwise a hand-typed numeric code → submit the whole field.
 *  - Otherwise it is plain search text → not a scan at all.
 */
export function resolveEnterSubmission(
  chain: ScanChain,
  fieldValue: string,
  nowMs: number,
): EnterResolution {
  const burst = asciiTail(chain.text);
  if (
    burst.length >= MIN_SCAN_BURST_LENGTH
    && chain.lastEventAt > 0
    && nowMs - chain.lastEventAt <= SCAN_ENTER_GRACE_MS
  ) {
    return { kind: 'scan', code: burst };
  }
  const trimmed = fieldValue.trim();
  if (trimmed && isManualCodeEntry(trimmed)) {
    return { kind: 'manual-code', code: trimmed };
  }
  return { kind: 'search-text' };
}
