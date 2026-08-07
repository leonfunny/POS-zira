import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  mapServerAnalyticsToDailyReport,
  mapServerHistorySession,
} from '../src/shared/billiard-history-contract';

// Fixtures are verbatim dev-backend responses (salon 2981 clone, 2026-07-31).
const history = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/billiard/history-server.json'), 'utf8'),
);
const analytics = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/billiard/analytics-server.json'), 'utf8'),
);

describe('mapServerHistorySession', () => {
  it('maps every real dev row into the snake_case UI shape', () => {
    for (const row of history.data) {
      const mapped = mapServerHistorySession(row);
      expect(mapped.id).toBe(row.id);
      expect(mapped.status).toBe(row.status);
      expect(mapped.total_charge).toBe(Number(row.totalCharge));
      expect(mapped.total_minutes).toBe(Number(row.durationMinutes));
      expect(mapped.tableName).toBe(row.resource?.name ?? '');
      expect(Array.isArray(mapped.items)).toBe(true);
      for (const item of mapped.items) {
        expect(typeof item.name).toBe('string');
        expect(Number.isFinite(item.unit_price)).toBe(true);
        expect(Number.isFinite(item.total_price)).toBe(true);
      }
      // Paid sessions must expose at least one payment row for the UI icons.
      if (String(row.paymentStatus) === 'PAID') {
        expect(mapped.payments.length).toBeGreaterThan(0);
        const sum = mapped.payments.reduce((total, p) => total + p.amount, 0);
        expect(sum).toBeGreaterThan(0);
      }
    }
  });

  it('builds a fallback payment from paidAmount when split details are absent', () => {
    const mapped = mapServerHistorySession({
      id: 's1',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      paymentMethod: 'CASH',
      paidAmount: '42.50',
      endedAt: '2026-07-31T10:00:00.000Z',
    });
    expect(mapped.payments).toEqual([
      { id: 's1-p0', method: 'CASH', amount: 42.5, createdAt: '2026-07-31T10:00:00.000Z' },
    ]);
  });

  it('is defensive about junk rows', () => {
    const mapped = mapServerHistorySession({});
    expect(mapped.items).toEqual([]);
    expect(mapped.payments).toEqual([]);
    expect(mapped.total_charge).toBe(0);
  });
});

describe('mapServerAnalyticsToDailyReport', () => {
  it('maps the real dev analytics into the DailyReport shape', () => {
    const report = mapServerAnalyticsToDailyReport(analytics);
    expect(report.summary.totalRevenue).toBe(Number(analytics.totalRevenue));
    expect(report.summary.sessionCount).toBe(Number(analytics.totalSessions));
    // Server buckets: fnb already contains walk-in retail, so time + fnb
    // re-composes the total and retail stays within fnb.
    expect(
      report.summary.timeRevenue + report.summary.fnbRevenue,
    ).toBeCloseTo(report.summary.totalRevenue, 2);
    expect(report.retailRevenue).toBeLessThanOrEqual(report.summary.fnbRevenue);
    expect(report.tableUtilization.length).toBe(analytics.revenueByTable.length);
    expect(report.tableUtilization[0].tableName).toBe(
      analytics.revenueByTable[0].resourceName,
    );
    expect(report.hourlyBreakdown.length).toBe(analytics.peakHours.length);
    expect(report.hourlyBreakdown[0].sessionCount).toBe(
      analytics.peakHours[0].sessions,
    );
  });
});
