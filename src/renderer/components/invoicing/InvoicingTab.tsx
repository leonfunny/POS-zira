import React, { useState, useEffect, useCallback } from 'react';
import {
  InvoiceRow,
  InvoiceType,
  InvoiceStatus,
  InvoiceListFilter,
  SellerSettingsRow,
  VatSummaryEntry,
} from '../../../shared/types';
import InvoiceList from './InvoiceList';
import InvoiceForm from './InvoiceForm';
import QuickInvoice from './QuickInvoice';
import SellerSettings from './SellerSettings';
import CustomerManagement from './CustomerManagement';
import { useTranslation } from '../../i18n/useTranslation';

type SubTab = 'quick' | 'list' | 'customers' | 'settings';

interface InvoicingTabProps {
  language: string;
}

const SUB_TABS: { id: SubTab; labelKey: string; icon: React.ReactNode }[] = [
  {
    id: 'quick',
    labelKey: 'invoice.quickInvoice',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    id: 'list',
    labelKey: 'invoice.invoiceList',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: 'customers',
    labelKey: 'invoice.customers',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: 'settings',
    labelKey: 'invoice.sellerSettings',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export default function InvoicingTab({ language }: InvoicingTabProps) {
  const { t } = useTranslation(language as any);
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('quick');
  const [sellerSettings, setSellerSettings] = useState<SellerSettingsRow | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [formType, setFormType] = useState<InvoiceType>('RECEIPT');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSellerSettings();
  }, []);

  const loadSellerSettings = async () => {
    try {
      const result = await window.electronAPI.invoice.seller.get();
      if (result.success) {
        setSellerSettings(result.data);
      }
      setLoading(false);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleCreateInvoice = (type: InvoiceType) => {
    setFormType(type);
    setFormMode('create');
    setSelectedInvoice(null);
    setShowForm(true);
  };

  const handleEditInvoice = (id: string) => {
    setSelectedInvoice(id);
    setFormMode('edit');
    setShowForm(true);
  };

  const handleCloseForm = () => {
    setShowForm(false);
    setSelectedInvoice(null);
  };

  const handleSaved = () => {
    setShowForm(false);
    setSelectedInvoice(null);
  };

  const handleSellerSettingsSaved = (settings: SellerSettingsRow) => {
    setSellerSettings(settings);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        handleCreateInvoice('RECEIPT');
      }
      if (e.key === 'Escape' && showForm) {
        e.preventDefault();
        handleCloseForm();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showForm]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
      </div>
    );
  }

  if (!sellerSettings) {
    return (
      <div className="space-y-4">
        <div className="panel p-4">
          <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl mb-4">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
              <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-amber-800">{t('invoice.setupRequired')}</h3>
              <p className="text-sm text-amber-700 mt-0.5">{t('invoice.setupRequiredDesc')}</p>
            </div>
          </div>
          <SellerSettings onSaved={handleSellerSettingsSaved} language={language} />
        </div>
      </div>
    );
  }

  if (showForm) {
    return (
      <div className="space-y-3">
        <button
          onClick={handleCloseForm}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          {t('common.back')}
        </button>
        <InvoiceForm
          mode={formMode}
          invoiceId={selectedInvoice}
          invoiceType={formType}
          sellerSettings={sellerSettings}
          onSaved={handleSaved}
          onCancel={handleCloseForm}
          language={language}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Sub-tab navigation */}
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl w-fit">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150 cursor-pointer ${
              activeSubTab === tab.id
                ? 'bg-white text-brand-700 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.icon}
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {activeSubTab === 'quick' && (
        <QuickInvoice sellerSettings={sellerSettings} language={language} />
      )}
      {activeSubTab === 'list' && (
        <InvoiceList onEdit={handleEditInvoice} onCreate={handleCreateInvoice} language={language} />
      )}
      {activeSubTab === 'customers' && (
        <CustomerManagement language={language} />
      )}
      {activeSubTab === 'settings' && (
        <SellerSettings
          initialSettings={sellerSettings}
          onSaved={handleSellerSettingsSaved}
          language={language}
        />
      )}
    </div>
  );
}
