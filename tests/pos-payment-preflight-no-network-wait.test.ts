import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const POS_MODULE = readFileSync('src/main/modules/pos.module.ts', 'utf8');

function methodBody(name: string): string {
  const start = POS_MODULE.indexOf(`private async ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const next = POS_MODULE.indexOf('\n  private ', start + 1);
  return POS_MODULE.slice(start, next === -1 ? undefined : next);
}

describe('ordinary POS payment preflight does not wait on the network', () => {
  const body = methodBody('prepareOrdinaryPosPayment');

  it('asserts the cached server-shift verdict instead of awaiting a fresh round-trip', () => {
    expect(body).toContain('this.assertServerShiftConsistentForPayment()');
    expect(body).not.toContain('await this.awaitServerShiftConsistencyForPayment(');
    expect(body).not.toContain('await this.refreshServerShiftConsistencyForPayment(');
    expect(body).not.toContain('await this.scheduleShiftVerification(');
  });

  it('still refreshes the server verdict in the background for the next payment', () => {
    expect(body).toContain('void this.scheduleShiftVerification(openShift.id)');
  });

  it('keeps the local shift, auth-epoch and token binding checks', () => {
    expect(body).toContain('assertLocalOpenShiftMatchesSession(database, this.posStore)');
    expect(body).toContain('isPosAuthContextCurrent(authContext)');
    expect(body).toContain('this.ordinaryPaymentPreflights.set(token');
  });

  it('protected billiard/restored tenders keep the blocking server verification', () => {
    const protectedUses = POS_MODULE.split('await this.refreshServerShiftConsistencyForPayment(').length - 1;
    expect(protectedUses).toBeGreaterThanOrEqual(3);
  });
});
