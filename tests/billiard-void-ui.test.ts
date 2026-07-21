import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  billiardVoidBatchPayload,
  billiardVoidPayload,
  getBilliardMutationPolicy,
  isAllowedBilliardMutation,
  isAllowedBilliardOperation,
} from '../src/shared/billiard-contract';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

const uuid = '23ef50dd-eb5b-4ca9-8099-d43e994e659d';

describe('billiard void — contract allowlist', () => {
  it('allows the two deployed void routes, online-only, bound to their operations', () => {
    expect(isAllowedBilliardMutation('POST', `/billiard/sessions/${uuid}/void`)).toBe(true);
    expect(getBilliardMutationPolicy('POST', `/billiard/sessions/${uuid}/void`)).toBe('online-only');
    expect(isAllowedBilliardOperation('void_session', 'POST', `/billiard/sessions/${uuid}/void`)).toBe(true);

    expect(isAllowedBilliardMutation('POST', '/billiard/sessions/void-batch')).toBe(true);
    expect(getBilliardMutationPolicy('POST', '/billiard/sessions/void-batch')).toBe('online-only');
    expect(isAllowedBilliardOperation('void_sessions_batch', 'POST', '/billiard/sessions/void-batch')).toBe(true);
  });

  it('refuses near-miss methods and paths', () => {
    expect(isAllowedBilliardMutation('PATCH', `/billiard/sessions/${uuid}/void`)).toBe(false);
    expect(isAllowedBilliardMutation('POST', `/billiard/sessions/${uuid}/void/extra`)).toBe(false);
    expect(isAllowedBilliardMutation('DELETE', '/billiard/sessions/void-batch')).toBe(false);
  });

  it('payload builders trim the reason and copy the id list', () => {
    expect(billiardVoidPayload('  walked out  ')).toEqual({ reason: 'walked out' });
    const ids = [uuid];
    const payload = billiardVoidBatchPayload(ids, ' legacy data ');
    expect(payload).toEqual({ ids: [uuid], reason: 'legacy data' });
    expect(payload.ids).not.toBe(ids);
  });
});

describe('billiard void — sync and UI wiring', () => {
  it('sync handles void success authoritatively (upsert single, re-pull batch, notify)', () => {
    const sync = readSource('../src/main/sync/billiard-sync.ts');
    expect(sync).toContain("op === 'void_session'");
    expect(sync).toContain("op === 'void_sessions_batch'");
    expect(sync).toContain("flushPaymentJournal('session void')");
    expect(sync).toContain("syncPendingPayments(token, 'void batch')");
  });

  it('renderer hooks call the queue-aware mutate with the bound operations', () => {
    const hooks = readSource('../src/renderer/hooks/useBilliardData.ts');
    expect(hooks).toContain("'void_session', 'POST'");
    expect(hooks).toContain("'void_sessions_batch', 'POST', '/billiard/sessions/void-batch'");
  });

  it('the unsettled panel offers per-row void, bulk void, and requires a reason', () => {
    const panel = readSource('../src/renderer/components/billiard/UnsettledPanel.tsx');
    expect(panel).toContain('onVoid');
    expect(panel).toContain("t('billiard.voidSelected')");
    expect(panel).toContain('reason.trim()');

    const floor = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    expect(floor).toContain('useVoidSession');
    expect(floor).toContain('useVoidSessions');
  });
});
