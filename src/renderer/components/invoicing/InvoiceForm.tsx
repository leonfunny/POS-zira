import React, { useState, useEffect } from 'react';
import {
  InvoiceRow,
  InvoiceItemRow,
  InvoiceType,
  InvoicePaymentMethod,
  SellerSettingsRow,
  InvoiceCreateDTO,
  InvoiceItemCreateDTO,
  InvoiceCustomerRow,
  VatSummaryEntry,
} from '../../../shared/types';
import CustomerPicker from './CustomerPicker';
import { useTranslation } from '../../i18n/useTranslation';

interface InvoiceFormProps {
  mode: 'create' | 'edit';
  invoiceId: string | null;
  invoiceType: InvoiceType;
  sellerSettings: SellerSettingsRow;
  onSaved: () => void;
  onCancel: () => void;
  language: string;
}

interface InvoiceItem extends InvoiceItemCreateDTO {
  id?: string;
}

export default function InvoiceForm({
  mode,
  invoiceId,
  invoiceType,
  sellerSettings,
  onSaved,
  onCancel,
  language,
}: InvoiceFormProps) {
  const { t } = useTranslation(language as any);
  const [loading, setLoading] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [type, setType] = useState<InvoiceType>(invoiceType);
  const [customer, setCustomer] = useState<InvoiceCustomerRow | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerNip, setCustomerNip] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0]);
  const [saleDate, setSaleDate] = useState(new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<InvoicePaymentMethod>('CASH');
  const [items, setItems] = useState<InvoiceItem[]>([
    { name: '', quantity: 1000, unit_price_net: 0, vat_rate: 23, unit: 'szt.' },
  ]);
  const [notes, setNotes] = useState('');

  // Load existing invoice for edit mode
  useEffect(() => {
    if (mode === 'edit' && invoiceId) {
      loadInvoice();
    }
  }, [mode, invoiceId]);

  // Set default due date when payment method changes
  useEffect(() => {
    if (paymentMethod === 'BANK_TRANSFER' && !dueDate) {
      const due = new Date();
      due.setDate(due.getDate() + (sellerSettings.default_payment_term_days || 14));
      setDueDate(due.toISOString().split('T')[0]);
    }
  }, [paymentMethod, sellerSettings.default_payment_term_days]);

  const loadInvoice = async () => {
    try {
      const result = await window.electronAPI.invoice.get(invoiceId!);
      if (!result.success || !result.data?.invoice) {
        throw new Error(result.error || 'Invoice not found');
      }
      const { invoice, items: loadedItems } = result.data;

      setType(invoice.type as InvoiceType);
      setCustomerName(invoice.customer_name);
      setCustomerNip(invoice.customer_nip || '');
      setCustomerAddress(invoice.customer_address || '');
      setIssueDate(invoice.issue_date);
      setSaleDate(invoice.sale_date);
      setDueDate(invoice.due_date || '');
      setPaymentMethod(invoice.payment_method as InvoicePaymentMethod);
      setNotes(invoice.notes || '');
      if (loadedItems) {
        setItems(loadedItems.map((item: InvoiceItemRow) => ({
          id: item.id,
          accounting_product_id: item.accounting_product_id || undefined,
          name: item.name,
          sku: item.sku || undefined,
          unit: item.unit,
          pkwiu_code: item.pkwiu_code || undefined,
          gtu_code: item.gtu_code || undefined,
          quantity: item.quantity,
          unit_price_net: item.unit_price_net,
          vat_rate: item.vat_rate,
          discount_percent: item.discount_percent || 0,
        })));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCustomerSelect = (c: InvoiceCustomerRow | null) => {
    setCustomer(c);
    if (c) {
      setCustomerName(c.name);
      setCustomerNip(c.nip || '');
      setCustomerAddress(`${c.street || ''}, ${c.postal_code || ''} ${c.city || ''}`.trim());
    }
  };

  const handleItemChange = (index: number, field: keyof InvoiceItem, value: any) => {
    const newItems = [...items];
    (newItems[index] as any)[field] = value;
    setItems(newItems);
  };

  const handleAddItem = () => {
    setItems([...items, { name: '', quantity: 1000, unit_price_net: 0, vat_rate: 23, unit: 'szt.' }]);
  };

  const handleRemoveItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index));
    }
  };

  const calculateItemTotals = (item: InvoiceItem) => {
    const qty = item.quantity / 1000;
    const net = Math.round(item.unit_price_net * qty);
    const discount = Math.round(net * (item.discount_percent || 0) / 10000);
    const netAfterDiscount = net - discount;
    const vat = item.vat_rate >= 0 ? Math.round(netAfterDiscount * item.vat_rate / 100) : 0;
    const gross = netAfterDiscount + vat;
    return { net: netAfterDiscount, vat, gross };
  };

  const calculateTotals = () => {
    let totalNet = 0;
    let totalVat = 0;
    let totalGross = 0;

    for (const item of items) {
      const totals = calculateItemTotals(item);
      totalNet += totals.net;
      totalVat += totals.vat;
      totalGross += totals.gross;
    }

    return { totalNet, totalVat, totalGross };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate
    if (!customerName.trim()) {
      setError(t('invoice.error.customerNameRequired'));
      return;
    }
    if (type !== 'RECEIPT' && !customerNip) {
      setError(t('invoice.error.nipRequired'));
      return;
    }
    if (items.length === 0 || !items.some(i => i.name.trim())) {
      setError(t('invoice.error.itemsRequired'));
      return;
    }

    setSaving(true);
    try {
      const data: InvoiceCreateDTO = {
        type,
        customer_id: customer?.id,
        customer_name: customerName,
        customer_nip: customerNip || undefined,
        customer_address: customerAddress || undefined,
        issue_date: issueDate,
        sale_date: saleDate,
        due_date: dueDate || undefined,
        payment_method: paymentMethod,
        notes: notes || undefined,
        items: items.filter(i => i.name.trim()).map(i => ({
          name: i.name,
          sku: i.sku,
          unit: i.unit || 'szt.',
          quantity: i.quantity,
          unit_price_net: i.unit_price_net,
          vat_rate: i.vat_rate,
          discount_percent: i.discount_percent || 0,
        })),
      };

      if (mode === 'create') {
        const result = await window.electronAPI.invoice.create(data);
        if (!result.success) throw new Error(result.error);
      } else {
        const result = await window.electronAPI.invoice.update(invoiceId!, data);
        if (!result.success) throw new Error(result.error);
      }

      onSaved();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const formatMoney = (grosze: number) => {
    return (grosze / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const totals = calculateTotals();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
      </div>
    );
  }

  return (
    <div className="panel p-4">
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">
            {mode === 'create' ? t('invoice.newInvoice') : t('invoice.editInvoice')}
          </h2>
          {mode === 'create' ? (
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
              {(['RECEIPT', 'VAT', 'PROFORMA'] as InvoiceType[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setType(v)}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all duration-150 cursor-pointer ${
                    type === v ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {t(`invoice.type.${v.toLowerCase()}` as any)}
                </button>
              ))}
            </div>
          ) : (
            <span className="px-3 py-1.5 text-sm font-medium bg-slate-100 text-slate-600 rounded-lg">
              {t(`invoice.type.${type.toLowerCase()}` as any)}
            </span>
          )}
        </div>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 text-sm rounded-lg">
            {error}
          </div>
        )}

        {/* Customer */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('invoice.customer')} *
            </label>
            <CustomerPicker value={customer} onChange={handleCustomerSelect} language={language} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              NIP {type !== 'RECEIPT' && '*'}
            </label>
            <input
              type="text"
              value={customerNip}
              onChange={(e) => setCustomerNip(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
            />
          </div>
        </div>

        {/* Dates & Payment */}
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('invoice.issueDate')} *
            </label>
            <input
              type="date"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('invoice.saleDate')} *
            </label>
            <input
              type="date"
              value={saleDate}
              onChange={(e) => setSaleDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('invoice.dueDate')}
            </label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('invoice.paymentMethod')}
            </label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as InvoicePaymentMethod)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
            >
              <option value="CASH">{t('invoice.paymentMethod.cash')}</option>
              <option value="CARD">{t('invoice.paymentMethod.card')}</option>
              <option value="BANK_TRANSFER">{t('invoice.paymentMethod.transfer')}</option>
              <option value="BLIK">BLIK</option>
            </select>
          </div>
        </div>

        {/* Items */}
        <div>
          <label className="block text-sm font-medium text-slate-600 mb-2">
            {t('invoice.items')}
          </label>
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="py-2 px-3 text-left font-medium text-slate-600">{t('invoice.item.name')}</th>
                  <th className="py-2 px-3 text-right font-medium text-slate-600 w-20">{t('invoice.item.quantity')}</th>
                  <th className="py-2 px-3 text-right font-medium text-slate-600 w-28">{t('invoice.item.unitPrice')}</th>
                  <th className="py-2 px-3 text-right font-medium text-slate-600 w-20">VAT</th>
                  <th className="py-2 px-3 text-right font-medium text-slate-600 w-28">{t('invoice.total')}</th>
                  <th className="py-2 px-3 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const itemTotals = calculateItemTotals(item);
                  return (
                    <tr key={index} className="border-t border-slate-100">
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={item.name}
                          onChange={(e) => handleItemChange(index, 'name', e.target.value)}
                          placeholder={t('invoice.itemNamePlaceholder')}
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm focus:ring-1 focus:ring-brand-300 outline-none"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="number"
                          value={(item.quantity / 1000).toString()}
                          onChange={(e) => handleItemChange(index, 'quantity', Math.round(parseFloat(e.target.value || '0') * 1000))}
                          min="0.001"
                          step="0.001"
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right focus:ring-1 focus:ring-brand-300 outline-none"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="number"
                          value={(item.unit_price_net / 100).toString()}
                          onChange={(e) => handleItemChange(index, 'unit_price_net', Math.round(parseFloat(e.target.value || '0') * 100))}
                          min="0"
                          step="0.01"
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right focus:ring-1 focus:ring-brand-300 outline-none"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <select
                          value={item.vat_rate}
                          onChange={(e) => handleItemChange(index, 'vat_rate', parseInt(e.target.value))}
                          className="w-full px-2 py-1 border border-slate-200 rounded text-sm focus:ring-1 focus:ring-brand-300 outline-none"
                        >
                          <option value={23}>23%</option>
                          <option value={8}>8%</option>
                          <option value={5}>5%</option>
                          <option value={0}>0%</option>
                          <option value={-1}>ZW</option>
                        </select>
                      </td>
                      <td className="py-2 px-3 text-right font-medium">
                        {formatMoney(itemTotals.gross)}
                      </td>
                      <td className="py-2 px-3">
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(index)}
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer disabled:cursor-not-allowed"
                          disabled={items.length <= 1}
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-3 py-2 bg-slate-50 border-t border-slate-200">
              <button
                type="button"
                onClick={handleAddItem}
                className="flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                {t('invoice.addItem')}
              </button>
            </div>
          </div>
        </div>

        {/* Totals */}
        <div className="flex justify-end">
          <div className="w-64 space-y-2 p-4 bg-brand-50 border border-brand-100 rounded-xl">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">{t('invoice.subtotalNet')}:</span>
              <span className="text-slate-700">{formatMoney(totals.totalNet)} PLN</span>
            </div>
            <div className="flex justify-between text-sm pb-2 border-b border-brand-100">
              <span className="text-slate-500">VAT:</span>
              <span className="text-slate-700">{formatMoney(totals.totalVat)} PLN</span>
            </div>
            <div className="flex justify-between items-center pt-1">
              <span className="text-sm font-semibold text-slate-600">{t('invoice.total')}:</span>
              <span className="text-xl font-bold text-brand-600">{formatMoney(totals.totalGross)} PLN</span>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium text-slate-600 mb-1">
            {t('invoice.notes')}
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none resize-none"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-4 border-t border-slate-200">
          <button
            type="submit"
            disabled={saving}
            className="flex-1 px-4 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-3 border border-slate-300 text-slate-600 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}
