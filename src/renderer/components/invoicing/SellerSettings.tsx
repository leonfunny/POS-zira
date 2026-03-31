import React, { useState, useEffect } from 'react';
import { SellerSettingsRow, SellerSettingsUpdateDTO, KsefEnvironment } from '../../../shared/types';
import { useTranslation } from '../../i18n/useTranslation';

interface SellerSettingsProps {
  initialSettings?: SellerSettingsRow | null;
  onSaved: (settings: SellerSettingsRow) => void;
  language: string;
}

export default function SellerSettings({ initialSettings, onSaved, language }: SellerSettingsProps) {
  const { t } = useTranslation(language as any);
  const [form, setForm] = useState<SellerSettingsUpdateDTO>({
    company_name: '',
    nip: '',
    regon: '',
    street: '',
    city: '',
    postal_code: '',
    country: 'PL',
    email: '',
    phone: '',
    website: '',
    bank_account: '',
    bank_name: '',
    is_vat_registered: true,
    default_payment_term_days: 14,
    invoice_footer: '',
    default_invoice_notes: '',
    // KSeF settings
    ksef_enabled: false,
    ksef_auto_send: true,
    ksef_environment: 'TEST' as KsefEnvironment,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Load initial settings
  useEffect(() => {
    if (initialSettings) {
      setForm({
        company_name: initialSettings.company_name,
        nip: initialSettings.nip,
        regon: initialSettings.regon || '',
        street: initialSettings.street,
        city: initialSettings.city,
        postal_code: initialSettings.postal_code,
        country: initialSettings.country || 'PL',
        email: initialSettings.email || '',
        phone: initialSettings.phone || '',
        website: initialSettings.website || '',
        bank_account: initialSettings.bank_account || '',
        bank_name: initialSettings.bank_name || '',
        is_vat_registered: initialSettings.is_vat_registered === 1,
        default_payment_term_days: initialSettings.default_payment_term_days,
        invoice_footer: initialSettings.invoice_footer || '',
        default_invoice_notes: initialSettings.default_invoice_notes || '',
        // KSeF settings
        ksef_enabled: initialSettings.ksef_enabled === 1,
        ksef_auto_send: initialSettings.ksef_auto_send === 1,
        ksef_environment: initialSettings.ksef_environment || 'TEST',
      });
    }
  }, [initialSettings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    // Validate required fields
    if (!form.company_name.trim()) {
      setError(t('invoice.error.companyNameRequired'));
      return;
    }
    if (!form.nip.trim() || form.nip.length !== 10) {
      setError(t('invoice.error.nipInvalid'));
      return;
    }
    if (!form.street.trim() || !form.city.trim() || !form.postal_code.trim()) {
      setError(t('invoice.error.addressRequired'));
      return;
    }

    setSaving(true);
    try {
      const result = await window.electronAPI.invoice.seller.update(form);
      if (result.success) {
        // Fetch updated settings after successful save
        const updated = await window.electronAPI.invoice.seller.get();
        if (updated.success && updated.data) {
          onSaved(updated.data);
        }
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        setError(result.error || 'Failed to save settings');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel p-4">
      <h2 className="text-lg font-semibold text-slate-800 mb-4">{t('invoice.sellerSettings')}</h2>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 rounded-lg mb-4">
          <svg className="w-4 h-4 text-red-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-red-700">{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 bg-green-50 rounded-lg mb-4">
          <svg className="w-4 h-4 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm text-green-700">{t('settings.saved')}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Company Info */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('invoice.companyName')} *
            </label>
            <input
              type="text"
              value={form.company_name}
              onChange={(e) => setForm({ ...form, company_name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              NIP *
            </label>
            <input
              type="text"
              value={form.nip}
              onChange={(e) => setForm({ ...form, nip: e.target.value.replace(/[^\d]/g, '').slice(0, 10) })}
              placeholder="1234567890"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-600 mb-1">
            REGON
          </label>
          <input
            type="text"
            value={form.regon}
            onChange={(e) => setForm({ ...form, regon: e.target.value.replace(/[^\d]/g, '').slice(0, 14) })}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
          />
        </div>

        {/* Address */}
        <div className="border-t border-slate-200 pt-4 mt-4">
          <h3 className="text-sm font-medium text-slate-700 mb-3">{t('invoice.address')}</h3>

          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('invoice.street')} *
              </label>
              <input
                type="text"
                value={form.street}
                onChange={(e) => setForm({ ...form, street: e.target.value })}
                placeholder="ul. Przykladowa 1/2"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                required
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('invoice.postalCode')} *
                </label>
                <input
                  type="text"
                  value={form.postal_code}
                  onChange={(e) => setForm({ ...form, postal_code: e.target.value })}
                  placeholder="00-000"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  required
                />
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('invoice.city')} *
                </label>
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  placeholder="Warszawa"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  required
                />
              </div>
            </div>
          </div>
        </div>

        {/* Contact */}
        <div className="border-t border-slate-200 pt-4 mt-4">
          <h3 className="text-sm font-medium text-slate-700 mb-3">{t('invoice.contact')}</h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('invoice.email')}
              </label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('invoice.phone')}
              </label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              />
            </div>
          </div>
        </div>

        {/* Bank */}
        <div className="border-t border-slate-200 pt-4 mt-4">
          <h3 className="text-sm font-medium text-slate-700 mb-3">{t('invoice.bankDetails')}</h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('invoice.bankName')}
              </label>
              <input
                type="text"
                value={form.bank_name}
                onChange={(e) => setForm({ ...form, bank_name: e.target.value })}
                placeholder="mBank"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('invoice.bankAccount')} (IBAN)
              </label>
              <input
                type="text"
                value={form.bank_account}
                onChange={(e) => setForm({ ...form, bank_account: e.target.value })}
                placeholder="PL00 0000 0000 0000 0000 0000 0000"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              />
            </div>
          </div>
        </div>

        {/* Settings */}
        <div className="border-t border-slate-200 pt-4 mt-4">
          <h3 className="text-sm font-medium text-slate-700 mb-3">{t('invoice.invoiceSettings')}</h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('invoice.paymentTermDays')}
              </label>
              <input
                type="number"
                value={form.default_payment_term_days}
                onChange={(e) => setForm({ ...form, default_payment_term_days: parseInt(e.target.value) || 14 })}
                min="1"
                max="90"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              />
            </div>
            <div className="flex items-center">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_vat_registered}
                  onChange={(e) => setForm({ ...form, is_vat_registered: e.target.checked })}
                  className="rounded border-slate-300 text-brand-600 focus:ring-brand-300"
                />
                <span className="text-sm text-slate-600">{t('invoice.isVatRegistered')}</span>
              </label>
            </div>
          </div>

          <div className="mt-3">
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('invoice.invoiceFooter')}
            </label>
            <textarea
              value={form.invoice_footer}
              onChange={(e) => setForm({ ...form, invoice_footer: e.target.value })}
              rows={2}
              placeholder={t('invoice.invoiceFooterPlaceholder')}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none resize-none"
            />
          </div>
        </div>

        {/* KSeF Settings */}
        <div className="border-t border-slate-200 pt-4 mt-4">
          <h3 className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
            <svg className="w-5 h-5 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            {t('invoice.ksef.title')}
          </h3>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
            <p className="text-sm text-blue-700">
              {t('invoice.ksef.description')}
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
              <div>
                <label className="text-sm font-medium text-slate-700">{t('invoice.ksef.enabled')}</label>
                <p className="text-xs text-slate-500">{t('invoice.ksef.enabledDesc')}</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.ksef_enabled}
                  onChange={(e) => setForm({ ...form, ksef_enabled: e.target.checked })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-brand-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-600"></div>
              </label>
            </div>

            {form.ksef_enabled && (
              <>
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div>
                    <label className="text-sm font-medium text-slate-700">{t('invoice.ksef.autoSend')}</label>
                    <p className="text-xs text-slate-500">{t('invoice.ksef.autoSendDesc')}</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.ksef_auto_send}
                      onChange={(e) => setForm({ ...form, ksef_auto_send: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-brand-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-600"></div>
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('invoice.ksef.environment')}
                  </label>
                  <select
                    value={form.ksef_environment}
                    onChange={(e) => setForm({ ...form, ksef_environment: e.target.value as KsefEnvironment })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  >
                    <option value="TEST">{t('invoice.ksef.envTest')}</option>
                    <option value="PRODUCTION">{t('invoice.ksef.envProduction')}</option>
                  </select>
                  {form.ksef_environment === 'TEST' && (
                    <p className="text-xs text-amber-600 mt-1">{t('invoice.ksef.testWarning')}</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Submit */}
        <div className="pt-4">
          <button
            type="submit"
            disabled={saving}
            className="w-full px-4 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <span className="flex items-center justify-center gap-2">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                {t('common.saving')}
              </span>
            ) : (
              t('settings.save')
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
