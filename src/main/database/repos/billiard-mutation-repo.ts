import { database } from '../database';

export interface BilliardMutationRow {
  id: number;
  operation: string;
  method: string;
  path: string;
  payload: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export const SAFE_BILLIARD_REPLAY_OPERATIONS = [
  'update_session',
  'update_floor_plan',
  'upsert_layout',
  'batch_update_layouts',
  'update_resource',
] as const;

const SAFE_OPERATION_PLACEHOLDERS = SAFE_BILLIARD_REPLAY_OPERATIONS
  .map(() => '?')
  .join(', ');

export const billiardMutationRepo = {
  enqueue(operation: string, method: string, path: string, payload?: any): number {
    database.run(
      `INSERT INTO billiard_mutation_queue (operation, method, path, payload, status, attempts)
      VALUES (?, ?, ?, ?, 'pending', 0)`,
      [operation, method, path, payload ? JSON.stringify(payload) : null],
    );
    const row = database.get<{ id: number }>(
      'SELECT last_insert_rowid() as id',
    );
    return row?.id ?? 0;
  },

  getPending(): BilliardMutationRow[] {
    return database.all<BilliardMutationRow>(
      `SELECT * FROM billiard_mutation_queue
       WHERE status = 'pending' AND operation IN (${SAFE_OPERATION_PLACEHOLDERS})
       ORDER BY id ASC`,
      [...SAFE_BILLIARD_REPLAY_OPERATIONS],
    );
  },

  /**
   * A crash can persist a row after it was marked in_flight but before the
   * response was recorded. Only retry idempotent editor/session metadata
   * operations; time-billing transitions must never be replayed late.
   */
  recoverInterrupted(): { recovered: number; quarantined: number } {
    // Older desktop versions queued time-billing and payment transitions.
    // Preserve those rows for audit, but never replay them after an upgrade.
    database.run(
      `UPDATE billiard_mutation_queue
       SET status = 'quarantined', last_error = 'Quarantined unsafe legacy replay'
       WHERE status IN ('pending', 'in_flight')
         AND operation NOT IN (${SAFE_OPERATION_PLACEHOLDERS})`,
      [...SAFE_BILLIARD_REPLAY_OPERATIONS],
    );
    const quarantined = database.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0;

    database.run(
      `UPDATE billiard_mutation_queue
       SET status = 'pending', last_error = 'Recovered after interrupted replay'
       WHERE status = 'in_flight' AND operation IN (${SAFE_OPERATION_PLACEHOLDERS})`,
      [...SAFE_BILLIARD_REPLAY_OPERATIONS],
    );
    const recovered = database.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0;
    return { recovered, quarantined };
  },

  markInFlight(id: number): void {
    database.run(
      "UPDATE billiard_mutation_queue SET status = 'in_flight', attempts = attempts + 1 WHERE id = ?",
      [id],
    );
  },

  markCompleted(id: number): void {
    database.run(
      "UPDATE billiard_mutation_queue SET status = 'completed' WHERE id = ?",
      [id],
    );
  },

  markFailed(id: number, error: string): void {
    database.run(
      "UPDATE billiard_mutation_queue SET status = 'pending', last_error = ? WHERE id = ?",
      [error, id],
    );
  },

  markQuarantined(id: number, error: string): void {
    database.run(
      "UPDATE billiard_mutation_queue SET status = 'quarantined', last_error = ? WHERE id = ?",
      [error, id],
    );
  },

  countPending(): number {
    const row = database.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM billiard_mutation_queue WHERE status IN ('pending', 'in_flight')",
    );
    return row?.cnt ?? 0;
  },

  clearCompleted(): void {
    database.run("DELETE FROM billiard_mutation_queue WHERE status = 'completed'");
  },

  /** Discard entries that have exceeded max attempts */
  discardStale(maxAttempts: number): void {
    database.run(
      'DELETE FROM billiard_mutation_queue WHERE attempts >= ? AND status = ?',
      [maxAttempts, 'pending'],
    );
  },
};
