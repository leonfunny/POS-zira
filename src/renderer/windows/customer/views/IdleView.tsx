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
    <div className="min-h-screen bg-black text-white flex items-center justify-center overflow-hidden relative">
      {/* Animated gradient background */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          background: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 25%, #0f3460 50%, #1a0a2e 75%, #16213e 100%)',
          backgroundSize: '400% 400%',
          animation: 'salonGradient 15s ease infinite',
        }}
      />

      {/* Decorative floating shapes */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute w-64 h-64 rounded-full opacity-10"
          style={{
            background: 'radial-gradient(circle, #c084fc 0%, transparent 70%)',
            top: '10%',
            right: '15%',
            animation: 'float 8s ease-in-out infinite',
          }}
        />
        <div
          className="absolute w-48 h-48 rounded-full opacity-8"
          style={{
            background: 'radial-gradient(circle, #f0abfc 0%, transparent 70%)',
            bottom: '15%',
            left: '10%',
            animation: 'float 10s ease-in-out infinite reverse',
          }}
        />
        <div
          className="absolute w-32 h-32 rounded-full opacity-10"
          style={{
            background: 'radial-gradient(circle, #e879f9 0%, transparent 70%)',
            top: '50%',
            left: '60%',
            animation: 'float 12s ease-in-out infinite 2s',
          }}
        />
      </div>

      {/* Content */}
      <div className="text-center z-10">
        {/* Clock */}
        <p className="text-lg text-slate-500 font-mono tabular-nums mb-8">
          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>

        <h1 className="text-7xl font-bold mb-6 bg-gradient-to-r from-purple-400 via-fuchsia-400 to-pink-400 bg-clip-text text-transparent">
          {displayName}
        </h1>

        <p className="text-2xl text-slate-400 mb-12">
          {translate('customer.welcome')}
        </p>

        <p
          className="text-lg text-slate-500"
          style={{ animation: 'pulse 2.5s ease-in-out infinite' }}
        >
          {translate('customer.touchToExplore')}
        </p>
      </div>

      <style>{`
        @keyframes salonGradient {
          0%, 100% { background-position: 0% 50%; }
          25% { background-position: 100% 0%; }
          50% { background-position: 100% 100%; }
          75% { background-position: 0% 100%; }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-30px) scale(1.1); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
