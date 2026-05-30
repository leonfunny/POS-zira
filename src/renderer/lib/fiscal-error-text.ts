// Maps raw ELZAB/fiscal error strings (codes + Polish device messages) into
// clear, actionable operator guidance. Keeps the cashier from staring at
// "ELZAB_COMMAND_FAILED: TRYB MENU LOKALNEGO" and not knowing what to do.
//
// tOr is the caller's translate-or-fallback helper so the text still localizes;
// the fallbacks are Vietnamese because this deployment's operators read VI and
// the fiscal device is Poland-specific.
export function describeFiscalError(
  raw: string | undefined | null,
  tOr: (key: string, fallback: string) => string,
): string {
  const s = (raw ?? '').toString();
  const has = (re: RegExp) => re.test(s);

  if (has(/RETRY_BLOCKED/i)) {
    return tOr('pos.fiscal.err.retryBlocked', 'Đơn đang chờ đối soát — chọn "Đã in" hoặc "Chưa in" ở trên trước khi in lại.');
  }
  if (has(/RESULT_UNKNOWN|NEEDS_RECONCILIATION/i)) {
    return tOr('pos.fiscal.err.unknown', 'Lần in trước chưa xác nhận. Kiểm tra máy rồi đối soát (đã in / chưa in) trước khi in lại.');
  }
  if (has(/LOCAL_MENU|MENU\s*LOKAL/i)) {
    return tOr('pos.fiscal.err.localMenu', 'Máy fiskal đang ở menu cục bộ (TRYB MENU LOKALNEGO). Thoát menu trên máy rồi thử lại.');
  }
  if (has(/RAPORT\s*DOBOW|ZALEG/i)) {
    return tOr('pos.fiscal.err.dailyReport', 'Máy yêu cầu làm Báo cáo ngày (raport dobowy) trước khi in tiếp.');
  }
  if (has(/HARDWARE_NOT_FOUND|brak\s*portu|otworzy|TARGET_MISSING/i)) {
    return tOr('pos.fiscal.err.noPort', 'Không thấy máy fiskal (mất cổng COM). Kiểm tra cáp/cổng USB rồi thử lại.');
  }
  if (has(/REAL_FISCAL_PRINT_DISABLED/i)) {
    return tOr('pos.fiscal.err.disabled', 'In fiskal thật đang bị tắt trong cấu hình.');
  }
  return s || tOr('pos.fiscal.err.generic', 'In fiskal thất bại.');
}
