import React, { useState, useMemo } from 'react';
import type { ServiceItem, StaffItem, CategoryItem, SelectedService, ServiceRecommendation, SalonCustomerData } from '../../hooks/useCheckinWizard';

interface Props {
  t: (key: string) => string;
  services: ServiceItem[];
  categories: CategoryItem[];
  staffList: StaffItem[];
  selectedServices: SelectedService[];
  selectedStaff: StaffItem | null;
  recommendations: ServiceRecommendation[];
  bestsellers: ServiceRecommendation[];
  customer: SalonCustomerData | null;
  onAddService: (svc: SelectedService) => void;
  onRemoveService: (id: string) => void;
  onSelectStaff: (staff: StaffItem | null) => void;
  onConfirm: () => void;
  onBack: () => void;
}

function formatPrice(grosze: number): string {
  return (grosze / 100).toFixed(2);
}

export default function ServiceSelectionScreen({
  t, services, categories, staffList, selectedServices, selectedStaff,
  recommendations, bestsellers, customer, onAddService, onRemoveService,
  onSelectStaff, onConfirm, onBack,
}: Props) {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const recSet = useMemo(() => {
    const names = new Set<string>();
    recommendations.forEach((r) => names.add(r.service_name));
    bestsellers.forEach((r) => names.add(r.service_name));
    return names;
  }, [recommendations, bestsellers]);

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

  const selectedIds = new Set(selectedServices.map((s) => s.id));

  const recommendedServices = useMemo(() => {
    return services.filter((s) => recSet.has(s.name) && !selectedIds.has(s.id));
  }, [services, recSet, selectedIds]);

  const totalPrice = selectedServices.reduce((sum, s) => sum + s.price, 0);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 shrink-0">
        <button onClick={onBack} className="p-2 hover:bg-stone-100 rounded-lg transition-colors cursor-pointer">
          <svg className="w-5 h-5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <h2 className="text-lg font-bold text-stone-700">
          {t('wizard.selectServices')}
          {customer && <span className="text-sm font-normal text-stone-400 ml-2">— {customer.name}</span>}
        </h2>
      </div>

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: Service catalog */}
        <div className="flex-1 min-w-0 flex flex-col">

          {/* Recommended chips */}
          {recommendedServices.length > 0 && (
            <div className="mb-3 shrink-0">
              <div className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">
                {recommendations.length > 0 ? t('wizard.recommended') : t('wizard.popular')}
              </div>
              <div className="flex flex-wrap gap-2">
                {recommendedServices.slice(0, 6).map((svc) => (
                  <button
                    key={svc.id}
                    onClick={() => onAddService({ id: svc.id, name: svc.name, price: svc.retail_price })}
                    className="px-3 py-1.5 bg-brand-50 border border-brand-200 text-brand-700 text-xs font-medium rounded-lg hover:bg-brand-100 transition-colors cursor-pointer"
                  >
                    {svc.name} · {formatPrice(svc.retail_price)} zł
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Search + category filters on same row */}
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <div className="relative shrink-0 w-48">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('wizard.searchServices')}
                className="w-full pl-9 pr-3 py-2 text-xs border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-300 bg-white"
              />
            </div>
            <div className="flex gap-1.5 overflow-x-auto flex-1">
              <button
                onClick={() => setSelectedCategory(null)}
                className={`px-3 py-2 text-xs font-semibold rounded-xl whitespace-nowrap transition-all cursor-pointer ${
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
                  className={`px-3 py-2 text-xs font-semibold rounded-xl whitespace-nowrap transition-all cursor-pointer ${
                    selectedCategory === cat.id
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'bg-stone-100 text-stone-600 hover:bg-stone-200 border border-stone-200'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>

          {/* Service grid — 2 columns */}
          <div className="flex-1 overflow-y-auto">
            <div className="grid grid-cols-2 gap-3 pb-2">
              {filteredServices.map((svc) => {
                const isSelected = selectedIds.has(svc.id);
                // Use first letter of service name as icon placeholder
                const initial = svc.name.charAt(0).toUpperCase();
                return (
                  <button
                    key={svc.id}
                    onClick={() => {
                      if (isSelected) onRemoveService(svc.id);
                      else onAddService({ id: svc.id, name: svc.name, price: svc.retail_price });
                    }}
                    className={`relative flex items-center gap-3 p-3 rounded-2xl border-2 text-left transition-all duration-150 cursor-pointer ${
                      isSelected
                        ? 'bg-brand-50 border-brand-400 shadow-sm'
                        : 'bg-white border-stone-200 hover:border-brand-300 hover:shadow-md'
                    }`}
                  >
                    {/* Icon area */}
                    <div className={`w-14 h-14 rounded-xl flex items-center justify-center shrink-0 text-lg font-bold transition-colors ${
                      isSelected ? 'bg-brand-200 text-brand-700' : 'bg-stone-100 text-stone-500'
                    }`}>
                      {initial}
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-semibold leading-tight truncate mb-1 ${
                        isSelected ? 'text-brand-700' : 'text-stone-700'
                      }`}>
                        {svc.name}
                      </div>
                      <div className={`text-xs font-bold ${isSelected ? 'text-brand-500' : 'text-stone-400'}`}>
                        {formatPrice(svc.retail_price)} zł
                      </div>
                    </div>
                    {/* Checkmark */}
                    {isSelected && (
                      <div className="absolute top-2 right-2 w-5 h-5 bg-brand-500 rounded-full flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right: Selected + Staff */}
        <div className="w-72 shrink-0 flex flex-col bg-stone-50 rounded-2xl border border-stone-200 p-4">
          {/* Selected services header */}
          <div className="flex items-center justify-between mb-3 shrink-0">
            <h3 className="text-sm font-bold text-stone-600 uppercase tracking-wider">{t('wizard.selected')}</h3>
            <span className="bg-white border border-stone-200 text-stone-600 text-xs font-bold px-2 py-0.5 rounded-full min-w-[24px] text-center">
              {selectedServices.length}
            </span>
          </div>

          {/* Selected list */}
          <div className="flex-1 min-h-0 overflow-y-auto mb-3">
            {selectedServices.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-8 opacity-40">
                <div className="w-10 h-10 border-2 border-dashed border-stone-400 rounded-full mb-2" />
                <p className="text-xs text-stone-500 text-center">No services selected</p>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedServices.map((svc) => (
                  <div key={svc.id} className="flex items-center gap-2 bg-white border border-stone-200 rounded-xl px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-stone-700 truncate">{svc.name}</div>
                      <div className="text-[10px] text-brand-500 font-bold mt-0.5">{formatPrice(svc.price)} zł</div>
                    </div>
                    <button
                      onClick={() => onRemoveService(svc.id)}
                      className="p-1 text-stone-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors cursor-pointer shrink-0"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Staff selector */}
          <div className="mb-3 shrink-0">
            <label className="text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-1.5 block">{t('wizard.staff')}</label>
            <select
              value={selectedStaff?.id || ''}
              onChange={(e) => {
                const staff = staffList.find((s) => s.id === e.target.value);
                onSelectStaff(staff || null);
              }}
              className="w-full px-3 py-2 text-xs border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-300 bg-white cursor-pointer"
            >
              <option value="">{t('wizard.anyStaff')}</option>
              {staffList.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {customer?.preferred_staff_name && (
              <div className="text-[10px] text-stone-400 mt-1">
                {t('wizard.preferred')}: {customer.preferred_staff_name}
              </div>
            )}
          </div>

          {/* Total + confirm */}
          <div className="shrink-0 border-t border-stone-200 pt-3 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs text-stone-500">Total Price:</span>
              <span className="text-sm font-bold text-brand-600">{formatPrice(totalPrice)} zł</span>
            </div>
            <button
              onClick={onConfirm}
              disabled={selectedServices.length === 0}
              className="w-full py-3 bg-brand-600 text-white text-xs font-bold rounded-xl hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shadow-sm"
            >
              {t('wizard.continue')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
