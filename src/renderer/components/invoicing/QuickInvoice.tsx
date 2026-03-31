import React, { useState, useRef } from 'react';
import {
  InvoiceType,
  InvoicePaymentMethod,
  SellerSettingsRow,
  InvoiceCreateDTO,
  InvoiceItemCreateDTO,
  InvoiceCustomerRow,
} from '../../../shared/types';
import CustomerPicker from './CustomerPicker';
import { useTranslation } from '../../i18n/useTranslation';

interface QuickInvoiceProps {
  sellerSettings: SellerSettingsRow;
  language: string;
}

const INVOICE_TYPES: { value: InvoiceType; labelKey: string }[] = [
  { value: 'RECEIPT', labelKey: 'invoice.type.receipt' },
  { value: 'VAT', labelKey: 'invoice.type.vat' },
  { value: 'PROFORMA', labelKey: 'invoice.type.proforma' },
];

export default function QuickInvoice({ sellerSettings, language }: QuickInvoiceProps) {
  const { t } = useTranslation(language as any);
  const [invoiceType, setInvoiceType] = useState<InvoiceType>('RECEIPT');
  const [customer, setCustomer] = useState<InvoiceCustomerRow | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerNip, setCustomerNip] = useState('');
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [priceNet, setPriceNet] = useState('');
  const [vatRate, setVatRate] = useState(23);
  const [paymentMethod, setPaymentMethod] = useState<InvoicePaymentMethod>('CASH');
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const itemNameRef = useRef<HTMLInputElement>(null);

  const qty = parseFloat(quantity) || 0;
  const netPrice = Math.round((parseFloat(priceNet) || 0) * 100);
  const itemNetTotal = Math.round(netPrice * qty);
  const itemVat = vatRate >= 0 ? Math.round(itemNetTotal * vatRate / 100) : 0;
  const itemGrossTotal = itemNetTotal + itemVat;

  const resetForm = () => {
    setItemName('');
    setQuantity('1');
    setPriceNet('');
    setSuccess(null);
    itemNameRef.current?.focus();
  };

  const handleSubmit = async (printFormat: 'thermal' | 'a4' | 'save') => {
    if (!itemName.trim()) {
      setError(t('invoice.error.itemNameRequired'));
      return;
    }
    if (!priceNet || parseFloat(priceNet) <= 0) {
      setError(t('invoice.error.priceRequired'));
      return;
    }
    if (invoiceType === 'VAT' && !customerNip) {
      setError(t('invoice.error.nipRequired'));
      return;
    }

    setError(null);
    setSaving(true);

    try {
      const today = new Date().toISOString().split('T')[0];
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (sellerSettings.default_payment_term_days || 14));

      const item: InvoiceItemCreateDTO = {
        name: itemName,
        quantity: qty * 1000,
        unit_price_net: netPrice,
        vat_rate: vatRate,
      };

      const data: InvoiceCreateDTO = {
        type: invoiceType,
        customer_id: customer?.id,
        customer_name: customer?.name || customerName || (invoiceType === 'RECEIPT' ? 'Klient detaliczny' : ''),
        customer_nip: customerNip || undefined,
        customer_address: customer
          ? `${customer.street || ''}, ${customer.postal_code || ''} ${customer.city || ''}`.trim()
          : undefined,
        issue_date: today,
        sale_date: today,
        due_date: paymentMethod === 'BANK_TRANSFER' ? dueDate.toISOString().split('T')[0] : undefined,
        payment_method: paymentMethod,
        items: [item],
      };

      const result = await window.electronAPI.invoice.create(data);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to create invoice');
      }

      const createdInvoice = result.data;

      const issueResult = await window.electronAPI.invoice.issue(createdInvoice.id);
      if (!issueResult.success) {
        throw new Error(issueResult.error);
      }

      if (printFormat !== 'save') {
        setPrinting(true);
        try {
          if (printFormat === 'thermal') {
            const printResult = await window.electronAPI.invoice.print(createdInvoice.id);
            if (!printResult.success) throw new Error(printResult.error);
          } else {
            const printResult = await window.electronAPI.invoice.printA4(createdInvoice.id);
            if (!printResult.success) throw new Error(printResult.error);
          }
        } finally {
          setPrinting(false);
        }
      }

      if (paymentMethod === 'CASH') {
        await window.electronAPI.invoice.markPaid(createdInvoice.id);
      }

      setSuccess(`${t('invoice.created')}: ${createdInvoice.invoice_number}`);
      resetForm();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCustomerSelect = (c: InvoiceCustomerRow | null) => {
    setCustomer(c);
    if (c) {
      setCustomerName(c.name);
      setCustomerNip(c.nip || '');
    }
  };

  const inputClass = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-200 focus:border-brand-400 outline-none bg-white transition-colors';

  return (
    <div className="panel p-5">
      {/* Invoice type selector — front and center */}
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl mb-5 w-fit">
        {INVOICE_TYPES.map((type) => (
          <button
            key={type.value}
            onClick={() => setInvoiceType(type.value)}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-all duration-150 cursor-pointer ${
              invoiceType === type.value
                ? 'bg-white text-brand-700 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t(type.labelKey)}
          </button>
        ))}
      </div>

      {/* Feedback messages */}
      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-50 border border-red-100 rounded-lg mb-4">
          <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm text-red-700">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600 cursor-pointer">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2.5 p-3 bg-green-50 border border-green-100 rounded-lg mb-4">
          <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm text-green-700">{success}</span>
        </div>
      )}

      <div className="space-y-4">
        {/* Customer row */}
        <div className={`grid gap-4 ${invoiceType !== 'RECEIPT' ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
              {t('invoice.customer')}
            </label>
            <CustomerPicker value={customer} onChange={handleCustomerSelect} language={language} />
          </div>
          {invoiceType !== 'RECEIPT' && (
            <div>
              <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
                NIP
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={customerNip}
                onChange={(e) => setCustomerNip(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
                placeholder="1234567890"
                className={`${inputClass} font-mono`}
              />
            </div>
          )}
        </div>

        {/* Item details */}
        <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-3">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{t('invoice.item.name')}</p>
          <input
            ref={itemNameRef}
            type="text"
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            placeholder={t('invoice.itemNamePlaceholder') || 'e.g. Haircut, Massage...'}
            className={inputClass}
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">{t('invoice.item.quantity')}</label>
              <input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                min="0.01"
                step="0.01"
                className={`${inputClass} text-right`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">{t('invoice.item.unitPrice')} (PLN)</label>
              <input
                type="number"
                value={priceNet}
                onChange={(e) => setPriceNet(e.target.value)}
                min="0.01"
                step="0.01"
                placeholder="0.00"
                className={`${inputClass} text-right`}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">VAT</label>
              <select
                value={vatRate}
                onChange={(e) => setVatRate(parseInt(e.target.value))}
                className={inputClass}
              >
                <option value={23}>23%</option>
                <option value={8}>8%</option>
                <option value={5}>5%</option>
                <option value={0}>0%</option>
                <option value={-1}>ZW</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">{t('invoice.paymentMethod')}</label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as InvoicePaymentMethod)}
                className={inputClass}
              >
                <option value="CASH">{t('invoice.paymentMethod.cash')}</option>
                <option value="CARD">{t('invoice.paymentMethod.card')}</option>
                <option value="BANK_TRANSFER">{t('invoice.paymentMethod.transfer')}</option>
                <option value="BLIK">BLIK</option>
              </select>
            </div>
          </div>
        </div>

        {/* Summary — prominent total */}
        <div className="bg-brand-50 border border-brand-100 rounded-xl p-4">
          <div className="flex justify-between text-sm text-slate-500 mb-1.5">
            <span>{t('invoice.subtotalNet')}</span>
            <span>{(itemNetTotal / 100).toFixed(2)} PLN</span>
          </div>
          <div className="flex justify-between text-sm text-slate-500 mb-3 pb-3 border-b border-brand-100">
            <span>VAT {vatRate >= 0 ? `${vatRate}%` : 'ZW'}</span>
            <span>{(itemVat / 100).toFixed(2)} PLN</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-semibold text-slate-600">{t('invoice.total')}</span>
            <span className="text-2xl font-bold text-brand-600">
              {(itemGrossTotal / 100).toFixed(2)} PLN
            </span>
          </div>
        </div>

        {/* Actions — clear hierarchy */}
        <div className="flex gap-3 pt-1">
          <button
            onClick={() => handleSubmit('thermal')}
            disabled={saving || printing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white rounded-xl font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-sm"
          >
            {printing ? (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
            )}
            {t('invoice.printThermal')}
          </button>

          <button
            onClick={() => handleSubmit('a4')}
            disabled={saving || printing}
            className="flex items-center justify-center gap-2 px-4 py-3 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-xl font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            A4
          </button>

          <button
            onClick={() => handleSubmit('save')}
            disabled={saving}
            className="flex items-center justify-center gap-2 px-4 py-3 border border-slate-200 bg-white hover:bg-slate-50 text-slate-500 hover:text-slate-700 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            {saving ? (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-slate-400 border-t-transparent"></div>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
            )}
            {t('common.save')}
          </button>
        </div>

        {/* Keyboard hint */}
        <p className="text-xs text-slate-400 text-center">
          <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">Ctrl+N</span>
          {' '}{t('invoice.quickInvoice')}
          {' · '}
          <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">Esc</span>
          {' '}close
        </p>
      </div>
    </div>
  );
}
