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
      <div className="min-h-screen bg-gradient-to-b from-slate-900 to-black text-white flex flex-col">
        {/* Header */}
        <div className="pt-8 pb-4 text-center">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-purple-400 via-fuchsia-400 to-pink-400 bg-clip-text text-transparent">
            {salonName || t('customer.brandName')}
          </h1>
          <p className="text-xl text-slate-400 mt-2">
            {t('customer.explore') || 'Explore our services'}
          </p>
        </div>

        {/* Category grid */}
        <div className="flex-1 px-8 pb-8 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4 max-w-3xl mx-auto">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat)}
                className="group relative bg-slate-800/80 hover:bg-slate-700/80 border border-white/10 hover:border-purple-500/40 rounded-2xl p-6 text-left transition-all duration-200 active:scale-[0.98]"
              >
                <div className="text-4xl mb-3">
                  {getCategoryEmoji(cat.name)}
                </div>
                <h3 className="text-xl font-semibold text-white group-hover:text-purple-300 transition-colors">
                  {cat.name}
                </h3>
                <p className="text-sm text-slate-500 mt-1">
                  {cat.services.length} {cat.services.length === 1 ? 'service' : 'services'}
                </p>
                <div className="absolute top-4 right-4 text-slate-600 group-hover:text-purple-400 transition-colors text-xl">
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
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-black text-white flex flex-col">
      {/* Header with back button */}
      <div className="pt-6 pb-4 px-8 flex items-center gap-4">
        <button
          onClick={() => setSelectedCategory(null)}
          className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
        >
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h2 className="text-2xl font-bold text-white">{selectedCategory.name}</h2>
          <p className="text-sm text-slate-500">
            {t('customer.back') || 'Back'} · {t('customer.categories') || 'Categories'}
          </p>
        </div>
      </div>

      {/* Service list */}
      <div className="flex-1 px-8 pb-8 overflow-y-auto">
        <div className="max-w-3xl mx-auto space-y-3">
          {selectedCategory.services.map((svc) => {
            const isRequested = requested.has(svc.id);
            return (
              <div
                key={svc.id}
                className="bg-slate-800/60 border border-white/10 rounded-xl p-4 flex items-center gap-4"
              >
                {/* Image or placeholder */}
                <div className="w-16 h-16 rounded-lg overflow-hidden bg-slate-700 flex items-center justify-center shrink-0">
                  {svc.imageUrl ? (
                    <img src={svc.imageUrl} alt="" className="w-full h-full object-cover" draggable={false} />
                  ) : (
                    <div className="text-2xl">{getCategoryEmoji(selectedCategory.name)}</div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-medium text-white truncate">{svc.name}</h3>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-lg font-semibold text-purple-300">
                      {(svc.price / 100).toFixed(2)} zł
                    </span>
                    {svc.duration > 0 && (
                      <span className="text-sm text-slate-500">
                        {formatDuration(svc.duration)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Action button */}
                <button
                  onClick={() => handleRequest(svc.id)}
                  disabled={isRequested}
                  className={`px-4 py-2.5 rounded-lg text-sm font-medium shrink-0 transition-all ${
                    isRequested
                      ? 'bg-green-600/40 text-green-300 cursor-default'
                      : 'bg-purple-600 hover:bg-purple-500 text-white active:scale-95'
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
