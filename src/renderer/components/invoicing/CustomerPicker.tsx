import React, { useState, useRef, useEffect } from 'react';
import { InvoiceCustomerRow, InvoiceCustomerCreateDTO, CompanyLookupResult } from '../../../shared/types';
import { useTranslation } from '../../i18n/useTranslation';

interface CustomerPickerProps {
  value: InvoiceCustomerRow | null;
  onChange: (customer: InvoiceCustomerRow | null) => void;
  language: string;
}

export default function CustomerPicker({ value, onChange, language }: CustomerPickerProps) {
  const { t } = useTranslation(language as any);
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState<InvoiceCustomerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newCustomer, setNewCustomer] = useState<InvoiceCustomerCreateDTO>({
    name: '',
    is_company: false,
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NIP Lookup state
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<CompanyLookupResult | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setShowCreate(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Search customers
  useEffect(() => {
    const searchCustomers = async () => {
      if (search.trim().length < 2) {
        // Load recent customers
        const result = await window.electronAPI.invoice.customer.list();
        setResults(result.slice(0, 5));
        return;
      }

      setLoading(true);
      try {
        const result = await window.electronAPI.invoice.customer.search(search);
        setResults(result);
      } catch (err) {
        console.error('Customer search error:', err);
      } finally {
        setLoading(false);
      }
    };

    const timer = setTimeout(searchCustomers, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const handleSelect = (customer: InvoiceCustomerRow) => {
    onChange(customer);
    setSearch(customer.name);
    setIsOpen(false);
  };

  const handleClear = () => {
    onChange(null);
    setSearch('');
    inputRef.current?.focus();
  };

  // NIP/VAT Lookup
  const handleLookupNip = async () => {
    const nip = newCustomer.nip?.trim();
    if (!nip || nip.length < 8) {
      setError(t('invoice.nip.lookupMinLength'));
      return;
    }

    setLookupLoading(true);
    setError(null);
    setLookupResult(null);

    try {
      const result = await window.electronAPI.invoice.lookup.auto(nip);
      if (result.success && result.data) {
        const data = result.data as CompanyLookupResult;
        setLookupResult(data);

        if (data.valid) {
          // Auto-fill form with lookup data
          setNewCustomer(prev => ({
            ...prev,
            name: data.name || prev.name,
            nip: data.nip || data.vatId?.replace(/^[A-Z]{2}/, '') || prev.nip,
            regon: data.regon || prev.regon,
            street: data.street || prev.street,
            city: data.city || prev.city,
            postal_code: data.postalCode || prev.postal_code,
            country: data.countryCode || prev.country || 'PL',
            is_company: true,
          }));
        } else {
          setError(data.error || t('invoice.nip.notFound'));
        }
      } else {
        setError(result.error || t('invoice.nip.searchError'));
      }
    } catch (err: any) {
      setError(err.message || t('invoice.nip.connectionError'));
    } finally {
      setLookupLoading(false);
    }
  };

  const handleCreateNew = async () => {
    if (!newCustomer.name.trim()) {
      setError(t('invoice.error.customerNameRequired'));
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const result = await window.electronAPI.invoice.customer.create(newCustomer);
      if (result.success && result.data) {
        onChange(result.data);
        setSearch(result.data.name);
        setShowCreate(false);
        setIsOpen(false);
        setNewCustomer({ name: '', is_company: false });
        setLookupResult(null);
      } else {
        setError(result.error || 'Unknown error');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={t('invoice.customerPlaceholder')}
          className="w-full px-3 py-2 pr-8 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
        />
        {value && (
          <button
            onClick={handleClear}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Dropdown */}
      {isOpen && !showCreate && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-auto">
          {loading ? (
            <div className="p-3 text-center text-sm text-slate-500">
              <div className="animate-spin inline-block w-4 h-4 border-2 border-slate-300 border-t-brand-600 rounded-full"></div>
            </div>
          ) : results.length === 0 ? (
            <div className="p-3 text-center text-sm text-slate-500">
              {t('invoice.noCustomersFound')}
            </div>
          ) : (
            <ul>
              {results.map((customer) => (
                <li key={customer.id}>
                  <button
                    onClick={() => handleSelect(customer)}
                    className="w-full px-3 py-2 text-left hover:bg-slate-50 flex items-center justify-between"
                  >
                    <div>
                      <div className="text-sm font-medium text-slate-800">{customer.name}</div>
                      {customer.nip && (
                        <div className="text-xs text-slate-500">NIP: {customer.nip}</div>
                      )}
                    </div>
                    {customer.is_company ? (
                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                        {t('invoice.company')}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add new customer button */}
          <div className="border-t border-slate-100">
            <button
              onClick={() => {
                setNewCustomer({ name: search, is_company: false });
                setShowCreate(true);
                setLookupResult(null);
              }}
              className="w-full px-3 py-2 text-sm text-brand-600 hover:bg-brand-50 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {t('invoice.addNewCustomer')}
            </button>
          </div>
        </div>
      )}

      {/* Create new customer form */}
      {showCreate && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg p-4 max-h-[80vh] overflow-auto">
          <h4 className="font-medium text-slate-800 mb-3">{t('invoice.newCustomer')}</h4>

          {error && (
            <div className="mb-3 p-2 bg-red-50 text-red-700 text-sm rounded">
              {error}
            </div>
          )}

          {lookupResult?.valid && (
            <div className="mb-3 p-2 bg-green-50 text-green-700 text-sm rounded flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>
                {lookupResult.isActiveVat ? t('invoice.nip.activeVat') : t('invoice.nip.entityFound')}
                {lookupResult.countryCode && lookupResult.countryCode !== 'PL' && ` (${lookupResult.country})`}
              </span>
            </div>
          )}

          <div className="space-y-3">
            {/* NIP with lookup button */}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                NIP / VAT EU
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCustomer.nip || ''}
                  onChange={(e) => {
                    const val = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                    setNewCustomer({ ...newCustomer, nip: val });
                    setLookupResult(null);
                  }}
                  placeholder="1234567890 lub DE123456789"
                  className="flex-1 px-2 py-1.5 border border-slate-300 rounded text-sm font-mono focus:ring-1 focus:ring-brand-300 outline-none"
                />
                <button
                  onClick={handleLookupNip}
                  disabled={lookupLoading || !newCustomer.nip || newCustomer.nip.length < 8}
                  className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  title="Wyszukaj w GUS/VIES"
                >
                  {lookupLoading ? (
                    <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></div>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  )}
                  GUS
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {t('invoice.nip.helpText')}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                {t('invoice.customerName')} *
              </label>
              <input
                type="text"
                value={newCustomer.name}
                onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-brand-300 outline-none"
              />
            </div>

            {/* Address fields (shown if we have lookup result or manually expanded) */}
            {(lookupResult?.valid || newCustomer.street) && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    {t('invoice.street')}
                  </label>
                  <input
                    type="text"
                    value={newCustomer.street || ''}
                    onChange={(e) => setNewCustomer({ ...newCustomer, street: e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-brand-300 outline-none"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      {t('invoice.postalCode')}
                    </label>
                    <input
                      type="text"
                      value={newCustomer.postal_code || ''}
                      onChange={(e) => setNewCustomer({ ...newCustomer, postal_code: e.target.value })}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-brand-300 outline-none"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      {t('invoice.city')}
                    </label>
                    <input
                      type="text"
                      value={newCustomer.city || ''}
                      onChange={(e) => setNewCustomer({ ...newCustomer, city: e.target.value })}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-1 focus:ring-brand-300 outline-none"
                    />
                  </div>
                </div>

                {lookupResult?.regon && (
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      REGON
                    </label>
                    <input
                      type="text"
                      value={newCustomer.regon || ''}
                      onChange={(e) => setNewCustomer({ ...newCustomer, regon: e.target.value })}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm font-mono focus:ring-1 focus:ring-brand-300 outline-none"
                      readOnly
                    />
                  </div>
                )}
              </>
            )}

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={newCustomer.is_company}
                onChange={(e) => setNewCustomer({ ...newCustomer, is_company: e.target.checked })}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-300"
              />
              <span className="text-sm text-slate-600">{t('invoice.isCompany')}</span>
            </label>
          </div>

          <div className="flex gap-2 mt-4">
            <button
              onClick={handleCreateNew}
              disabled={creating}
              className="flex-1 px-3 py-1.5 bg-brand-600 text-white text-sm rounded font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {creating ? t('common.saving') : t('common.add')}
            </button>
            <button
              onClick={() => {
                setShowCreate(false);
                setLookupResult(null);
                setError(null);
              }}
              className="px-3 py-1.5 border border-slate-300 text-slate-600 text-sm rounded hover:bg-slate-50"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
