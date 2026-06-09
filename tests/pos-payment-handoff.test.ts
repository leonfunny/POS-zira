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

  it('scrolls the cart item list to the newest line after item changes', () => {
    expect(CART).toContain('const cartAutoScrollSignature = cart.items');
    expect(CART).toContain('itemsScrollRef.current');
    expect(CART).toContain('requestAnimationFrame(() => {');
    expect(CART).toContain("el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })");
    expect(CART).toContain('[cart.items.length, cartAutoScrollSignature]');
  });

  it('stores the draft in the retail surface and passes it into PaymentModal', () => {
    expect(RETAIL_TEMPLATE).toContain('paymentPrefillCashGrosze');
    expect(RETAIL_TEMPLATE).toContain('initialCashAmountGrosze={paymentPrefillCashGrosze}');
  });

  it('hydrates PaymentModal cash state from the initial cash draft', () => {
    expect(PAYMENT_MODAL).toContain('initialCashAmountGrosze');
    expect(PAYMENT_MODAL).toContain('formatInitialCashAmount(initialCashAmountGrosze)');
  });

  it('snapshots payment totals before clearing the cart for receipt prompts', () => {
    const snapshotIndex = PAYMENT_MODAL.indexOf('setPaymentSnapshot({');
    const clearIndex = PAYMENT_MODAL.indexOf("dispatch({ type: 'cart/clear' })");

    expect(PAYMENT_MODAL).toContain('type PaymentSnapshot');
    expect(PAYMENT_MODAL).toContain('const displayGrandTotal = paymentSnapshot?.grandTotal ?? liveGrandTotal;');
    expect(PAYMENT_MODAL).toContain('const displayCashAmountGrosze = paymentSnapshot?.cashAmountGrosze ?? cashAmountGrosze;');
    expect(PAYMENT_MODAL).toContain('money(displayCashAmountGrosze)');
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(snapshotIndex);
  });

  it('wires retail scanner payment commands through SearchBar and PaymentModal', () => {
    expect(RETAIL_TEMPLATE).toContain("const PAY_CARD_SCAN_COMMAND = '11111111';");
    expect(RETAIL_TEMPLATE).toContain("const PAY_CASH_SCAN_COMMAND = '22222222';");
    expect(RETAIL_TEMPLATE).toContain('commandBarcodes={RETAIL_SCAN_COMMANDS}');
    expect(RETAIL_TEMPLATE).toContain("handleOpenPaymentScanCommand('CARD')");
    expect(RETAIL_TEMPLATE).toContain("handleOpenPaymentScanCommand('CASH')");
    expect(RETAIL_TEMPLATE).toContain('initialMethod={paymentInitialMethod}');
    expect(RETAIL_TEMPLATE).toContain('card: PAY_CARD_SCAN_COMMAND');
    expect(RETAIL_TEMPLATE).toContain('cash: PAY_CASH_SCAN_COMMAND');
    expect(PAYMENT_MODAL).toContain('initialMethod?: PaymentMethod');
    expect(PAYMENT_MODAL).toContain('scanCommands?: {');
    expect(PAYMENT_MODAL).toContain("document.body.dataset.posPaymentOpen = 'true';");
    expect(PAYMENT_MODAL).toContain("if (method === 'CARD')");
    expect(PAYMENT_MODAL).toContain('if (canComplete) void handleComplete();');
    expect(PAYMENT_MODAL).toContain("setCashAmount(totalZl.toFixed(2));");
    expect(PAYMENT_MODAL).toContain("const shouldCompleteCash = method === 'CASH';");
    expect(PAYMENT_MODAL).toContain('if (shouldCompleteCash) void completePayment(grandTotal);');
    expect(PAYMENT_MODAL).toContain('candidate.startsWith(commandCandidate)');
    expect(PAYMENT_MODAL).toContain('if (commandCandidate.length > 1)');
    expect(PAYMENT_MODAL).toContain('removeScannedCommandFromActiveInput(commandCandidate.slice(0, -1));');
  });

  it('exposes the BLIK quick branch from the cash bills row without opening the drawer', () => {
    expect(PAYMENT_MODAL).toContain("const BLIK_RECEIPT_PHONE = '729448788'");
    expect(PAYMENT_MODAL).toContain("setMethod('BLIK')");
    expect(PAYMENT_MODAL).toContain("const printOrderCopyWithDrawer = hasCash");
    expect(PAYMENT_MODAL).toContain("window.electronAPI.pos.payment.printReceipt(orderId)");
  });

  it('lets the main process repair stale renderer staff state from the local active shift', () => {
    expect(RETAIL_TEMPLATE).toContain('const shiftPaymentOpen = session.isOpen');
    expect(RETAIL_TEMPLATE).toContain('shiftOpen={shiftPaymentOpen}');
    expect(CART).toContain('shiftBlockReason');
    expect(PAYMENT_MODAL).not.toContain('if (!shiftId || !staffId || !staffName?.trim())');
    expect(POS_MODULE).toContain('const activeShift = database.get');
    expect(POS_MODULE).toContain('Cannot create POS order without an active shift staff');
  });

  it('keeps non-retail payment surfaces behind the same local shift gate', () => {
    expect(SALON_TEMPLATE).toContain('shiftPaymentOpen');
    expect(SALON_TEMPLATE).toContain('const shiftPaymentOpen = session.isOpen');
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
