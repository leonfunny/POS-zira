import React, { useState, useEffect } from 'react';
import { InvoiceCustomerRow, InvoiceCustomerCreateDTO } from '../../../shared/types';
import { useTranslation } from '../../i18n/useTranslation';
import { useDeleteConfirm } from '../DeleteConfirmModal';
import rlog from '../../utils/logger';

interface CustomerManagementProps {
  language: string;
}

export default function CustomerManagement({ language }: CustomerManagementProps) {
  const { t } = useTranslation(language as any);
  const { confirmDelete, DeleteModal } = useDeleteConfirm();
  const [customers, setCustomers] = useState<InvoiceCustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<InvoiceCustomerRow | null>(null);
  const [form, setForm] = useState<InvoiceCustomerCreateDTO>({
    name: '',
    is_company: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    loadCustomers();
  }, [search]);

  const loadCustomers = async () => {
    setLoading(true);
    try {
      const result = search.trim().length >= 2
        ? await window.electronAPI.invoice.customer.search(search)
        : await window.electronAPI.invoice.customer.list();

      if (!result.success) {
        setCustomers([]);
        setError(result.error || 'Failed to load customers');
        return;
      }
      setCustomers(result.data ?? []);
      setError(null);
    } catch (err) {
      rlog.error('Failed to load customers:', err);
      setCustomers([]);
      setError(err instanceof Error ? err.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (customer: InvoiceCustomerRow) => {
    setEditingCustomer(customer);
    setForm({
      name: customer.name,
      short_name: customer.short_name || '',
      is_company: customer.is_company === 1,
      nip: customer.nip || '',
      regon: customer.regon || '',
      street: customer.street || '',
      city: customer.city || '',
      postal_code: customer.postal_code || '',
      email: customer.email || '',
      phone: customer.phone || '',
      contact_person: customer.contact_person || '',
      payment_term_days: customer.payment_term_days,
      notes: customer.notes || '',
    });
    setShowForm(true);
    setError(null);
  };

  const handleCreate = () => {
    setEditingCustomer(null);
    setForm({
      name: '',
      is_company: false,
    });
    setShowForm(true);
    setError(null);
  };

  const handleClose = () => {
    setShowForm(false);
    setEditingCustomer(null);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError(t('invoice.error.customerNameRequired'));
      return;
    }

    setSaving(true);
    try {
      if (editingCustomer) {
        const result = await window.electronAPI.invoice.customer.update(editingCustomer.id, form);
        if (!result.success) throw new Error(result.error);
      } else {
        const result = await window.electronAPI.invoice.customer.create(form);
        if (!result.success) throw new Error(result.error);
      }

      handleClose();
      loadCustomers();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (id: string, customerName: string) => {
    confirmDelete({
      title: t('deleteConfirm.title'),
      message: t('deleteConfirm.message'),
      itemName: customerName,
      onConfirm: async () => {
        try {
          const result = await window.electronAPI.invoice.customer.delete(id);
          if (result.success) {
            loadCustomers();
          } else {
            setDeleteError(result.error || 'Failed to delete customer');
          }
        } catch (err: any) {
          setDeleteError(err.message);
        }
      },
    });
  };

  return (
    <div className="panel p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-800">{t('invoice.customers')}</h2>
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('invoice.addCustomer')}
        </button>
      </div>

      {/* Delete error */}
      {deleteError && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-100 rounded-lg mb-4">
          <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-red-700 flex-1">{deleteError}</span>
          <button onClick={() => setDeleteError(null)} className="text-red-400 hover:text-red-600 cursor-pointer">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('invoice.searchCustomers')}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-200 focus:border-brand-400 outline-none"
        />
      </div>

      {/* Customer Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800">
                {editingCustomer ? t('invoice.editCustomer') : t('invoice.addCustomer')}
              </h3>
              <button onClick={handleClose} className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {error && (
                <div className="p-3 bg-red-50 text-red-700 text-sm rounded-lg">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('invoice.customerName')} *
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    NIP
                  </label>
                  <input
                    type="text"
                    value={form.nip || ''}
                    onChange={(e) => setForm({ ...form, nip: e.target.value.replace(/[^\d]/g, '').slice(0, 10) })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 pb-2">
                    <input
                      type="checkbox"
                      checked={form.is_company}
                      onChange={(e) => setForm({ ...form, is_company: e.target.checked })}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-300"
                    />
                    <span className="text-sm text-slate-600">{t('invoice.isCompany')}</span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('invoice.street')}
                </label>
                <input
                  type="text"
                  value={form.street || ''}
                  onChange={(e) => setForm({ ...form, street: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('invoice.postalCode')}
                  </label>
                  <input
                    type="text"
                    value={form.postal_code || ''}
                    onChange={(e) => setForm({ ...form, postal_code: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('invoice.city')}
                  </label>
                  <input
                    type="text"
                    value={form.city || ''}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('invoice.email')}
                  </label>
                  <input
                    type="email"
                    value={form.email || ''}
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
                    value={form.phone || ''}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('invoice.paymentTermDays')}
                </label>
                <input
                  type="number"
                  value={form.payment_term_days || 14}
                  onChange={(e) => setForm({ ...form, payment_term_days: parseInt(e.target.value) || 14 })}
                  min="1"
                  max="90"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('invoice.notes')}
                </label>
                <textarea
                  value={form.notes || ''}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none resize-none"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 px-4 py-2.5 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50 cursor-pointer transition-colors"
                >
                  {saving ? t('common.saving') : t('common.save')}
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2.5 border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Customer List */}
      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
        </div>
      ) : customers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-500">
          <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-600 mb-1">{t('invoice.noCustomers')}</p>
          {!search && (
            <button
              onClick={handleCreate}
              className="mt-3 flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {t('invoice.addCustomer')}
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200">
                <th className="py-3 px-2 font-medium text-slate-600">{t('invoice.customerName')}</th>
                <th className="py-3 px-2 font-medium text-slate-600">NIP</th>
                <th className="py-3 px-2 font-medium text-slate-600">{t('invoice.city')}</th>
                <th className="py-3 px-2 font-medium text-slate-600">{t('invoice.type')}</th>
                <th className="py-3 px-2 font-medium text-slate-600"></th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-3 px-2">
                    <div className="font-medium text-slate-800">{customer.name}</div>
                    {customer.email && (
                      <div className="text-xs text-slate-500">{customer.email}</div>
                    )}
                  </td>
                  <td className="py-3 px-2 font-mono text-slate-600">{customer.nip || '-'}</td>
                  <td className="py-3 px-2 text-slate-600">{customer.city || '-'}</td>
                  <td className="py-3 px-2">
                    {customer.is_company === 1 ? (
                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                        {t('invoice.company')}
                      </span>
                    ) : (
                      <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                        {t('invoice.person')}
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleEdit(customer)}
                        className="p-1.5 text-slate-500 hover:text-brand-600 hover:bg-brand-50 rounded"
                        title={t('common.edit')}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(customer.id, customer.name)}
                        className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded"
                        title={t('common.delete')}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <DeleteModal />
    </div>
  );
}
