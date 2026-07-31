export type ReceiptPrintStatus = 'COMPLETED' | 'FAILED_SAFE' | 'NEEDS_REVIEW';

export interface ReceiptPrintStatusInfo {
  jobId: string;
  orderId: string;
  orderNumber?: string | null;
  status: ReceiptPrintStatus;
}

/**
 * Merge live main-process events with the durable startup snapshot.
 *
 * The snapshot can resolve after a newer COMPLETED event. Once completion was
 * observed, an older FAILED_SAFE/NEEDS_REVIEW snapshot must never resurrect a
 * warning for that job.
 */
export function createReceiptPrintStatusHandler(
  showWarning: (message: string) => void,
): (info: ReceiptPrintStatusInfo) => void {
  const latestStatus = new Map<string, ReceiptPrintStatus>();
  const completedJobs = new Set<string>();

  return (info) => {
    const jobId = String(info?.jobId || '').trim();
    if (!jobId) return;

    if (info.status === 'COMPLETED') {
      completedJobs.add(jobId);
      latestStatus.set(jobId, info.status);
      return;
    }
    if (completedJobs.has(jobId) || latestStatus.get(jobId) === info.status) {
      return;
    }
    latestStatus.set(jobId, info.status);

    const label = info.orderNumber || info.orderId;
    const message = info.status === 'NEEDS_REVIEW'
      ? `${label}: trạng thái in chưa chắc chắn — kiểm tra giấy trước khi in lại`
      : `${label}: máy in chưa nhận đơn — hệ thống sẽ tự thử lại, chưa in lại thủ công`;
    showWarning(message);
  };
}
