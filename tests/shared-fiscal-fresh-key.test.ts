import { describe, expect, it } from 'vitest';
import { shouldMintFreshFiscalKey } from '../src/main/printing/shared-print-retry-policy';

// The whole point of this gate is to NEVER produce a duplicate fiscal paragon.
// A fresh idempotency key creates a NEW job, so it is only allowed when the
// prior job terminally failed BEFORE the ELZAB printed anything.
describe('shouldMintFreshFiscalKey (duplicate-paragon safety gate)', () => {
  it('allows a fresh key ONLY for a terminal failure that happened before printing', () => {
    expect(shouldMintFreshFiscalKey({ printed: false, status: 'FAILED', failureClass: 'SAFE_BEFORE_PRINT' })).toBe(true);
    expect(shouldMintFreshFiscalKey({ printed: false, status: 'CANCELLED', failureClass: 'SAFE_BEFORE_PRINT' })).toBe(true);
  });

  it('NEVER mints a fresh key when the paragon might have printed', () => {
    // Uncertain-after-print: the receipt may already be out — a new job would
    // duplicate it. Must stay blocked for human reconciliation.
    expect(shouldMintFreshFiscalKey({ printed: false, status: 'FAILED', failureClass: 'UNCERTAIN_AFTER_PRINT' })).toBe(false);
    expect(shouldMintFreshFiscalKey({ printed: false, status: 'FAILED', failureClass: 'FINAL' })).toBe(false);
    expect(shouldMintFreshFiscalKey({ printed: false, status: 'FAILED', failureClass: null })).toBe(false);
  });

  it('never mints a fresh key for a printed or still-in-flight job', () => {
    expect(shouldMintFreshFiscalKey({ printed: true, status: 'COMPLETED', failureClass: null })).toBe(false);
    // still-printing (#4 poll budget) surfaces as a non-terminal status — do NOT
    // re-issue while the paragon may still be feeding.
    expect(shouldMintFreshFiscalKey({ printed: false, status: 'IN_FLIGHT', failureClass: null })).toBe(false);
    expect(shouldMintFreshFiscalKey({ printed: false, status: 'SENT', failureClass: 'SAFE_BEFORE_PRINT' })).toBe(false);
    expect(shouldMintFreshFiscalKey({ printed: false, status: '', failureClass: 'SAFE_BEFORE_PRINT' })).toBe(false);
  });
});
