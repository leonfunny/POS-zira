import React, { useState, useCallback } from 'react';

interface ServiceItem {
  id: string;
  name: string;
  price: number;
  duration: number;
  imageUrl?: string;
}

interface ServiceCategory {
  id: string;
  name: string;
  services: ServiceItem[];
}

interface SalonInteractiveViewProps {
  t: (key: string) => string;
  categories: ServiceCategory[];
  salonName?: string;
  onRequestService?: (serviceId: string) => void;
}

export default function SalonInteractiveView({
  t,
  categories,
  salonName,
  onRequestService,
}: SalonInteractiveViewProps) {
  const [selectedCategory, setSelectedCategory] = useState<ServiceCategory | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());

  const handleRequest = useCallback((serviceId: string) => {
    onRequestService?.(serviceId);
    setRequested((prev) => new Set(prev).add(serviceId));
  }, [onRequestService]);

  const formatDuration = (min: number) => {
    if (!min) return '';
    return t('customer.duration').replace('{min}', String(min)) || `${min} min`;
  };

  // Category grid view
  if (!selectedCategory) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-50 via-white to-amber-50 text-slate-900 flex flex-col">
        {/* Header */}
        <div className="pt-10 pb-6 text-center">
          <h1 className="text-5xl font-bold text-brand-600 tracking-tight">
            {salonName || t('customer.brandName')}
          </h1>
          <div className="w-20 h-1 mx-auto bg-gradient-to-r from-transparent via-brand-400 to-transparent mt-4 mb-4 rounded-full" />
          <p className="text-xl text-slate-600 font-light">
            {t('customer.explore') || 'Explore our services'}
          </p>
        </div>

        {/* Category grid */}
        <div className="flex-1 px-8 pb-10 overflow-y-auto">
          <div className="grid grid-cols-2 gap-5 max-w-3xl mx-auto">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat)}
                className="group relative bg-white border border-slate-200 hover:border-brand-300 hover:bg-brand-50/40 rounded-2xl p-6 text-left transition-all duration-200 active:scale-[0.98] shadow-sm"
              >
                <div className="text-5xl mb-3">
                  {getCategoryEmoji(cat.name)}
                </div>
                <h3 className="text-xl font-semibold text-slate-900 group-hover:text-brand-600 transition-colors">
                  {cat.name}
                </h3>
                <p className="text-sm text-slate-500 mt-1">
                  {cat.services.length} {cat.services.length === 1 ? 'service' : 'services'}
                </p>
                <div className="absolute top-4 right-4 text-slate-300 group-hover:text-brand-500 transition-colors text-xl">
                  →
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Service list view for selected category
  return (
    <div className="min-h-screen bg-gradient-to-br from-rose-50 via-white to-amber-50 text-slate-900 flex flex-col">
      {/* Header with back button */}
      <div className="pt-6 pb-4 px-8 flex items-center gap-4 border-b border-slate-200 bg-white/70 backdrop-blur-sm">
        <button
          onClick={() => setSelectedCategory(null)}
          className="p-2 rounded-lg bg-white border border-slate-200 hover:border-brand-300 hover:bg-slate-50 text-slate-600 hover:text-brand-600 transition-colors shadow-sm"
        >
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h2 className="text-2xl font-bold text-slate-900">{selectedCategory.name}</h2>
          <p className="text-sm text-slate-400">
            {t('customer.back') || 'Back'} · {t('customer.categories') || 'Categories'}
          </p>
        </div>
      </div>

      {/* Service list */}
      <div className="flex-1 px-8 pb-10 pt-6 overflow-y-auto">
        <div className="max-w-3xl mx-auto space-y-3">
          {selectedCategory.services.map((svc) => {
            const isRequested = requested.has(svc.id);
            return (
              <div
                key={svc.id}
                className="bg-white border border-slate-200 rounded-xl p-4 flex items-center gap-4 shadow-sm"
              >
                {/* Image or placeholder */}
                <div className="w-16 h-16 rounded-lg overflow-hidden bg-rose-50 flex items-center justify-center shrink-0">
                  {svc.imageUrl ? (
                    <img src={svc.imageUrl} alt="" className="w-full h-full object-cover" draggable={false} />
                  ) : (
                    <div className="text-2xl">{getCategoryEmoji(selectedCategory.name)}</div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-medium text-slate-900 truncate">{svc.name}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-lg font-semibold text-brand-600 tabular-nums">
                      {(svc.price / 100).toFixed(2)} zł
                    </span>
                    {svc.duration > 0 && (
                      <span className="text-sm text-slate-400">
                        {formatDuration(svc.duration)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Action button */}
                <button
                  onClick={() => handleRequest(svc.id)}
                  disabled={isRequested}
                  className={`px-4 py-2.5 rounded-lg text-sm font-medium shrink-0 transition-all shadow-sm ${
                    isRequested
                      ? 'bg-emerald-50 text-emerald-600 border border-emerald-200 cursor-default'
                      : 'bg-brand-500 hover:bg-brand-600 text-white active:scale-95'
                  }`}
                >
                  {isRequested
                    ? (t('customer.serviceRequested') || 'Requested!')
                    : (t('customer.addToVisit') || 'Add to my visit')
                  }
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Simple emoji mapping for common nail/beauty categories */
function getCategoryEmoji(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('manicure') || lower.includes('nails') || lower.includes('paznok')) return '💅';
  if (lower.includes('pedicure') || lower.includes('stóp') || lower.includes('foot')) return '🦶';
  if (lower.includes('gel') || lower.includes('żel')) return '✨';
  if (lower.includes('lash') || lower.includes('rzęs')) return '👁️';
  if (lower.includes('brow') || lower.includes('brwi')) return '✏️';
  if (lower.includes('hair') || lower.includes('włos')) return '💇';
  if (lower.includes('massage') || lower.includes('masaż')) return '💆';
  if (lower.includes('facial') || lower.includes('twarz')) return '🧖';
  if (lower.includes('wax') || lower.includes('depil')) return '🪒';
  if (lower.includes('spa')) return '🧴';
  return '💎';
}
