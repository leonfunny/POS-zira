import { describe, it, expect } from 'vitest';
import {
  buildKitchenSelfOrderRefQr,
  decodeKitchenSelfOrderRefQr,
  decodeKitchenSelfOrderQr,
  KITCHEN_SELF_ORDER_REF_QR_PREFIX,
} from '../src/shared/kitchen-self-order';

describe('kitchen self-order reference QR', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('round-trips a UUID sourceOrderId + orderNumber', () => {
    const qr = buildKitchenSelfOrderRefQr(uuid, 'K-042');
    expect(qr.startsWith(KITCHEN_SELF_ORDER_REF_QR_PREFIX)).toBe(true);
    expect(decodeKitchenSelfOrderRefQr(qr)).toEqual({ sourceOrderId: uuid, orderNumber: 'K-042' });
  });

  it('keeps the QR short for a UUID (well under 40 chars)', () => {
    expect(buildKitchenSelfOrderRefQr(uuid, '0042').length).toBeLessThan(40);
  });

  it('falls back to the raw id when sourceOrderId is not a UUID', () => {
    const qr = buildKitchenSelfOrderRefQr('kso-local-7', 'K-7');
    expect(decodeKitchenSelfOrderRefQr(qr)).toEqual({ sourceOrderId: 'kso-local-7', orderNumber: 'K-7' });
  });

  it('returns null for non-reference codes', () => {
    expect(decodeKitchenSelfOrderRefQr('KSO1:whatever')).toBeNull();
    expect(decodeKitchenSelfOrderRefQr('1234567890')).toBeNull();
    expect(decodeKitchenSelfOrderRefQr('')).toBeNull();
  });

  it('returns null for malformed URL-encoded reference parts', () => {
    expect(() => decodeKitchenSelfOrderRefQr('KSOREF:%.K-1')).not.toThrow();
    expect(decodeKitchenSelfOrderRefQr('KSOREF:%.K-1')).toBeNull();
  });

  it('is not mistaken for a legacy KSO1 payload by the old decoder', () => {
    expect(decodeKitchenSelfOrderQr(buildKitchenSelfOrderRefQr(uuid, 'K-1'))).toBeNull();
  });
});
