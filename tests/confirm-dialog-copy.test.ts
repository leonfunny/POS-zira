import { describe, expect, it } from 'vitest';
import { buildConfirmCopy, type ConfirmActionKind } from '../src/renderer/components/pos/confirm-action-copy';

describe('confirm action copy', () => {
  it.each([
    ['void', 'review'],
    ['cancel', 'review'],
    ['deleteLocal', 'review'],
    ['deleteHeld', 'light'],
  ] as Array<[ConfirmActionKind, 'light' | 'review']>)('builds %s copy with the correct tier', (action, tier) => {
    const copy = buildConfirmCopy(action, { label: 'Order #42', total: '12.34 zl', isSynced: true });

    expect(copy.tier).toBe(tier);
    expect(copy.titleKey).not.toHaveLength(0);
    expect(copy.titleFallback).not.toHaveLength(0);
    expect(copy.bodyFallback).not.toHaveLength(0);
    expect(copy.consequenceFallback).not.toHaveLength(0);
    expect(copy.confirmLabelFallback).not.toHaveLength(0);
  });

  it('states that deleting a local order restores stock', () => {
    const copy = buildConfirmCopy('deleteLocal', { label: 'Local #8' });

    expect(copy.consequenceFallback.toLowerCase()).toContain('stock will be restored');
  });

  it('states that cancelling is irreversible', () => {
    const copy = buildConfirmCopy('cancel', { label: 'Order #9' });

    expect(copy.consequenceFallback.toLowerCase()).toContain('cannot be undone');
  });
});
