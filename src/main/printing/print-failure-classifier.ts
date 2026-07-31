import type { PrintJobFailureClass } from '../../shared/types';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

export function getExplicitPrintFailureClass(error: unknown): PrintJobFailureClass | null {
  if (!error || typeof error !== 'object') return null;

  const failureClass = (error as { failureClass?: unknown }).failureClass;
  if (
    failureClass === 'SAFE_BEFORE_PRINT'
    || failureClass === 'UNCERTAIN_AFTER_PRINT'
    || failureClass === 'FINAL'
  ) {
    return failureClass;
  }

  return null;
}

export function classifyPrintFailureAfterDriverCall(error: unknown, fiscal: boolean): PrintJobFailureClass {
  const explicitFailureClass = getExplicitPrintFailureClass(error);
  if (explicitFailureClass) return explicitFailureClass;

  const message = errorMessage(error);

  if (/FISCAL_RESULT_UNKNOWN|UNKNOWN_NEEDS_RECONCILIATION|APP_RESTART_AFTER_SENT/i.test(message)) {
    return 'UNCERTAIN_AFTER_PRINT';
  }

  if (/FISCAL_ATTEMPT_RETRY_BLOCKED|BLOCKED_BY_SAFETY_GATE/i.test(message)) {
    return 'FINAL';
  }

  if (
    /REAL_FISCAL_PRINT_DISABLED|FISCAL_IDEMPOTENCY_KEY_MISSING|ELZAB_HARDWARE_NOT_FOUND|ELZAB_PROTOCOL_NOT_READY/i.test(message) ||
    /PORT_NOT_FOUND|PORT_BUSY|printer .*not connected|not connected/i.test(message) ||
    /ReceiptBegin failed|ReceiptConditions failed|ELZAB_LOCAL_MENU_MODE/i.test(message)
  ) {
    return 'SAFE_BEFORE_PRINT';
  }

  return 'UNCERTAIN_AFTER_PRINT';
}
