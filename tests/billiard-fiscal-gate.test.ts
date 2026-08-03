/**
 * The billiard settle gates, now shared by Windows and Android
 * (src/shared/pos/billiard-fiscal-gate.ts). Decisions D1/D2 of
 * docs/android-pos/2026-08-02-billiard-pos-handoff-port-plan.md §5.
 *
 * Ending a session is the point of no return — it stops the clock, freezes the
 * bill and hands it to POS. These tests pin that every gate fails CLOSED: the
 * table keeps running rather than a session ending with no way to issue its
 * fiscal receipt.
 */
import { describe, expect, test } from 'vitest';

import {
  assertBilliardFiscalPrinterReady,
  assertBilliardRealFiscalGate,
  requiresBilliardFiscalPrinterReadiness,
  TABLET_NOT_PAIRED_MESSAGE,
} from '../src/shared/pos/billiard-fiscal-gate';

describe('requiresBilliardFiscalPrinterReadiness', () => {
  test('a register with no fiscal route at all does not require a printer', () => {
    expect(requiresBilliardFiscalPrinterReadiness({})).toBe(false);
    expect(requiresBilliardFiscalPrinterReadiness({ fiscalOnCashSale: 'never' })).toBe(false);
  });

  test('ANY fiscal signal turns the requirement on', () => {
    expect(requiresBilliardFiscalPrinterReadiness({ allowRealFiscalPrint: true })).toBe(true);
    expect(requiresBilliardFiscalPrinterReadiness({ fiscalOnCashSale: 'always' })).toBe(true);
    expect(requiresBilliardFiscalPrinterReadiness({ localFiscalEnabled: true })).toBe(true);
    expect(requiresBilliardFiscalPrinterReadiness({ detectedFiscalConfigured: true })).toBe(true);
  });
});

describe('assertBilliardRealFiscalGate — the production go-live gate', () => {
  test('a configured fiscal route with the gate off is refused', () => {
    expect(() => assertBilliardRealFiscalGate({ fiscalOnCashSale: 'always' }))
      .toThrow(/REAL_FISCAL_PRINT_DISABLED/);
    expect(() => assertBilliardRealFiscalGate({ localFiscalEnabled: true }))
      .toThrow(/REAL_FISCAL_PRINT_DISABLED/);
    expect(() => assertBilliardRealFiscalGate({ detectedFiscalConfigured: true }))
      .toThrow(/REAL_FISCAL_PRINT_DISABLED/);
  });

  test('passes once the gate is explicitly enabled, and when no route is configured', () => {
    expect(() => assertBilliardRealFiscalGate({ fiscalOnCashSale: 'always', allowRealFiscalPrint: true })).not.toThrow();
    expect(() => assertBilliardRealFiscalGate({})).not.toThrow();
  });

  test('a tablet cannot slip past it by claiming a local fiscal device', () => {
    // D1: Android hard-codes localFiscalEnabled=false precisely so this gate
    // keeps its meaning. If a tablet ever claimed one, the gate must still bite.
    expect(() => assertBilliardRealFiscalGate({ localFiscalEnabled: true, allowRealFiscalPrint: false }))
      .toThrow(/REAL_FISCAL_PRINT_DISABLED/);
  });
});

describe('assertBilliardFiscalPrinterReady — D1', () => {
  test('no fiscal route → nothing to be ready for', () => {
    expect(() => assertBilliardFiscalPrinterReady({})).not.toThrow();
    expect(() => assertBilliardFiscalPrinterReady({ fiscalChannelConnected: false })).not.toThrow();
  });

  test('Windows: a required printer that is configured-but-not-connected is refused', () => {
    expect(() => assertBilliardFiscalPrinterReady({
      allowRealFiscalPrint: true,
      detectedFiscalConfigured: true,
      fiscalChannelConnected: false, // caller passes configured && connected
    })).toThrow(/fiscal printer is not ready/i);
  });

  test('Android: ASSIGNED alone is not enough — the print-agent link must be live', () => {
    // The tablet owns no printer; the socket to the agent that owns it IS the
    // fiscal path. `assigned` (which is all the assignment lookup exposes)
    // must not be mistaken for liveness.
    expect(() => assertBilliardFiscalPrinterReady({
      allowRealFiscalPrint: true,
      detectedFiscalConfigured: true, // fiscal printer assigned to the salon
      localFiscalEnabled: false,      // a tablet never has a local fiscal device
      fiscalChannelConnected: false,  // print-agent socket down
    })).toThrow(/fiscal printer is not ready/i);

    expect(() => assertBilliardFiscalPrinterReady({
      allowRealFiscalPrint: true,
      detectedFiscalConfigured: true,
      localFiscalEnabled: false,
      fiscalChannelConnected: true,   // assigned AND the agent link is up
    })).not.toThrow();
  });

  test('an undefined channel signal is treated as NOT ready (fails closed)', () => {
    expect(() => assertBilliardFiscalPrinterReady({ allowRealFiscalPrint: true }))
      .toThrow(/fiscal printer is not ready/i);
  });
});

describe('D2 — an unpaired tablet cannot settle', () => {
  test('the refusal names the fix instead of a bare identity error', () => {
    expect(TABLET_NOT_PAIRED_MESSAGE).toMatch(/pair/i);
    expect(TABLET_NOT_PAIRED_MESSAGE).toMatch(/print-agent/i);
    // It also explains WHY, since the two gates are really one rule: the same
    // agent prints the fiscal receipt for the bill being settled.
    expect(TABLET_NOT_PAIRED_MESSAGE).toMatch(/fiscal receipt/i);
  });
});
