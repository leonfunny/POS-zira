import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { translations } from '../src/renderer/i18n/translations';

const source = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/OrderHistoryModal.tsx'),
  'utf8',
);

describe('Order History refund UI contract', () => {
  it('uses a dedicated nested refund modal instead of a narrow inline form', () => {
    expect(source).toContain('zLayer="nested"');
    expect(source).toContain('panelClassName="sm:max-w-[820px]"');
    expect(source).toContain("tOr(t, 'pos.refund.selectItemsTitle', 'Items to refund')");
    expect(source).toContain('whitespace-normal break-words');
  });

  it('separates original, refunded, and remaining amounts without striking partial refunds', () => {
    expect(source).toContain("tOr(t, 'pos.history.originalTotal', 'Original total')");
    expect(source).toContain("tOr(t, 'pos.history.refundedTotal', 'Refunded')");
    expect(source).toContain("tOr(t, 'pos.history.remainingTotal', 'Remaining')");
    expect(source).toContain('pageOriginalTotal');
    expect(source).toContain('pageRefundedTotal');
    expect(source).toContain('orders.reduce((sum, order) => sum + getSafeRemainingTotal(order), 0)');
    expect(source).not.toContain("'text-slate-500 line-through'");
  });

  it('keeps refund copy locale-aware and quantity unit-aware', () => {
    expect(source).not.toContain('translations.pl');
    expect(source).not.toContain('remainingUnits');
    expect(source).not.toContain('refundedUnits');
    expect(source).toContain('formatRefundLineQuantity(line, t)');
    expect(source).toContain("displaySaleUnit(item.sale_unit, sellBy, t)");
    expect(source).toContain('paymentLabel(order.payment_method, t)');
    expect(source).not.toContain('pos.history.latestReason');
  });

  it('preserves an in-progress decimal draft so a cashier can type 0.75 kg', () => {
    expect(source).toContain('const [weightQtyDrafts, setWeightQtyDrafts]');
    expect(source).toContain("const normalized = draft.replace(',', '.')");
    expect(source).toContain('value={weightQtyDrafts[item.id] ??');
    expect(source).toContain('onBlur={() => commitWeightItemQtyDraft(item.id)}');
  });

  it('provides the complete Vietnamese refund vocabulary used by GM', () => {
    expect(translations.vi['pos.history.originalTotal']).toBe('Tổng đơn gốc');
    expect(translations.vi['pos.history.refundedTotal']).toBe('Đã hoàn');
    expect(translations.vi['pos.history.remainingTotal']).toBe('Còn lại');
    expect(translations.vi['pos.history.refundHistory']).toBe('Lịch sử hoàn tiền');
    expect(translations.vi['pos.refund.selectItemsTitle']).toBe('Sản phẩm cần hoàn');
    expect(translations.vi['pos.refund.refundNext']).toBe('Hoàn tiếp');
    expect(translations.vi['pos.refund.restock']).toBe('Nhập lại sản phẩm vào kho');
    expect(translations.vi['pos.refund.mixedRestock']).toBe('Chỉ nhập lại kho một phần');
    expect(translations.vi['pos.refund.printReceipt']).toBe('In phiếu hoàn tiền');
    expect(translations.vi['pos.payment.cash']).toBe('Tiền mặt');
    expect(translations.vi['pos.payment.credit']).toBe('Ghi nợ');
    expect(translations.vi['pos.history.unknown']).toBe('Không xác định');
  });
});
