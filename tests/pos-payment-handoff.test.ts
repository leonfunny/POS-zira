import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatInitialCashAmount } from '../src/renderer/components/pos/format-cash-amount';

const ROOT = path.resolve(__dirname, '..');
const CART = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/Cart.tsx'), 'utf8');
const NUMPAD_CONTROLLER = fs.readFileSync(path.join(ROOT, 'src/renderer/hooks/usePOSNumpadController.ts'), 'utf8');
const RETAIL_TEMPLATE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/templates/retail/RetailTemplate.tsx'), 'utf8');
const SALON_TEMPLATE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/templates/salon/SalonTemplate.tsx'), 'utf8');
const B2B_TEMPLATE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/templates/b2b/B2BTemplate.tsx'), 'utf8');
const RESTAURANT_TEMPLATE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx'), 'utf8');
const PAYMENT_MODAL = fs.readFileSync(path.join(ROOT, 'src/renderer/components/pos/PaymentModal.tsx'), 'utf8');
const POS_MODULE = fs.readFileSync(path.join(ROOT, 'src/main/modules/pos.module.ts'), 'utf8');
const SHIFT_CONTROLLER = fs.readFileSync(path.join(ROOT, 'src/main/pos/shift-controller.ts'), 'utf8');

describe('POS cash handoff helpers', () => {
  it('formats embedded-numpad cash into the modal input shape', () => {
    expect(formatInitialCashAmount()).toBe('');
    expect(formatInitialCashAmount(0)).toBe('');
    expect(formatInitialCashAmount(5000)).toBe('50.00');
    expect(formatInitialCashAmount(1234)).toBe('12.34');
  });
});

describe('POS embedded numpad → PaymentModal wiring', () => {
  it('routes explicit numpad payment confirmation through Cart.onPay', () => {
    expect(CART).toContain('onPaymentConfirm: requestPayment');
    expect(CART).toContain('requestPayment(prefillCashGrosze)');
  });

  it('keeps payment confirmation explicit instead of firing while switching numpad targets', () => {
    expect(NUMPAD_CONTROLLER).toContain('confirmPayment = false');
    expect(NUMPAD_CONTROLLER).toContain("currentTarget.kind === 'payment' && confirmPayment");
    expect(NUMPAD_CONTROLLER).toContain('commit(target, buffer, isPercent, true)');
  });

  it('preserves a typed cash amount when the cashier taps the orange Pay button', () => {
    expect(CART).toContain("controller.target.kind === 'payment'");
    expect(CART).toContain('parseBufferGrosze(controller.buffer)');
  });

  it('stores the draft in the retail surface and passes it into PaymentModal', () => {
    expect(RETAIL_TEMPLATE).toContain('paymentPrefillCashGrosze');
    expect(RETAIL_TEMPLATE).toContain('initialCashAmountGrosze={paymentPrefillCashGrosze}');
  });

  it('hydrates PaymentModal cash state from the initial cash draft', () => {
    expect(PAYMENT_MODAL).toContain('initialCashAmountGrosze');
    expect(PAYMENT_MODAL).toContain('formatInitialCashAmount(initialCashAmountGrosze)');
  });

  it('blocks payments when a restored shift has no staff name', () => {
    expect(RETAIL_TEMPLATE).toContain('missingShiftStaff');
    expect(RETAIL_TEMPLATE).toContain('shiftOpen={shiftPaymentOpen}');
    expect(CART).toContain('shiftBlockReason');
    expect(PAYMENT_MODAL).toContain('if (!shiftId || !staffId || !staffName?.trim())');
    expect(POS_MODULE).toContain('Cannot create POS order without an active shift staff');
  });

  it('keeps non-retail payment surfaces behind the same shift staff gate', () => {
    expect(SALON_TEMPLATE).toContain('shiftPaymentOpen');
    expect(SALON_TEMPLATE).toContain('!session.staffId || !session.staffName?.trim()');
    expect(B2B_TEMPLATE).toContain('shiftOpen={shiftPaymentOpen}');
    expect(RESTAURANT_TEMPLATE).toContain('shiftOpen={shiftPaymentOpen}');
  });

  it('requires POS orders to belong to a local open shift', () => {
    expect(POS_MODULE).toContain('Cannot create POS order without a local active shift');
    expect(POS_MODULE).toContain('WHERE id = ? AND closed_at IS NULL');
    expect(POS_MODULE).toContain('Materialized server shift');
  });

  it('lets a cashier close a server ghost shift before reopening cleanly', () => {
    expect(POS_MODULE).toContain('Closed server ghost shift');
    expect(SHIFT_CONTROLLER).toContain('getActiveShift(token)');
    expect(SHIFT_CONTROLLER).toContain('closing unsynced local shift');
    expect(SHIFT_CONTROLLER).toContain('Skipped closing server active shift');
  });
});
