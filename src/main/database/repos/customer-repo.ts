import { database } from '../database';

export interface CustomerRow {
  id: string;
  name: string;
  nip: string | null;
  email: string | null;
  phone: string | null;
  credit_limit: number;   // grosze
  current_debt: number;    // grosze
  payment_terms: number;   // days
  updated_at: string | null;
}

export const customerRepo = {
  getAll(): CustomerRow[] {
    return database.all<CustomerRow>('SELECT * FROM pos_customers ORDER BY name');
  },

  getById(id: string): CustomerRow | null {
    return database.get<CustomerRow>('SELECT * FROM pos_customers WHERE id = ?', [id]);
  },

  search(query: string): CustomerRow[] {
    const pattern = `%${query}%`;
    return database.all<CustomerRow>(
      'SELECT * FROM pos_customers WHERE name LIKE ? OR nip LIKE ? OR email LIKE ? ORDER BY name LIMIT 20',
      [pattern, pattern, pattern],
    );
  },

  increaseDebt(id: string, amount: number): void {
    database.run(
      'UPDATE pos_customers SET current_debt = current_debt + ? WHERE id = ?',
      [amount, id],
    );
  },

  upsertMany(customers: CustomerRow[]): void {
    database.transaction(() => {
      for (const c of customers) {
        database.run(
          `INSERT OR REPLACE INTO pos_customers (id, name, nip, email, phone, credit_limit, current_debt, payment_terms, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [c.id, c.name, c.nip, c.email, c.phone, c.credit_limit, c.current_debt, c.payment_terms, c.updated_at],
        );
      }
    });
  },
};
