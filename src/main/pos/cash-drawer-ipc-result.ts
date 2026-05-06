export interface CashDrawerIpcResult {
  success: boolean;
  drawerOpened: boolean;
  error?: string;
}

const DEFAULT_DRAWER_ERROR = 'Cash drawer did not open';

function readableError(error?: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error == null) return DEFAULT_DRAWER_ERROR;

  const message = String(error);
  return message.trim() || DEFAULT_DRAWER_ERROR;
}

export function toCashDrawerIpcResult(
  drawerOpened: boolean | undefined,
  error?: unknown,
): CashDrawerIpcResult {
  if (drawerOpened === true) {
    return { success: true, drawerOpened: true };
  }

  return {
    success: false,
    drawerOpened: false,
    error: readableError(error),
  };
}
