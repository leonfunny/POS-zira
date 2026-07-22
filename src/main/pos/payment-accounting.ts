interface PaymentAccountingOrder {
  total?: unknown;
  tip?: unknown;
  payment_method?: unknown;
  payment_amount?: unknown;
  change_amount?: unknown;
  payment_tenders?: unknown;
}

function safeMoney(value: unknown, field: string): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`POS ${field} must be a non-negative integer grosz amount.`);
  }
  return amount;
}

export function parsePosPaymentTenders(value: unknown): Array<{ method: string; amount: number }> {
  if (value == null || value === '') return [];
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch { throw new Error('POS payment tenders are malformed.'); }
  }
  if (!Array.isArray(raw)) throw new Error('POS payment tenders are malformed.');
  return raw.map((tender, index) => {
    const row = tender as Record<string, unknown>;
    const method = String(row?.method || '').trim().toUpperCase();
    const amount = safeMoney(row?.amount ?? row?.amountMinor, `tender ${index + 1}`);
    if (!method || amount <= 0) throw new Error(`POS tender ${index + 1} is invalid.`);
    return { method, amount };
  });
}

/** Ensures payment input represents exactly one payable total before commit. */
export function assertPosPaymentAccounting(order: PaymentAccountingOrder): void {
  const payable = safeMoney(order.total, 'order total') + safeMoney(order.tip, 'tip');
  const paymentAmount = safeMoney(order.payment_amount, 'payment amount');
  const changeAmount = safeMoney(order.change_amount, 'change amount');
  const tenders = parsePosPaymentTenders(order.payment_tenders);

  if (tenders.length > 0) {
    const tenderTotal = tenders.reduce((sum, tender) => sum + tender.amount, 0);
    if (!Number.isSafeInteger(tenderTotal) || tenderTotal !== payable) {
      throw new Error(`POS split tenders must equal the exact payable total (${payable} grosze).`);
    }
    if (paymentAmount !== tenderTotal || changeAmount !== 0) {
      throw new Error('POS split payment accounting does not match its exact tender allocation.');
    }
    return;
  }

  const method = String(order.payment_method || '').trim().toUpperCase();
  if (!method) throw new Error('POS payment method is required.');
  if (method === 'CASH') {
    if (paymentAmount < payable || changeAmount !== paymentAmount - payable) {
      throw new Error('POS cash received/change does not match the payable total.');
    }
    return;
  }
  if (paymentAmount !== payable || changeAmount !== 0) {
    throw new Error('POS non-cash payment must equal the exact payable total.');
  }
}

const PROTECTED_PAYMENT_METHODS = new Set([
  'CASH',
  'CARD',
  'BLIK',
  'TRANSFER',
  'BANK_TRANSFER',
  'INVOICE',
]);

/** Keep local protected commits inside the backend Billiard payment enum. */
export function assertProtectedPosPaymentMethods(order: PaymentAccountingOrder): void {
  const primary = String(order.payment_method || '').trim().toUpperCase();
  if (!PROTECTED_PAYMENT_METHODS.has(primary)) {
    throw new Error(`Protected POS payment method ${primary || '(empty)'} is not supported.`);
  }
  const tenders = parsePosPaymentTenders(order.payment_tenders);
  for (const tender of tenders) {
    if (!PROTECTED_PAYMENT_METHODS.has(tender.method)) {
      throw new Error(`Protected POS tender method ${tender.method} is not supported.`);
    }
  }
  if (tenders.length > 0) {
    const maxAmount = Math.max(...tenders.map((tender) => tender.amount));
    if (!tenders.some((tender) => tender.method === primary && tender.amount === maxAmount)) {
      throw new Error('Protected POS primary payment method must match a largest tender allocation.');
    }
  }
}
