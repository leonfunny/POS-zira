import React, { useState, useMemo, useCallback } from 'react';
import type { ServiceItem, CategoryItem } from '../../hooks/useCheckinWizard';
import TouchKeyboard from './TouchKeyboard';

interface Props {
  t: (key: string) => string;
  services: ServiceItem[];
  categories: CategoryItem[];
  onBack: () => void;
  onChooseServices: () => void;
}

function formatPrice(grosze: number): string {
  return (grosze / 100).toFixed(2);
}

export default function PriceListScreen({ t, services, categories, onBack, onChooseServices }: Props) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  const filteredServices = useMemo(() => {
    let list = services;
    if (selectedCategory) {
      list = list.filter((s) => s.category_id === selectedCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q));
    }
    return list;
  }, [services, selectedCategory, search]);

  // Group services by category for display
  const grouped = useMemo(() => {
    if (selectedCategory) return null;
    const map = new Map<string, { name: string; services: ServiceItem[] }>();
    const uncategorized: ServiceItem[] = [];
    for (const svc of filteredServices) {
      if (!svc.category_id) {
        uncategorized.push(svc);
        continue;
      }
      if (!map.has(svc.category_id)) {
        const cat = categories.find((c) => c.id === svc.category_id);
        map.set(svc.category_id, { name: cat?.name || svc.category_id, services: [] });
      }
      map.get(svc.category_id)!.services.push(svc);
    }
    if (uncategorized.length > 0) {
      map.set('__other', { name: t('priceList.other'), services: uncategorized });
    }
    return Array.from(map.values());
  }, [filteredServices, categories, selectedCategory, t]);

  const handleKey = useCallback((key: string) => {
    setSearch((prev) => prev + key);
  }, []);

  const handleBackspace = useCallback(() => {
    setSearch((prev) => prev.slice(0, -1));
  }, []);

  const handleDone = useCallback(() => {
    setKeyboardVisible(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  // Dismiss keyboard when tapping outside inputs/buttons
  const handleContainerTap = useCallback((e: React.PointerEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SVG' || tag === 'PATH') return;
    if ((e.target as HTMLElement).closest('button')) return;
    if (keyboardVisible) handleDone();
  }, [keyboardVisible, handleDone]);

  return (
    <div className="h-full flex flex-col relative overflow-hidden" onPointerDown={handleContainerTap}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center space-x-3">
          <button onClick={onBack} className="flex min-h-12 min-w-12 items-center justify-center hover:bg-stone-100 rounded-lg transition-colors cursor-pointer">
            <svg className="w-5 h-5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <div>
            <h2 className="text-xl font-bold text-stone-800">{t('priceList.title')}</h2>
            <p className="text-xs text-stone-400">{t('priceList.subtitle')}</p>
          </div>
        </div>
      </div>

      {/* Category tabs (hero) + search (secondary) */}
      <div className="flex items-center space-x-3 mb-5 shrink-0">
        <div className="flex space-x-2 overflow-x-auto flex-1">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-4 py-2.5 text-sm font-semibold rounded-xl whitespace-nowrap transition-all cursor-pointer ${
              !selectedCategory
                ? 'bg-brand-600 text-white shadow-sm'
                : 'bg-stone-100 text-stone-600 hover:bg-stone-200 border border-stone-200'
            }`}
          >
            {t('wizard.allCategories')}
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-4 py-2.5 text-sm font-semibold rounded-xl whitespace-nowrap transition-all cursor-pointer ${
                selectedCategory === cat.id
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200 border border-stone-200'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
        {/* Search — compact, opens keyboard on focus */}
        <div className="relative shrink-0 w-36">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="text"
            value={search}
            readOnly
            onPointerDown={() => setKeyboardVisible(true)}
            placeholder={t('priceList.search')}
            className={`w-full pl-8 pr-3 py-2 text-xs border rounded-xl bg-white cursor-pointer ${
              keyboardVisible
                ? 'border-brand-400 ring-2 ring-brand-300'
                : 'border-stone-200'
            }`}
          />
        </div>
      </div>

      {/* Service list — 2 columns for readability */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-4">
        {services.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full space-y-3 opacity-50">
            <svg className="w-12 h-12 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
            </svg>
            <p className="text-sm text-stone-400">{t('priceList.noServices')}</p>
          </div>
        ) : selectedCategory || search.trim() ? (
          <div className="grid grid-cols-2 gap-3">
            {filteredServices.map((svc) => (
              <ServiceCard key={svc.id} svc={svc} />
            ))}
            {filteredServices.length === 0 && (
              <div className="col-span-full text-center py-12 text-sm text-stone-400">
                {t('priceList.noResults')}
              </div>
            )}
          </div>
        ) : (
          grouped?.map((group, idx) => (
            <div key={group.name} className={idx > 0 ? 'mt-8' : ''}>
              <div className="flex items-center space-x-2 mb-4 px-1">
                <h3 className="text-sm font-bold text-stone-700 uppercase tracking-wider">
                  {group.name}
                </h3>
                <div className="flex-1 h-px bg-stone-200" />
                <span className="text-xs text-stone-400">{group.services.length}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {group.services.map((svc) => (
                  <ServiceCard key={svc.id} svc={svc} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Bottom CTA */}
      <div className="shrink-0 pt-3 border-t border-stone-100">
        <button
          onClick={onChooseServices}
          className="w-full py-3.5 bg-brand-600 text-white text-sm font-bold rounded-xl hover:bg-brand-700 transition-colors cursor-pointer shadow-sm flex items-center justify-center space-x-2"
        >
          {t('priceList.readyToBook')}
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
          </svg>
        </button>
      </div>

      {/* Touch keyboard */}
      <TouchKeyboard
        visible={keyboardVisible}
        mode="alpha"
        onKey={handleKey}
        onBackspace={handleBackspace}
        onDone={handleDone}
      />
    </div>
  );
}

function ServiceCard({ svc }: { svc: ServiceItem }) {
  return (
    <div className="flex items-center space-x-3 px-4 py-3.5 bg-white rounded-2xl border border-stone-200">
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-stone-800">{svc.name}</div>
      </div>
      <div className="shrink-0 text-[15px] font-bold text-brand-600">
        {formatPrice(svc.retail_price)} zł
      </div>
    </div>
  );
}
