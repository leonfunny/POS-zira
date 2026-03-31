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
      "SELECT * FROM billiard_mutation_queue WHERE status = 'pending' ORDER BY id ASC",
    );
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
