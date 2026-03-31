import React from 'react';

interface InteractiveViewProps {
  t?: (key: string) => string;
}

const fallbackT = (key: string): string => {
  const defaults: Record<string, string> = {
    'customer.brandName': 'Zira AI',
    'customer.interactiveWelcome': 'How can we help you?',
    'customer.tapToBrowse': 'Tap to browse our services',
  };
  return defaults[key] ?? key;
};

export default function InteractiveView({ t }: InteractiveViewProps) {
  const translate = t ?? fallbackT;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-black text-white flex items-center justify-center">
      <div className="text-center px-8">
        <h1 className="text-6xl font-bold mb-6 bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
          {translate('customer.brandName')}
        </h1>
        <p className="text-3xl text-slate-300 mb-8">
          {translate('customer.interactiveWelcome')}
        </p>
        <p className="text-lg text-slate-500 animate-pulse">
          {translate('customer.tapToBrowse')}
        </p>
      </div>
    </div>
  );
}
