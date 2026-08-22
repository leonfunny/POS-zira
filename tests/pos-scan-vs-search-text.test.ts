import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIN_SCAN_BURST_LENGTH,
  SCAN_CHAIN_GAP_MS,
  SCAN_ENTER_GRACE_MS,
  createScanChain,
  isManualCodeEntry,
  isPlausibleScanCode,
  resetScanChain,
  resolveEnterSubmission,
  trackScanChain,
} from '../src/renderer/components/pos/scan-wedge';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Regression: leftover search text ("dưa bao tử") + a wedge scan submitted the
 * whole field as one "barcode", missed every lookup, and opened the bare-create
 * modal named after the search text. The wedge burst must be separated from the
 * human-typed prefix before anything is treated as a scanned code.
 */
describe('scan-wedge burst discrimination', () => {
  const EAN = '8935049501234';

  function typeBurst(chain: ReturnType<typeof createScanChain>, prefix: string, code: string, startAt: number, gap = 8): { value: string; at: number } {
    let value = prefix;
    let at = startAt;
    for (const ch of code) {
      const next = value + ch;
      trackScanChain(chain, value, next, at);
      value = next;
      at += gap;
    }
    return { value, at };
  }

  it('extracts only the scanner burst when the field still holds search text', () => {
    const chain = createScanChain();
    const { value, at } = typeBurst(chain, 'dưa bao tử', EAN, 10_000);
    const resolution = resolveEnterSubmission(chain, value, at + 10);
    expect(resolution).toEqual({ kind: 'scan', code: EAN });
  });

  it('handles a React-batched single-event append of the whole code', () => {
    const chain = createScanChain();
    trackScanChain(chain, 'dưa bao tử', `dưa bao tử${EAN}`, 10_000);
    const resolution = resolveEnterSubmission(chain, `dưa bao tử${EAN}`, 10_020);
    expect(resolution).toEqual({ kind: 'scan', code: EAN });
  });

  it('strips IME residue committed inside the same insertion', () => {
    const chain = createScanChain();
    // Composition commit merged the pending syllable with the first digits.
    trackScanChain(chain, 'dưa bao ', `dưa bao tử${EAN}`, 10_000);
    const resolution = resolveEnterSubmission(chain, `dưa bao tử${EAN}`, 10_015);
    expect(resolution).toEqual({ kind: 'scan', code: EAN });
  });

  it('treats slow human typing + Enter as search text, never a barcode', () => {
    const chain = createScanChain();
    let value = '';
    let at = 10_000;
    for (const ch of 'dua bao tu') {
      const next = value + ch;
      trackScanChain(chain, value, next, at);
      value = next;
      at += 200; // human typing cadence
    }
    expect(resolveEnterSubmission(chain, value, at + 50)).toEqual({ kind: 'search-text' });
  });

  it('still accepts a hand-typed numeric EAN submitted with Enter', () => {
    const chain = createScanChain();
    let value = '';
    let at = 10_000;
    for (const ch of EAN) {
      const next = value + ch;
      trackScanChain(chain, value, next, at);
      value = next;
      at += 250;
    }
    expect(resolveEnterSubmission(chain, value, at + 400)).toEqual({ kind: 'manual-code', code: EAN });
  });

  it('does not submit short ASCII search words on Enter', () => {
    const chain = createScanChain();
    let value = '';
    let at = 10_000;
    for (const ch of 'coca') {
      const next = value + ch;
      trackScanChain(chain, value, next, at);
      value = next;
      at += 180;
    }
    expect(resolveEnterSubmission(chain, value, at + 50)).toEqual({ kind: 'search-text' });
  });

  it('does not mistake a fast human typing roll for a scan when Enter comes late', () => {
    // 4 chars rolled quickly, but the hand then travels to Enter — ~200ms is
    // a realistic human reach, while a scanner fires its Enter suffix within
    // ~30ms of the last char. Deliberately hardcoded (not derived from
    // SCAN_ENTER_GRACE_MS) so loosening the grace past human reach time
    // fails this test: that exact loosening is what made quick typing +
    // Enter submit-and-clear the search box (gm repro, 2026-08-22).
    const chain = createScanChain();
    const { value, at } = typeBurst(chain, '', 'caot', 10_000, 30);
    expect(SCAN_ENTER_GRACE_MS).toBeLessThan(200);
    expect(resolveEnterSubmission(chain, value, at + 200)).toEqual({ kind: 'search-text' });
  });

  it('ignores a stale burst once the Enter grace window has passed', () => {
    const chain = createScanChain();
    const { at } = typeBurst(chain, 'dưa bao tử', EAN, 10_000);
    const resolution = resolveEnterSubmission(chain, `dưa bao tử${EAN}`, at + SCAN_ENTER_GRACE_MS + 500);
    expect(resolution).toEqual({ kind: 'search-text' });
  });

  it('resets the chain on deletions so edited text never counts as a burst', () => {
    const chain = createScanChain();
    const { value, at } = typeBurst(chain, '', EAN, 10_000);
    trackScanChain(chain, value, value.slice(0, -1), at); // backspace
    expect(resolveEnterSubmission(chain, value.slice(0, -1), at + 10)).toEqual({ kind: 'manual-code', code: EAN.slice(0, -1) });
    // A non-numeric edited field falls back to plain search text.
    const chain2 = createScanChain();
    typeBurst(chain2, '', 'abcd', 10_000, 8);
    trackScanChain(chain2, 'abcd', 'abc', 10_040);
    expect(resolveEnterSubmission(chain2, 'abc', 10_050)).toEqual({ kind: 'search-text' });
  });

  it('a gap above the chain threshold starts a new burst instead of extending the old one', () => {
    const chain = createScanChain();
    typeBurst(chain, '', '1234', 10_000, 8);
    // Pause, then a genuine scan arrives.
    const { value, at } = typeBurst(chain, '1234', EAN, 10_000 + 4 * 8 + SCAN_CHAIN_GAP_MS + 200, 8);
    expect(resolveEnterSubmission(chain, value, at + 10)).toEqual({ kind: 'scan', code: EAN });
  });

  it('resetScanChain clears a submitted burst so a trailing terminator cannot double-submit', () => {
    const chain = createScanChain();
    const { at } = typeBurst(chain, '', EAN, 10_000);
    resetScanChain(chain);
    expect(resolveEnterSubmission(chain, '', at + 5)).toEqual({ kind: 'search-text' });
  });

  it('requires the minimum burst length before treating input as a scan', () => {
    const chain = createScanChain();
    const short = '123'.slice(0, MIN_SCAN_BURST_LENGTH - 1);
    const { value, at } = typeBurst(chain, '', short, 10_000);
    expect(resolveEnterSubmission(chain, value, at + 5)).toEqual({ kind: 'search-text' });
  });

  it('validates plausible scan codes for the import/bare-create gate', () => {
    expect(isPlausibleScanCode('8935049501234')).toBe(true);
    expect(isPlausibleScanCode('ABC-123_9.X')).toBe(true);
    expect(isPlausibleScanCode('dưa bao tử')).toBe(false);
    expect(isPlausibleScanCode('dưa bao tử8935049501234')).toBe(false);
    expect(isPlausibleScanCode('coca cola')).toBe(false);
    expect(isPlausibleScanCode('ab')).toBe(false);
    expect(isPlausibleScanCode('9'.repeat(101))).toBe(false);
  });

  it('manual entry must look like a typed numeric code, not a word', () => {
    expect(isManualCodeEntry('8935049501234')).toBe(true);
    expect(isManualCodeEntry('590123')).toBe(true);
    expect(isManualCodeEntry('coca')).toBe(false);
    expect(isManualCodeEntry('duabaotu')).toBe(false);
    expect(isManualCodeEntry('1234')).toBe(false);
    expect(isManualCodeEntry('893 5049')).toBe(false);
  });
});

describe('wiring: SearchBar discriminates scans from search text', () => {
  const searchBar = readSource('../src/renderer/components/pos/SearchBar.tsx');

  it('routes Enter/Tab through resolveEnterSubmission instead of submitting the raw field', () => {
    expect(searchBar).toContain('resolveEnterSubmission(');
    expect(searchBar).toContain('trackScanChain(');
    expect(searchBar).not.toContain('submitBarcode(e.currentTarget.value, e.currentTarget)');
  });

  it('leaves plain search text alone on Enter', () => {
    expect(searchBar).toContain("if (resolution.kind === 'search-text') return;");
  });

  it('ignores the Enter that commits an IME composition', () => {
    expect(searchBar).toMatch(/isComposing/);
  });

  it('resets the burst chain after every submit so scanner terminators cannot double-fire', () => {
    const start = searchBar.indexOf('const submitBarcode = useCallback');
    expect(start).toBeGreaterThan(-1);
    const end = searchBar.indexOf('}, [onChange]);', start);
    expect(end).toBeGreaterThan(-1);
    expect(searchBar.slice(start, end)).toContain('resetScanChain(');
  });
});

describe('wiring: retail search clears after a manual selection', () => {
  const retail = readSource('../src/renderer/components/pos/templates/retail/RetailTemplate.tsx');

  it('clears the search box once a searched product is added to the cart', () => {
    const start = retail.indexOf('const handleAddProduct = useCallback');
    expect(start).toBeGreaterThan(-1);
    const end = retail.indexOf('const handlePrintProductCode', start);
    expect(end).toBeGreaterThan(-1);
    const block = retail.slice(start, end);
    expect(block).toContain("dispatch({ type: 'cart/addItem', payload: result.item });");
    // The clear runs after an awaited IPC roundtrip, so it must be guarded:
    // only when the query is still the one that produced this add. An
    // unguarded clear wiped searches the cashier was mid-typing (gm repro,
    // 2026-08-22).
    expect(block).toContain('const queryAtAdd = searchQueryRef.current;');
    expect(block).toMatch(/source === 'manual' && queryAtAdd && searchQueryRef\.current === queryAtAdd/);
    expect(block).toContain("handleSearchChange('')");
    // And it must never yank focus away from a field the cashier moved to.
    expect(block).toContain('typingElsewhere');
    // The draft route hands off to the scan-import modal — the stale query
    // must not survive underneath it either (cleared without stealing focus
    // from the modal).
    const draftBranch = block.slice(0, block.indexOf('resolveRetailCartItem'));
    expect(draftBranch).toMatch(/source === 'manual'[\s\S]{0,40}handleSearchChange\(''\)/);
  });
});

describe('wiring: bare-create modal never opens for an implausible code', () => {
  const posLayout = readSource('../src/renderer/components/pos/POSLayout.tsx');

  it('gates openScanImport behind isPlausibleScanCode with a not-found toast', () => {
    const start = posLayout.indexOf('const openScanImport = useCallback');
    expect(start).toBeGreaterThan(-1);
    const firstLookup = posLayout.indexOf('draftProducts.getByBarcode', start);
    expect(firstLookup).toBeGreaterThan(-1);
    const gate = posLayout.slice(start, firstLookup);
    expect(gate).toContain('isPlausibleScanCode(');
    expect(gate).toContain('showScanToast(');
    expect(gate).toContain('products.scan.notFound');
  });
});
