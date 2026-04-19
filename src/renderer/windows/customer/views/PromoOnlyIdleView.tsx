import React from 'react';

interface PromoOnlyIdleViewProps {
  t: (key: string) => string;
  businessName?: string;
}

export default function PromoOnlyIdleView({ t, businessName }: PromoOnlyIdleViewProps) {
  return (
    <div
      className="flex h-screen flex-col bg-white text-slate-950"
      data-customer-display-promo-only-idle="true"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-10 py-6">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          {businessName || t('customer.brandName')}
        </div>
        <div className="text-sm font-medium uppercase tracking-[0.18em] text-brand-600">
          Promo display
        </div>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center px-10 text-center">
        <div className="max-w-5xl">
          <p className="text-6xl font-semibold tracking-tight">
            {t('customer.welcome')}
          </p>
          <p className="mx-auto mt-8 max-w-3xl text-2xl leading-10 text-slate-500">
            Featured offers will appear here soon.
          </p>
        </div>
      </main>
    </div>
  );
}
