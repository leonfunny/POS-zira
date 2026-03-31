import { database } from '../database';

export interface DailyReportSummary {
  /** Total revenue from completed sessions (time + F&B) */
  totalRevenue: number;
  /** Revenue from play time only */
  timeRevenue: number;
  /** Revenue from food & beverage only */
  fnbRevenue: number;
  /** Number of completed sessions */
  sessionCount: number;
  /** Average session duration in minutes */
  avgDurationMinutes: number;
  /** Total guests across all sessions */
  totalGuests: number;
  /** Number of package/combo sessions vs per-minute */
  packageSessionCount: number;
  perMinuteSessionCount: number;
}

export interface TableUtilization {
  resourceId: string;
  tableName: string;
  sessionCount: number;
  totalMinutes: number;
  totalRevenue: number;
}

export interface TopFnbItem {
  name: string;
  totalQuantity: number;
  totalRevenue: number;
}

export interface HourlyBreakdown {
  hour: number;
  sessionCount: number;
  revenue: number;
}

export const dailyReportRepo = {
  /**
   * Aggregate summary for a date range.
   * dateFrom/dateTo are ISO date strings (YYYY-MM-DD).
   * Includes completed sessions whose started_at falls within the range.
   */
  getSummary(dateFrom: string, dateTo: string): DailyReportSummary {
    const row = database.get<{
      totalRevenue: number;
      timeRevenue: number;
      fnbRevenue: number;
      sessionCount: number;
      avgDuration: number;
      totalGuests: number;
      packageCount: number;
      perMinuteCount: number;
    }>(
      `SELECT
         COALESCE(SUM(total_charge), 0)  AS totalRevenue,
         COALESCE(SUM(time_charge), 0)   AS timeRevenue,
         COALESCE(SUM(fnb_charge), 0)    AS fnbRevenue,
         COUNT(*)                         AS sessionCount,
         COALESCE(AVG(total_minutes), 0) AS avgDuration,
         COALESCE(SUM(guest_count), 0)   AS totalGuests,
         COALESCE(SUM(CASE WHEN package_mode = 1 THEN 1 ELSE 0 END), 0) AS packageCount,
         COALESCE(SUM(CASE WHEN package_mode = 0 OR package_mode IS NULL THEN 1 ELSE 0 END), 0) AS perMinuteCount
       FROM billiard_sessions
       WHERE status IN ('completed', 'cancelled')
         AND date(started_at) >= date(?)
         AND date(started_at) <= date(?)`,
      [dateFrom, dateTo],
    );

    return {
      totalRevenue: row?.totalRevenue ?? 0,
      timeRevenue: row?.timeRevenue ?? 0,
      fnbRevenue: row?.fnbRevenue ?? 0,
      sessionCount: row?.sessionCount ?? 0,
      avgDurationMinutes: Math.round(row?.avgDuration ?? 0),
      totalGuests: row?.totalGuests ?? 0,
      packageSessionCount: row?.packageCount ?? 0,
      perMinuteSessionCount: row?.perMinuteCount ?? 0,
    };
  },

  /** Revenue and session count per table */
  getTableUtilization(dateFrom: string, dateTo: string): TableUtilization[] {
    return database.all<TableUtilization>(
      `SELECT
         s.resource_id AS resourceId,
         COALESCE(r.name, 'Unknown') AS tableName,
         COUNT(*) AS sessionCount,
         COALESCE(SUM(s.total_minutes), 0) AS totalMinutes,
         COALESCE(SUM(s.total_charge), 0) AS totalRevenue
       FROM billiard_sessions s
       LEFT JOIN billiard_resources r ON r.id = s.resource_id
       WHERE s.status IN ('completed', 'cancelled')
         AND date(s.started_at) >= date(?)
         AND date(s.started_at) <= date(?)
       GROUP BY s.resource_id
       ORDER BY totalRevenue DESC`,
      [dateFrom, dateTo],
    );
  },

  /** Top selling F&B items by quantity */
  getTopFnbItems(dateFrom: string, dateTo: string, limit = 10): TopFnbItem[] {
    return database.all<TopFnbItem>(
      `SELECT
         i.name,
         SUM(i.quantity) AS totalQuantity,
         SUM(i.quantity * i.unit_price) AS totalRevenue
       FROM billiard_session_items i
       JOIN billiard_sessions s ON s.id = i.session_id
       WHERE s.status IN ('completed', 'cancelled')
         AND date(s.started_at) >= date(?)
         AND date(s.started_at) <= date(?)
       GROUP BY i.name
       ORDER BY totalQuantity DESC
       LIMIT ?`,
      [dateFrom, dateTo, limit],
    );
  },

  /** Session count and revenue per hour of day (for peak hours analysis) */
  getHourlyBreakdown(dateFrom: string, dateTo: string): HourlyBreakdown[] {
    return database.all<HourlyBreakdown>(
      `SELECT
         CAST(strftime('%H', started_at) AS INTEGER) AS hour,
         COUNT(*) AS sessionCount,
         COALESCE(SUM(total_charge), 0) AS revenue
       FROM billiard_sessions
       WHERE status IN ('completed', 'cancelled')
         AND date(started_at) >= date(?)
         AND date(started_at) <= date(?)
       GROUP BY hour
       ORDER BY hour`,
      [dateFrom, dateTo],
    );
  },

  /** Full report aggregation in one call */
  getFullReport(dateFrom: string, dateTo: string) {
    return {
      summary: this.getSummary(dateFrom, dateTo),
      tableUtilization: this.getTableUtilization(dateFrom, dateTo),
      topFnbItems: this.getTopFnbItems(dateFrom, dateTo),
      hourlyBreakdown: this.getHourlyBreakdown(dateFrom, dateTo),
    };
  },
};
