import { database } from '../database';

export interface ServicePopularityRow {
  service_id: string;
  service_name: string;
  total_count: number;
  last_30_days_count: number;
  updated_at: string;
}

export const servicePopularityRepo = {
  getTop(limit = 8): ServicePopularityRow[] {
    return database.all<ServicePopularityRow>(
      `SELECT * FROM service_popularity
       ORDER BY last_30_days_count DESC, total_count DESC
       LIMIT ?`,
      [limit],
    );
  },

  refresh(): void {
    // Rebuild from checkins table
    database.run('DELETE FROM service_popularity');
    database.run(
      `INSERT INTO service_popularity (service_id, service_name, total_count, last_30_days_count, updated_at)
       SELECT
         COALESCE(service_id, 'svc-' || REPLACE(LOWER(service_name), ' ', '-')),
         service_name,
         COUNT(*) as total_count,
         SUM(CASE WHEN checked_in_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as last_30_days_count,
         datetime('now')
       FROM checkins
       WHERE service_name IS NOT NULL AND service_name != ''
       GROUP BY service_name`,
    );
  },
};
