import { describe, expect, test } from 'vitest';

import { withoutHoldRecallPendingMarker } from '../src/main/pos/billiard-pos-handoff';

describe('Hold recall snapshots', () => {
  test('removes a persisted in-flight marker without mutating the stored snapshot', () => {
    const snapshot = {
      schemaVersion: 1,
      posMode: 'retail',
      scope: { salonId: 'salon-1', userId: 'user-1', registerId: 'register-1' },
      state: {
        cart: { items: [{ id: 'line-1' }] },
        checkoutDraft: {
          customerName: 'Customer',
          holdRecallPending: { holdId: 'hold-1' },
        },
      },
    } as any;

    const sanitized = withoutHoldRecallPendingMarker(snapshot);

    expect(sanitized.state.checkoutDraft?.holdRecallPending).toBeUndefined();
    expect(sanitized.state.checkoutDraft?.customerName).toBe('Customer');
    expect(snapshot.state.checkoutDraft.holdRecallPending).toEqual({ holdId: 'hold-1' });
  });
});
