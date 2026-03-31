import { database } from '../database';

export interface BilliardPayment {
  id: string;
  sessionId: string;
  method: string;
  amount: number;
  createdAt: string;
}

export const billiardPaymentRepo = {
  /** Record a single payment split for a session */
  create(payment: { id: string; sessionId: string; method: string; amount: number }): void {
    database.run(
      `INSERT INTO billiard_payments (id, session_id, method, amount)
       VALUES (?, ?, ?, ?)`,
      [payment.id, payment.sessionId, payment.method, payment.amount],
    );
  },

  /** Get all payment records for a session */
  getBySession(sessionId: string): BilliardPayment[] {
    return database.all<BilliardPayment>(
      `SELECT id, session_id AS sessionId, method, amount,
              created_at AS createdAt
       FROM billiard_payments
       WHERE session_id = ?
       ORDER BY created_at ASC`,
      [sessionId],
    );
  },

  /** Delete all payment records for a session (used if payment is reversed) */
  deleteBySession(sessionId: string): void {
    database.run('DELETE FROM billiard_payments WHERE session_id = ?', [sessionId]);
  },
};
