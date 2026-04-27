import type { BooksySyncStatus } from '../../shared/types';

type BooksyPushWarningReason = 'network-error' | 'timeout' | 'non-2xx';

type BooksyPushReport = {
  time: string;
  pushed: boolean;
  pushReason?: 'not-configured' | BooksyPushWarningReason | 'jwt-expired';
  pushErrors?: number;
};

export type BooksyPushWarning = {
  entity: 'Calendar' | 'Customers' | 'Staff' | 'Resources' | 'Services' | 'Addons';
  reason: BooksyPushWarningReason | undefined;
  partial: boolean;
  errors: number;
};

type BooksyPushWarningCandidate = BooksyPushWarning & {
  time: number;
  severity: number;
};

const fullFailureReasons = new Set<BooksyPushWarningReason>([
  'network-error',
  'timeout',
  'non-2xx',
]);

export function deriveBooksyPushWarning(status: BooksySyncStatus | null): BooksyPushWarning | null {
  if (!status) return null;

  const reports: { entity: BooksyPushWarning['entity']; report: BooksyPushReport | null }[] = [
    { entity: 'Calendar', report: status.lastSyncReport },
    { entity: 'Customers', report: status.lastCustomerSyncReport },
    { entity: 'Staff', report: status.lastStaffSyncReport },
    { entity: 'Resources', report: status.lastResourceSyncReport },
    { entity: 'Services', report: status.lastServiceSyncReport },
    { entity: 'Addons', report: status.lastAddonSyncReport },
  ];

  const candidates: BooksyPushWarningCandidate[] = [];

  for (const { entity, report } of reports) {
    if (!report) continue;

    if (report.pushed && (report.pushErrors ?? 0) > 0) {
      candidates.push({
        entity,
        reason: undefined,
        partial: true,
        errors: report.pushErrors ?? 0,
        time: Date.parse(report.time) || 0,
        severity: 1,
      });
      continue;
    }

    if (!report.pushed && report.pushReason && fullFailureReasons.has(report.pushReason as BooksyPushWarningReason)) {
      candidates.push({
        entity,
        reason: report.pushReason as BooksyPushWarningReason,
        partial: false,
        errors: 0,
        time: Date.parse(report.time) || 0,
        severity: 2,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.time - a.time || b.severity - a.severity);
  const { entity, reason, partial, errors } = candidates[0];
  return { entity, reason, partial, errors };
}
