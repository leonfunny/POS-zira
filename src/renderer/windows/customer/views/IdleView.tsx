import React, { useState, useEffect } from 'react';

interface IdleViewProps {
  t?: (key: string) => string;
  salonName?: string;
}

const fallbackT = (key: string): string => {
  const defaults: Record<string, string> = {
    'customer.brandName': 'Zira AI',
    'customer.welcome': 'Welcome',
    'customer.touchToExplore': 'Touch to explore our services',
  };
  return defaults[key] ?? key;
};

export default function IdleView({ t, salonName }: IdleViewProps) {
  const translate = t ?? fallbackT;
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const displayName = salonName || translate('customer.brandName');

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-rose-50 via-white to-amber-50 text-slate-900">
      {/* Soft pastel floating shapes */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute w-96 h-96 rounded-full opacity-40"
          style={{
            background: 'radial-gradient(circle, rgba(251,113,133,0.25) 0%, transparent 70%)',
            top: '5%',
            right: '10%',
            animation: 'float 9s ease-in-out infinite',
          }}
        />
        <div
          className="absolute w-80 h-80 rounded-full opacity-40"
          style={{
            background: 'radial-gradient(circle, rgba(253,186,116,0.22) 0%, transparent 70%)',
            bottom: '8%',
            left: '8%',
            animation: 'float 11s ease-in-out infinite reverse',
          }}
        />
        <div
          className="absolute w-64 h-64 rounded-full opacity-30"
          style={{
            background: 'radial-gradient(circle, rgba(244,114,182,0.25) 0%, transparent 70%)',
            top: '45%',
            left: '55%',
            animation: 'float 13s ease-in-out infinite 2s',
          }}
        />
      </div>

      {/* Content */}
      <div className="text-center z-10 px-8">
        {/* Clock */}
        <p className="text-lg text-slate-400 font-light tabular-nums mb-10 tracking-widest">
          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>

        <h1 className="text-7xl font-bold mb-6 text-brand-600 tracking-tight">
          {displayName}
        </h1>

        <div className="w-24 h-1 mx-auto bg-gradient-to-r from-transparent via-brand-400 to-transparent mb-6 rounded-full" />

        <p className="text-3xl text-slate-600 font-light mb-14">
          {translate('customer.welcome')}
        </p>

        <p
          className="text-base text-slate-400 font-medium tracking-wide"
          style={{ animation: 'pulseSoft 2.8s ease-in-out infinite' }}
        >
          {translate('customer.touchToExplore')}
        </p>
      </div>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-24px) scale(1.05); }
        }
        @keyframes pulseSoft {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
