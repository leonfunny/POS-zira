import { describe, expect, it } from 'vitest';
import { buildRetailMirrorPayload } from '../src/shared/billiard-retail-mirror';

const UUID = '3f47138b-b1f5-4556-83de-434901b89da0';
const UUID2 = 'e6c1fe5a-a727-4735-b35c-912df2c46825';

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID,
    status: 'completed',
    payment_method: 'CASH',
    customer_name: 'Anh Minh',
    client_attempt_id: UUID2,
    billiard_origin_json: null,
    ...overrides,
  } as any;
}

const items = [
  { name: 'Cola', quantity: 2, price: 1000, billiard_json: null },
  { name: 'Chips', quantity: 1, price: 750, billiard_json: null },
];

describe('buildRetailMirrorPayload', () => {
  it('maps a plain counter order into the quick-sale shape (grosze → złoty)', () => {
    const payload = buildRetailMirrorPayload(order(), items);
    expect(payload).toEqual({
      items: [
        { name: 'Cola', quantity: 2, unitPrice: 10 },
        { name: 'Chips', quantity: 1, unitPrice: 7.5 },
      ],
      paymentMethod: 'CASH',
      paymentAttemptId: UUID2,
      customerName: 'Anh Minh',
      sourceRef: UUID,
    });
  });

  it('never mirrors billiard-handoff orders or their lines', () => {
    expect(buildRetailMirrorPayload(order({ billiard_origin_json: '{"sessionId":"s1"}' }), items)).toBeNull();
    const mixed = buildRetailMirrorPayload(order(), [
      { name: 'Table time', quantity: 1, price: 4500, billiard_json: '{"kind":"TIME"}' },
      ...items,
    ]);
    expect(mixed?.items.map((i) => i.name)).toEqual(['Cola', 'Chips']);
  });

  it('maps transfer-family methods and refuses unknown ones', () => {
    expect(buildRetailMirrorPayload(order({ payment_method: 'INVOICE' }), items)?.paymentMethod).toBe('TRANSFER');
    expect(buildRetailMirrorPayload(order({ payment_method: 'BANK_TRANSFER' }), items)?.paymentMethod).toBe('TRANSFER');
    expect(buildRetailMirrorPayload(order({ payment_method: 'blik' }), items)?.paymentMethod).toBe('BLIK');
    expect(buildRetailMirrorPayload(order({ payment_method: 'VOUCHER' }), items)).toBeNull();
    expect(buildRetailMirrorPayload(order({ payment_method: null }), items)).toBeNull();
  });

  it('falls back from client_attempt_id to the order id, requires a uuid', () => {
    expect(buildRetailMirrorPayload(order({ client_attempt_id: null }), items)?.paymentAttemptId).toBe(UUID);
    expect(buildRetailMirrorPayload(order({ client_attempt_id: 'not-a-uuid' }), items)?.paymentAttemptId).toBe(UUID);
    expect(buildRetailMirrorPayload(order({ id: 'local-123', client_attempt_id: null }), items)).toBeNull();
  });

  it('drops empty/junk lines and refuses an empty cart', () => {
    const payload = buildRetailMirrorPayload(order(), [
      { name: '', quantity: 1, price: 100, billiard_json: null },
      { name: 'Zero qty', quantity: 0, price: 100, billiard_json: null },
    ]);
    expect(payload).toBeNull();
  });
});
