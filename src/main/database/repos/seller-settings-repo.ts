import { database } from '../database';
import { SellerSettingsRow, SellerSettingsUpdateDTO } from '../../../shared/types';
import logger from '../../logger';

export const sellerSettingsRepo = {
  /**
   * Get seller settings (singleton, id='default')
   */
  get(): SellerSettingsRow | null {
    return database.get<SellerSettingsRow>('SELECT * FROM seller_settings WHERE id = ?', ['default']);
  },

  /**
   * Check if seller settings exist
   */
  exists(): boolean {
    const row = database.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM seller_settings WHERE id = ?', ['default']);
    return (row?.cnt ?? 0) > 0;
  },

  /**
   * Create or update seller settings
   */
  upsert(data: SellerSettingsUpdateDTO): SellerSettingsRow {
    const existing = this.get();

    if (existing) {
      // Update
      database.run(
        `UPDATE seller_settings SET
          company_name = ?,
          nip = ?,
          regon = ?,
          street = ?,
          city = ?,
          postal_code = ?,
          country = ?,
          email = ?,
          phone = ?,
          website = ?,
          bank_account = ?,
          bank_name = ?,
          swift_code = ?,
          is_vat_registered = ?,
          logo_path = ?,
          invoice_footer = ?,
          default_payment_term_days = ?,
          default_invoice_notes = ?,
          ksef_enabled = ?,
          ksef_auto_send = ?,
          ksef_environment = ?,
          ksef_auth_token = COALESCE(?, ksef_auth_token),
          updated_at = datetime('now')
        WHERE id = ?`,
        [
          data.company_name,
          data.nip,
          data.regon ?? null,
          data.street,
          data.city,
          data.postal_code,
          data.country ?? 'PL',
          data.email ?? null,
          data.phone ?? null,
          data.website ?? null,
          data.bank_account ?? null,
          data.bank_name ?? null,
          data.swift_code ?? null,
          data.is_vat_registered !== false ? 1 : 0,
          data.logo_path ?? null,
          data.invoice_footer ?? null,
          data.default_payment_term_days ?? 14,
          data.default_invoice_notes ?? null,
          data.ksef_enabled ? 1 : 0,
          data.ksef_auto_send !== false ? 1 : 0,
          data.ksef_environment ?? 'TEST',
          data.ksef_auth_token ?? null,
          'default',
        ],
      );
      logger.info('[SellerSettingsRepo] Updated seller settings');
    } else {
      // Create
      database.run(
        `INSERT INTO seller_settings (
          id, company_name, nip, regon, street, city, postal_code, country,
          email, phone, website, bank_account, bank_name, swift_code,
          is_vat_registered, logo_path, invoice_footer, default_payment_term_days, default_invoice_notes,
          ksef_enabled, ksef_auto_send, ksef_environment, ksef_auth_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'default',
          data.company_name,
          data.nip,
          data.regon ?? null,
          data.street,
          data.city,
          data.postal_code,
          data.country ?? 'PL',
          data.email ?? null,
          data.phone ?? null,
          data.website ?? null,
          data.bank_account ?? null,
          data.bank_name ?? null,
          data.swift_code ?? null,
          data.is_vat_registered !== false ? 1 : 0,
          data.logo_path ?? null,
          data.invoice_footer ?? null,
          data.default_payment_term_days ?? 14,
          data.default_invoice_notes ?? null,
          data.ksef_enabled ? 1 : 0,
          data.ksef_auto_send !== false ? 1 : 0,
          data.ksef_environment ?? 'TEST',
          data.ksef_auth_token ?? null,
        ],
      );
      logger.info('[SellerSettingsRepo] Created seller settings');
    }

    database.markDirty();
    return this.get()!;
  },

  /**
   * Update KSeF sync status
   */
  updateKsefStatus(error: string | null): void {
    database.run(
      `UPDATE seller_settings SET
        ksef_last_sync_at = datetime('now'),
        ksef_last_error = ?,
        updated_at = datetime('now')
      WHERE id = ?`,
      [error, 'default'],
    );
    database.markDirty();
  },

  /**
   * Check if KSeF is enabled and auto-send is on
   */
  isKsefAutoSendEnabled(): boolean {
    const settings = this.get();
    return settings?.ksef_enabled === 1 && settings?.ksef_auto_send === 1;
  },

  /**
   * Get formatted seller address line
   */
  getFormattedAddress(): string {
    const settings = this.get();
    if (!settings) return '';
    return `${settings.street}, ${settings.postal_code} ${settings.city}`;
  },
};
