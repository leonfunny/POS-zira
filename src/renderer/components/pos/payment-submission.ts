export type PaymentMethod = 'CASH' | 'CARD' | 'BLIK' | 'TRANSFER' | 'INVOICE';

export interface Tender {
  method: PaymentMethod;
  amount: number;
}

export interface PaymentSubmissionState {
  method: PaymentMethod;
  splitMode: boolean;
  tenders: Tender[];
  cashAmountGrosze: number;
  grandTotal: number;
}

export interface PaymentSubmissionOverrides {
  method?: PaymentMethod;
  splitMode?: boolean;
  tenders?: Tender[];
  cashAmountGrosze?: number;
}

export interface ResolvedPaymentSubmission extends PaymentSubmissionState {
  tendersTotal: number;
  paymentAmount: number;
  changeGrosze: number;
  complete: boolean;
}

/**
 * Resolve the exact tender snapshot that will be committed. Scanner commands
 * pass overrides because their React state updates are intentionally async;
 * the current payment action must never read the previous split-tender state.
 */
export function resolvePaymentSubmission(
  state: PaymentSubmissionState,
  overrides: PaymentSubmissionOverrides = {},
): ResolvedPaymentSubmission {
  const method = overrides.method ?? state.method;
  const splitMode = overrides.splitMode ?? state.splitMode;
  const tenders = [...(overrides.tenders ?? state.tenders)];
  const cashAmountGrosze = overrides.cashAmountGrosze ?? state.cashAmountGrosze;
  const tendersTotal = tenders.reduce((sum, tender) => sum + tender.amount, 0);
  const splitComplete = Math.abs(tendersTotal - state.grandTotal) < 1;
  const complete = splitMode
    ? splitComplete
    : method !== 'CASH' || cashAmountGrosze >= state.grandTotal;
  const paymentAmount = splitMode
    ? tendersTotal
    : method === 'CASH'
      ? cashAmountGrosze
      : state.grandTotal;
  const changeGrosze = splitMode || method !== 'CASH'
    ? 0
    : Math.max(0, paymentAmount - state.grandTotal);

  return {
    method,
    splitMode,
    tenders,
    cashAmountGrosze,
    grandTotal: state.grandTotal,
    tendersTotal,
    paymentAmount,
    changeGrosze,
    complete,
  };
}
