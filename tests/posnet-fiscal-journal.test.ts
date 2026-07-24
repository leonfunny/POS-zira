import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

// POSNET fiscal idempotency: the trinit/trline/trpayment/trend sequence opens
// a REAL fiscal transaction, so it must carry the same fiscal_attempts
// journal discipline as the ELZAB path — no silent duplicate paragons, and
// ambiguous outcomes go to the Order History reconciliation flow.
describe('posnet fiscal journal parity with ELZAB', () => {
  const driverSource = readSource('src/main/hardware/posnet/posnet-driver.ts');

  it('journals every fiscal receipt attempt (pending -> sent -> success)', () => {
    expect(driverSource).toContain('this.fiscalJournal.createPending({');
    expect(driverSource).toContain('this.fiscalJournal.markSent(attempt.id)');
    expect(driverSource).toContain('this.fiscalJournal.markSuccess(attempt.id');
  });

  it('blocks automatic retries when a prior attempt is confirmed or unknown', () => {
    expect(driverSource).toContain('this.fiscalJournal.findBlockingAttempt(orderId, paymentId)');
    expect(driverSource).toContain('FISCAL_ATTEMPT_RETRY_BLOCKED');
    expect(driverSource).toContain('FISCAL_IDEMPOTENCY_KEY_MISSING');
  });

  it('classifies pre-send failures as FAILED and post-send errors as UNKNOWN', () => {
    expect(driverSource).toContain('failedBeforeAnyByteSent()');
    expect(driverSource).toContain("code === 'PORT_BUSY' || code === 'PORT_NOT_FOUND'");
    expect(driverSource).toContain("markUnknown(attempt.id, 'POSNET_THROWN_AFTER_SENT'");
    expect(driverSource).toContain('FISCAL_RESULT_UNKNOWN: POSNET');
  });

  it('refuses the misleading thermal profile instead of bypassing the fiscal journal', () => {
    expect(driverSource).toContain("this.assertPrintProtocolSupported('print receipts')");
    expect(driverSource).toContain('const attempt = this.createReceiptAttempt(data)');
    expect(driverSource).toContain('POSNET_THERMAL_PROTOCOL_UNSUPPORTED');
  });

  it('surfaces ambiguous outcomes to the POS like ELZAB does', () => {
    const hardwareSource = readSource('src/main/modules/hardware.module.ts');
    expect(driverSource).toContain('onFiscalUnknown?.({ orderId: data.orderId');
    // Both POSNET construction sites route to the same renderer banner.
    const posnetUnknownWires = hardwareSource
      .split('new PosnetDriver(')
      .slice(1)
      .filter((chunk) => chunk.slice(0, 400).includes("'pos:fiscal-unknown'"));
    expect(posnetUnknownWires.length).toBeGreaterThanOrEqual(2);
  });
});
