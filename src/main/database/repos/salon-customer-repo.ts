import { database } from '../database';

export interface SalonCustomerRow {
  id: string;
  backend_customer_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  notes: string | null;
  preferred_staff_id: string | null;
  preferred_staff_name: string | null;
  visit_count: number;
  last_visit_at: string | null;
  last_service_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerServiceHistoryRow {
  id: number;
  customer_id: string;
  service_name: string;
  service_id: string | null;
  staff_name: string | null;
  staff_id: string | null;
  checkin_id: string | null;
  created_at: string;
}

export interface ServiceRecommendation {
  service_name: string;
  service_id: string | null;
  count: number;
}

export interface SalonCustomerCreateData {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  birthday?: string;
  notes?: string;
  backend_customer_id?: string;
}

export const salonCustomerRepo = {
  getByPhone(phone: string): SalonCustomerRow | null {
    return database.get<SalonCustomerRow>(
      'SELECT * FROM salon_customers WHERE phone = ?',
      [phone],
    ) || null;
  },

  getById(id: string): SalonCustomerRow | null {
    return database.get<SalonCustomerRow>(
      'SELECT * FROM salon_customers WHERE id = ?',
      [id],
    ) || null;
  },

  search(query: string): SalonCustomerRow[] {
    const pattern = `%${query}%`;
    return database.all<SalonCustomerRow>(
      `SELECT * FROM salon_customers
       WHERE name LIKE ? OR phone LIKE ?
       ORDER BY visit_count DESC, name ASC
       LIMIT 20`,
      [pattern, pattern],
    );
  },

  create(data: SalonCustomerCreateData): SalonCustomerRow {
    database.run(
      `INSERT INTO salon_customers (id, name, phone, email, birthday, notes, backend_customer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.name,
        data.phone || null,
        data.email || null,
        data.birthday || null,
        data.notes || null,
        data.backend_customer_id || null,
      ],
    );
    return this.getById(data.id)!;
  },

  upsertByPhone(data: SalonCustomerCreateData): SalonCustomerRow {
    if (data.phone) {
      const existing = this.getByPhone(data.phone);
      if (existing) {
        database.run(
          `UPDATE salon_customers SET name = ?, email = COALESCE(?, email),
           birthday = COALESCE(?, birthday), notes = COALESCE(?, notes),
           updated_at = datetime('now') WHERE id = ?`,
          [data.name, data.email || null, data.birthday || null, data.notes || null, existing.id],
        );
        return this.getById(existing.id)!;
      }
    }
    return this.create(data);
  },

  update(id: string, data: Partial<SalonCustomerCreateData>): void {
    const fields: string[] = [];
    const values: any[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone); }
    if (data.email !== undefined) { fields.push('email = ?'); values.push(data.email); }
    if (data.birthday !== undefined) { fields.push('birthday = ?'); values.push(data.birthday); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    values.push(id);
    database.run(`UPDATE salon_customers SET ${fields.join(', ')} WHERE id = ?`, values);
  },

  recordVisit(customerId: string, serviceName: string, serviceId?: string, staffName?: string, staffId?: string, checkinId?: string): void {
    // Add to service history
    database.run(
      `INSERT INTO customer_service_history (customer_id, service_name, service_id, staff_name, staff_id, checkin_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [customerId, serviceName, serviceId || null, staffName || null, staffId || null, checkinId || null],
    );
    // Update customer stats
    database.run(
      `UPDATE salon_customers SET
        visit_count = visit_count + 1,
        last_visit_at = datetime('now'),
        last_service_name = ?,
        preferred_staff_id = COALESCE(?, preferred_staff_id),
        preferred_staff_name = COALESCE(?, preferred_staff_name),
        updated_at = datetime('now')
       WHERE id = ?`,
      [serviceName, staffId || null, staffName || null, customerId],
    );
  },

  getHistory(customerId: string, limit = 20): CustomerServiceHistoryRow[] {
    return database.all<CustomerServiceHistoryRow>(
      `SELECT * FROM customer_service_history
       WHERE customer_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [customerId, limit],
    );
  },

  getRecommendations(customerId: string, limit = 5): ServiceRecommendation[] {
    return database.all<ServiceRecommendation>(
      `SELECT service_name, service_id, COUNT(*) as count
       FROM customer_service_history
       WHERE customer_id = ?
       GROUP BY service_name
       ORDER BY count DESC
       LIMIT ?`,
      [customerId, limit],
    );
  },
};
