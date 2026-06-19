import { describe, expect, it } from 'vitest';

describe('parseKitchenOrderSequence', () => {
  it('accepts K-001..K-999', async () => {
    const { parseKitchenOrderSequence } = await import(
      '../src/renderer/windows/kitchen-self-order/order-number-tts'
    );
    expect(parseKitchenOrderSequence('K-001')).toBe(1);
    expect(parseKitchenOrderSequence('K-042')).toBe(42);
    expect(parseKitchenOrderSequence('K-999')).toBe(999);
  });

  it('rejects placeholder, malformed, and out-of-range', async () => {
    const { parseKitchenOrderSequence } = await import(
      '../src/renderer/windows/kitchen-self-order/order-number-tts'
    );
    for (const bad of ['K----', 'K-1000', 'K-0', '', 'X-1', '001', null, undefined]) {
      expect(parseKitchenOrderSequence(bad as any)).toBeNull();
    }
  });
});

describe('buildOrderNumberSequence', () => {
  it('frames the number clips with thanks/label/keep', async () => {
    const { buildOrderNumberSequence } = await import(
      '../src/renderer/windows/kitchen-self-order/order-number-tts'
    );
    expect(buildOrderNumberSequence(42)).toEqual([
      'kso_dziekujemy.mp3', 'kso_numer_zamowienia.mp3', '42.mp3', 'kso_zachowaj_numer.mp3',
    ]);
  });
});

describe('shouldAnnounceOrderNumber', () => {
  it('returns the number only on done + flag on + valid number', async () => {
    const { shouldAnnounceOrderNumber } = await import(
      '../src/renderer/windows/kitchen-self-order/order-number-tts'
    );
    expect(shouldAnnounceOrderNumber('done', true, 'K-007')).toBe(7);
    expect(shouldAnnounceOrderNumber('review', true, 'K-007')).toBeNull();
    expect(shouldAnnounceOrderNumber('done', false, 'K-007')).toBeNull();
    expect(shouldAnnounceOrderNumber('done', true, 'K----')).toBeNull();
  });
});
