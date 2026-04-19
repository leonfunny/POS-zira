import React, { useEffect, useState } from 'react';

interface RetailAssistedIdleViewProps {
  t: (key: string) => string;
  businessName?: string;
}

export default function RetailAssistedIdleView({ t, businessName }: RetailAssistedIdleViewProps) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 10000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-950">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-10 py-6">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {businessName || t('customer.brandName')}
          </div>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">
            {t('customer.retail.idleTitle')}
          </h1>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-2xl font-semibold tabular-nums">
          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center px-10">
        <div className="w-full max-w-5xl rounded-lg border border-slate-200 bg-white p-12 text-center shadow-sm">
          <p className="text-6xl font-semibold tracking-tight text-slate-950">
            {t('customer.retail.idleSubtitle')}
          </p>
          <p className="mx-auto mt-8 max-w-3xl text-2xl leading-10 text-slate-600">
            {t('customer.retail.paymentPrompt')}
          </p>
        </div>
      </main>
    </div>
  );
}
