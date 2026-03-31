import React, { useState, useEffect, useCallback } from 'react';
import {
  InvoiceRow,
  InvoiceType,
  InvoiceStatus,
  InvoiceListFilter,
  KsefStatus,
} from '../../../shared/types';
import { useTranslation } from '../../i18n/useTranslation';

interface InvoiceListProps {
  onEdit: (id: string) => void;
  onCreate: (type: InvoiceType) => void;
  language: string;
}

type FilterStatus = 'ALL' | InvoiceStatus;
type FilterType = 'ALL' | InvoiceType;

export default function InvoiceList({ onEdit, onCreate, language }: InvoiceListProps) {
  const { t } = useTranslation(language as any);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('ALL');
  const [typeFilter, setTypeFilter] = useState<FilterType>('ALL');
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cancelModal, setCancelModal] = useState<{ invoiceId: string } | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const filter: InvoiceListFilter = {
        search: search || undefined,
        status: statusFilter !== 'ALL' ? statusFilter as InvoiceStatus : undefined,
        type: typeFilter !== 'ALL' ? typeFilter as InvoiceType : undefined,
        limit: 50,
      };
      const result = await window.electronAPI.invoice.list(filter);
      setInvoices(result);
    } catch (err) {
      console.error('Failed to load invoices:', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, typeFilter]);

  useEffect(() => {
    loadInvoices();
  }, [loadInvoices, refreshKey]);

  const handleRefresh = () => setRefreshKey(k => k + 1);

  const handlePrint = async (id: string, format: 'thermal' | 'a4') => {
    try {
      if (format === 'thermal') {
        await window.electronAPI.invoice.print(id);
      } else {
        await window.electronAPI.invoice.printA4(id);
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDuplicate = async (id: string) => {
    try {
      const result = await window.electronAPI.invoice.duplicate(id);
      if (result.success) handleRefresh();
      else setError(result.error || 'Duplicate failed');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleCancel = (id: string) => {
    setCancelReason('');
    setCancelModal({ invoiceId: id });
  };

  const handleCancelConfirm = async () => {
    if (!cancelModal || !cancelReason.trim()) return;
    setCancelling(true);
    try {
      const result = await window.electronAPI.invoice.cancel(cancelModal.invoiceId, cancelReason);
      if (result.success) { handleRefresh(); setCancelModal(null); }
      else setError(result.error || 'Cancel failed');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCancelling(false);
    }
  };

  const handleMarkPaid = async (id: string) => {
    try {
      const result = await window.electronAPI.invoice.markPaid(id);
      if (result.success) handleRefresh();
      else setError(result.error || 'Mark paid failed');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSendToKsef = async (id: string) => {
    try {
      const result = await window.electronAPI.invoice.ksef.send(id);
      if (result.success) handleRefresh();
      else if (result.error) setError(`KSeF: ${result.error}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRetryKsef = async (id: string) => {
    try {
      const result = await window.electronAPI.invoice.ksef.retry(id);
      if (result.success) handleRefresh();
      else if (result.error) setError(`KSeF: ${result.error}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const getStatusBadge = (status: InvoiceStatus) => {
    const styles: Record<InvoiceStatus, string> = {
      DRAFT:          'bg-slate-100 text-slate-600 border border-slate-200',
      ISSUED:         'bg-blue-50 text-blue-700 border border-blue-100',
      SENT:           'bg-purple-50 text-purple-700 border border-purple-100',
      PAID:           'bg-green-50 text-green-700 border border-green-100',
      PARTIALLY_PAID: 'bg-amber-50 text-amber-700 border border-amber-100',
      OVERDUE:        'bg-red-50 text-red-700 border border-red-100',
      CANCELLED:      'bg-slate-100 text-slate-400 border border-slate-200',
    };
    return styles[status] || 'bg-slate-100 text-slate-600';
  };

  const getKsefCell = (invoice: InvoiceRow) => {
    if (invoice.status === 'DRAFT' || invoice.status === 'CANCELLED' || invoice.type === 'PROFORMA') {
      return <span className="text-slate-300">—</span>;
    }
    if (invoice.ksef_number) {
      return (
        <span className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 border border-green-100 px-2 py-0.5 rounded-full" title={invoice.ksef_number}>
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          KSeF
        </span>
      );
    }
    const status = invoice.ksef_status as KsefStatus | null;
    if (status === 'SENDING') {
      return (
        <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-600 border border-blue-100 px-2 py-0.5 rounded-full">
          <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          {t('invoice.ksef.sending')}
        </span>
      );
    }
    if (status === 'ERROR') {
      return (
        <button
          className="inline-flex items-center gap-1 text-xs bg-red-50 text-red-700 border border-red-100 px-2 py-0.5 rounded-full cursor-pointer hover:bg-red-100 transition-colors"
          title={invoice.ksef_error || t('invoice.ksef.error')}
          onClick={() => handleRetryKsef(invoice.id)}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {t('invoice.ksef.retry')}
        </button>
      );
    }
    return (
      <span className="text-xs text-slate-400">{t('invoice.ksef.notSent')}</span>
    );
  };

  const getTypeName = (type: InvoiceType) => {
    const names: Record<InvoiceType, string> = {
      RECEIPT:    t('invoice.type.receipt'),
      VAT:        t('invoice.type.vat'),
      PROFORMA:   t('invoice.type.proforma'),
      CORRECTION: t('invoice.type.correction'),
      ADVANCE:    t('invoice.type.advance'),
    };
    return names[type] || type;
  };

  const formatMoney = (grosze: number) =>
    (grosze / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const selectClass = 'px-3 py-2 border border-slate-200 bg-white rounded-lg text-sm focus:ring-2 focus:ring-brand-200 focus:border-brand-400 outline-none transition-colors';

  return (
    <div className="panel p-5">
      {/* Cancel modal */}
      {cancelModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
            <h3 className="text-base font-semibold text-slate-800 mb-1">{t('invoice.cancel')}</h3>
            <p className="text-sm text-slate-500 mb-4">{t('invoice.cancelReason')}</p>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              autoFocus
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-200 focus:border-brand-400 outline-none resize-none mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={handleCancelConfirm}
                disabled={cancelling || !cancelReason.trim()}
                className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer transition-colors"
              >
                {cancelling ? t('common.saving') : t('invoice.cancel')}
              </button>
              <button
                onClick={() => setCancelModal(null)}
                className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-lg text-sm hover:bg-slate-50 cursor-pointer transition-colors"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-50 border border-red-100 rounded-lg mb-4">
          <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-red-700 flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 cursor-pointer">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-slate-800">{t('invoice.invoiceList')}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            title={t('common.refresh')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={() => onCreate('VAT')}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {t('invoice.newInvoice')}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('invoice.searchPlaceholder')}
            className="w-full pl-9 pr-3 py-2 border border-slate-200 bg-white rounded-lg text-sm focus:ring-2 focus:ring-brand-200 focus:border-brand-400 outline-none transition-colors"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FilterStatus)}
          className={selectClass}
        >
          <option value="ALL">{t('invoice.filter.allStatuses')}</option>
          <option value="DRAFT">{t('invoice.status.draft')}</option>
          <option value="ISSUED">{t('invoice.status.issued')}</option>
          <option value="PAID">{t('invoice.status.paid')}</option>
          <option value="CANCELLED">{t('invoice.status.cancelled')}</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as FilterType)}
          className={selectClass}
        >
          <option value="ALL">{t('invoice.filter.allTypes')}</option>
          <option value="RECEIPT">{t('invoice.type.receipt')}</option>
          <option value="VAT">{t('invoice.type.vat')}</option>
          <option value="PROFORMA">{t('invoice.type.proforma')}</option>
          <option value="CORRECTION">{t('invoice.type.correction')}</option>
        </select>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-brand-600"></div>
        </div>
      ) : invoices.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center h-48 text-center">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-3">
            <svg className="w-7 h-7 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-600">{t('invoice.noInvoices')}</p>
          <p className="text-xs text-slate-400 mt-1">
            {search || statusFilter !== 'ALL' || typeFilter !== 'ALL'
              ? t('invoice.noResults')
              : t('invoice.quickInvoice')}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="py-2.5 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wide">{t('invoice.number')}</th>
                <th className="py-2.5 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wide">{t('invoice.date')}</th>
                <th className="py-2.5 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wide">{t('invoice.customer')}</th>
                <th className="py-2.5 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wide">{t('invoice.type')}</th>
                <th className="py-2.5 px-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wide">{t('invoice.total')}</th>
                <th className="py-2.5 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wide">{t('invoice.status')}</th>
                <th className="py-2.5 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wide">KSeF</th>
                <th className="py-2.5 px-3 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b border-slate-50 hover:bg-slate-50 group transition-colors">
                  <td className="py-3 px-3">
                    <span className="font-mono text-sm font-medium text-slate-800">{invoice.invoice_number}</span>
                  </td>
                  <td className="py-3 px-3 text-slate-500 text-sm">{invoice.issue_date}</td>
                  <td className="py-3 px-3">
                    <div className="text-sm text-slate-800">{invoice.customer_name}</div>
                    {invoice.customer_nip && (
                      <div className="text-xs text-slate-400 font-mono">NIP: {invoice.customer_nip}</div>
                    )}
                  </td>
                  <td className="py-3 px-3">
                    <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md font-medium">
                      {getTypeName(invoice.type as InvoiceType)}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-right font-semibold text-slate-800 tabular-nums">
                    {formatMoney(invoice.total_gross)}&nbsp;PLN
                  </td>
                  <td className="py-3 px-3">
                    <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${getStatusBadge(invoice.status as InvoiceStatus)}`}>
                      {t(`invoice.status.${invoice.status.toLowerCase()}`)}
                    </span>
                  </td>
                  <td className="py-3 px-3">{getKsefCell(invoice)}</td>
                  <td className="py-3 px-3">
                    {/* Row actions — always visible (touchscreen-friendly) */}
                    <div className="flex items-center gap-0.5">
                      {invoice.status === 'DRAFT' && (
                        <button
                          onClick={() => onEdit(invoice.id)}
                          title={t('common.edit')}
                          className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => handlePrint(invoice.id, 'thermal')}
                        title={t('invoice.printThermal')}
                        className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDuplicate(invoice.id)}
                        title={t('invoice.duplicate')}
                        className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      {['ISSUED', 'PARTIALLY_PAID'].includes(invoice.status) && (
                        <button
                          onClick={() => handleMarkPaid(invoice.id)}
                          title={t('invoice.markPaid')}
                          className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors cursor-pointer"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </button>
                      )}
                      {invoice.status !== 'CANCELLED' && invoice.status !== 'PAID' && (
                        <button
                          onClick={() => handleCancel(invoice.id)}
                          title={t('invoice.cancel')}
                          className="p-2 min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
