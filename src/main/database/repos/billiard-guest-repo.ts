import { database } from '../database';

export interface BilliardGuestRow {
  id: string;
  name: string;
  phone: string;
  notes: string;
  visit_count: number;
  last_seen: string | null;
  created_at: string;
}

export const billiardGuestRepo = {
  /** Search guests by phone or name (typeahead). Returns max 10 results. */
  search(query: string): BilliardGuestRow[] {
    const like = `%${query}%`;
    return database.all<BilliardGuestRow>(
      `SELECT * FROM billiard_guests
       WHERE phone LIKE ? OR name LIKE ?
       ORDER BY last_seen DESC NULLS LAST, visit_count DESC
       LIMIT 10`,
      [like, like],
    );
  },

  /** Get a single guest by ID */
  getById(id: string): BilliardGuestRow | null {
    return database.get<BilliardGuestRow>(
      'SELECT * FROM billiard_guests WHERE id = ?',
      [id],
    );
  },

  /** Insert or update a guest record */
  upsert(guest: {
    id: string;
    name: string;
    phone: string;
    notes?: string;
  }): void {
    database.run(
      `INSERT INTO billiard_guests (id, name, phone, notes, visit_count, last_seen, created_at)
       VALUES (?, ?, ?, ?, 0, NULL, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         phone = excluded.phone,
         notes = excluded.notes`,
      [guest.id, guest.name, guest.phone, guest.notes || ''],
    );
  },

  /** Increment visit count and update last_seen to today */
  bumpVisit(id: string): void {
    database.run(
      `UPDATE billiard_guests
       SET visit_count = visit_count + 1,
           last_seen = date('now')
       WHERE id = ?`,
      [id],
    );
  },
};
