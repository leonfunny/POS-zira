import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const PAYMENT_MODAL = fs.readFileSync(
  path.join(ROOT, 'src/renderer/components/pos/PaymentModal.tsx'),
  'utf8',
);

const sliceBetween = (start: string, end: string) => {
  const startIndex = PAYMENT_MODAL.indexOf(start);
  const endIndex = PAYMENT_MODAL.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThan(-1);
  expect(endIndex).toBeGreaterThan(startIndex);
  return PAYMENT_MODAL.slice(startIndex, endIndex);
};

describe('PaymentModal order creation idempotency', () => {
  const saveOrderAndFinish = sliceBetween(
    'const saveOrderAndFinish = async',
    'const handleFiscalPromptChoice = async',
  );
  const completePayment = sliceBetween(
    'const completePayment = useCallback',
    'const handleComplete = useCallback',
  );
  const retryReceipt = sliceBetween(
    'const handleRetryReceipt = async',
    'const handleContinueWithoutReceipt = () =>',
  );
  const runPaymentScanCommand = sliceBetween(
    'const runPaymentScanCommand = useCallback',
    'useEffect(() => {',
  );

  it('reuses one stable order id for every completePayment invocation in a modal instance', () => {
    expect(PAYMENT_MODAL).toContain('checkoutDraft?.billiard?.orderId');
    expect(PAYMENT_MODAL).toContain('checkoutDraft?.restoredInterruption?.orderId');
    expect(PAYMENT_MODAL).toContain('checkoutDraft?.restoredInterruption?.clientAttemptId');
    expect(completePayment).toContain('const orderId = orderAttemptIdRef.current;');
    expect(completePayment).not.toMatch(/crypto\.randomUUID\s*\(/);
  });

  it('persists a protected tender in a separate UI step before order creation', () => {
    const boundaryIndex = completePayment.indexOf('billiardCheckout.beginTender(');
    const restoredBoundaryIndex = completePayment.indexOf('billiardCheckout.beginRestoredTender(');
    const preparedIndex = completePayment.indexOf('setTenderPrepared(true)');
    const boundaryReturnIndex = completePayment.indexOf('return;', preparedIndex);
    const createIndex = saveOrderAndFinish.indexOf('pos.orders.create(order, items)');
    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(restoredBoundaryIndex).toBeGreaterThan(boundaryIndex);
    expect(preparedIndex).toBeGreaterThan(restoredBoundaryIndex);
    expect(boundaryReturnIndex).toBeGreaterThan(preparedIndex);
    expect(createIndex).toBeGreaterThan(-1);
    expect(saveOrderAndFinish).not.toContain('beginTender(');
    expect(saveOrderAndFinish).not.toContain('beginRestoredTender(');
    expect(saveOrderAndFinish).not.toContain('rollbackTender');
    expect(completePayment).not.toContain('rollbackTender');
    expect(PAYMENT_MODAL).toContain('Do not collect cash or confirm the card terminal yet.');
  });

  it('marks the order completed immediately after local order creation succeeds', () => {
    const createIndex = saveOrderAndFinish.indexOf('window.electronAPI.pos.orders.create(order, items)');
    const failureIndex = saveOrderAndFinish.indexOf('if (result && !result.success)');
    const completedIndex = saveOrderAndFinish.indexOf('completedOrderIdRef.current = orderId;');
    const syncIndex = saveOrderAndFinish.indexOf('window.electronAPI.pos.sync.orders()');
    const printIndex = saveOrderAndFinish.indexOf('window.electronAPI.pos.payment.printReceipt');

    expect(createIndex).toBeGreaterThan(-1);
    expect(failureIndex).toBeGreaterThan(createIndex);
    expect(completedIndex).toBeGreaterThan(failureIndex);
    expect(syncIndex).toBeGreaterThan(completedIndex);
    expect(printIndex).toBeGreaterThan(completedIndex);
  });

  it('blocks completePayment while saving, saved, in recovery, or in fiscal prompt', () => {
    const guard = completePayment.slice(
      completePayment.indexOf('if ('),
      completePayment.indexOf('paymentCompleteInFlightRef.current = true;'),
    );

    expect(guard).toContain('saving');
    expect(guard).toContain('paymentCompleteInFlightRef.current');
    expect(guard).toContain('completedOrderIdRef.current');
    expect(guard).toContain('receiptRecovery');
    expect(guard).toContain('fiscalPrompt');
  });

  it('consumes scanner payment commands without mutating payment state after save or recovery starts', () => {
    const blockedIndex = runPaymentScanCommand.indexOf('const submitBlocked =');
    const cardBlockedReturn = runPaymentScanCommand.indexOf('if (submitBlocked) return true;');
    const firstMutation = runPaymentScanCommand.indexOf('setSplitMode(false)');
    const cashComplete = runPaymentScanCommand.indexOf('void completePayment(grandTotal)');

    expect(blockedIndex).toBeGreaterThan(-1);
    expect(runPaymentScanCommand).toContain('saving');
    expect(runPaymentScanCommand).toContain('paymentCompleteInFlightRef.current');
    expect(runPaymentScanCommand).toContain('completedOrderIdRef.current');
    expect(runPaymentScanCommand).toContain('receiptRecovery');
    expect(runPaymentScanCommand).toContain('receiptRetrying');
    expect(runPaymentScanCommand).toContain('fiscalPrompt');
    expect(cardBlockedReturn).toBeGreaterThan(blockedIndex);
    expect(firstMutation).toBeGreaterThan(cardBlockedReturn);
    expect(cashComplete).toBeGreaterThan(cardBlockedReturn);
  });

  it('retries only the existing recovery order receipt, never order creation', () => {
    expect(retryReceipt).toContain('window.electronAPI.pos.payment.printReceipt(recovery.orderId)');
    expect(retryReceipt).not.toContain('pos.orders.create');
    expect(retryReceipt).not.toContain('completePayment');
  });
});
