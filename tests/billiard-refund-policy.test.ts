import { describe, expect, it } from 'vitest';
import { sanitizeBilliardRefundRequest } from '../src/main/pos/billiard-refund-policy';
import type { OrderItemRow } from '../src/main/database/repos/order-repo';

function item(overrides: Partial<OrderItemRow> & { lineKey?: string; kind?: 'TIME' | 'FNB' } = {}): OrderItemRow {
  const lineKey = overrides.lineKey ?? 'fnb-1';
  const kind = overrides.kind ?? 'FNB';
  const refundPolicy = kind === 'TIME' ? 'FORBIDDEN' : 'ALLOWED_NO_RESTOCK';
  const inventoryPolicy = kind === 'TIME' ? 'NONE' : 'ALREADY_CONSUMED';
  const payable = overrides.payable_total ?? 3000;
  const quantity = overrides.quantity ?? 4;
  return {
    id: overrides.id ?? `item-${lineKey}`,
    order_id: overrides.order_id ?? 'order-1',
    variant_id: overrides.variant_id ?? `variant-${lineKey}`,
    name: overrides.name ?? lineKey,
    sku: overrides.sku ?? lineKey,
    price: overrides.price ?? 1000,
    quantity,
    sale_quantity: overrides.sale_quantity ?? quantity,
    sale_unit: overrides.sale_unit ?? 'szt',
    sell_by: overrides.sell_by ?? 'PIECE',
    total: overrides.total ?? quantity * 1000,
    vat_rate: overrides.vat_rate ?? 23,
    staff_id: null,
    staff_name: null,
    notes: null,
    course: null,
    billiard_json: JSON.stringify({
      lineKey,
      kind,
      refundPolicy,
      inventoryPolicy,
      sellBy: overrides.sell_by ?? 'PIECE',
      payableGrosze: payable,
    }),
    refund_policy: refundPolicy,
    inventory_policy: inventoryPolicy,
    payable_total: payable,
    allocated_discount: (overrides.total ?? quantity * 1000) - payable,
    ...overrides,
  };
}

describe('Billiard refund main-process policy', () => {
  it('rejects amount-only PARTIAL refunds', () => {
    expect(() => sanitizeBilliardRefundRequest({
      data: { type: 'PARTIAL', amount: 500, lines: [] },
      orderItems: [item()],
    })).toThrow(/at least one explicitly selected/i);
  });

  it('rejects duplicate stable line keys', () => {
    const line = {
      billiardLineKey: 'fnb-1',
      quantity: 1,
      unitPrice: 750,
      refundAmount: 750,
      restock: false,
    };
    expect(() => sanitizeBilliardRefundRequest({
      data: { type: 'PARTIAL', amount: 1500, lines: [line, { ...line }] },
      orderItems: [item()],
    })).toThrow(/selected more than once/i);
  });

  it('derives the refund from the frozen payable allocation and rejects renderer money', () => {
    const data = {
      type: 'PARTIAL' as const,
      amount: 750,
      lines: [{
        billiardLineKey: 'fnb-1',
        quantity: 1,
        unitPrice: 999999,
        refundAmount: 750,
        restock: true,
      }],
    };
    const sanitized = sanitizeBilliardRefundRequest({ data, orderItems: [item()] });
    expect(sanitized.amountGrosze).toBe(750);
    expect(sanitized.lines[0]).toMatchObject({
      billiardLineKey: 'fnb-1',
      quantity: 1,
      refundAmount: 750,
      unitPrice: 750,
      restock: false,
    });

    expect(() => sanitizeBilliardRefundRequest({
      data: { ...data, amount: 9999 },
      orderItems: [item()],
    })).toThrow(/total does not match/i);
    expect(() => sanitizeBilliardRefundRequest({
      data: { ...data, lines: [{ ...data.lines[0], refundAmount: 9999 }] },
      orderItems: [item()],
    })).toThrow(/stale or invalid/i);
  });

  it('uses only the remaining quantity and amount after an earlier refund', () => {
    const result = sanitizeBilliardRefundRequest({
      data: {
        type: 'PARTIAL',
        amount: 750,
        lines: [{
          billiardLineKey: 'fnb-1',
          quantity: 1,
          unitPrice: 750,
          refundAmount: 750,
          restock: false,
        }],
      },
      orderItems: [item()],
      alreadyRefundedGrosze: 750,
      refundLinesJson: JSON.stringify([{
        billiardLineKey: 'fnb-1',
        quantity: 1,
        refundAmount: 750,
      }]),
    });
    expect(result.amountGrosze).toBe(750);
    expect(result.lines[0].unitPrice).toBe(750);
  });

  it('rejects non-refundable playing-time lines', () => {
    expect(() => sanitizeBilliardRefundRequest({
      data: {
        type: 'PARTIAL',
        amount: 3000,
        lines: [{
          billiardLineKey: 'time-1',
          quantity: 1,
          unitPrice: 3000,
          refundAmount: 3000,
          restock: false,
        }],
      },
      orderItems: [item({ lineKey: 'time-1', kind: 'TIME', quantity: 1, payable_total: 3000 })],
    })).toThrow(/non-refundable/i);
  });
});
