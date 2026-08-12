import React, { useState, useCallback } from 'react';

interface Props {
  t: (key: string) => string;
  onSubmit: (phone: string) => void;
  onSkip: () => void;
  onBack: () => void;
  isLoading: boolean;
  minPhoneDigits?: number;
}

function formatPhoneDisplay(phone: string): string {
  if (!phone) return '';
  // Split on '+' so each '+' is preserved wherever it appears
  const parts = phone.split('+');
  const formatted = parts.map((part) => {
    const digits = part.replace(/\D/g, '');
    const groups: string[] = [];
    for (let i = 0; i < digits.length; i += 3) {
      groups.push(digits.slice(i, i + 3));
    }
    return groups.join(' ');
  });
  return formatted.join('+');
}

const KEYPAD = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['0', '+', 'DEL'],
];

export default function PhoneEntryScreen({ t, onSubmit, onSkip, onBack, isLoading, minPhoneDigits = 3 }: Props) {
  const [phone, setPhone] = useState('');
  const digitCount = phone.replace(/\D/g, '').length;

  const handleKey = useCallback((key: string) => {
    if (key === 'DEL') {
      setPhone((p) => p.slice(0, -1));
    } else {
      setPhone((p) => p + key);
    }
  }, []);

  const handleSubmit = () => {
    if (digitCount >= minPhoneDigits) onSubmit(phone);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Back nav */}
      <div className="shrink-0 mb-2">
        <button
          onClick={onBack}
          aria-label={t('common.back')}
          className="flex min-h-12 min-w-12 items-center justify-center hover:bg-stone-100 rounded-lg transition-colors duration-150 cursor-pointer"
        >
          <svg className="w-5 h-5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
      </div>

      {/* Centered content */}
      <div className="flex-1 flex flex-col items-center justify-center">
        {/* Title */}
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-stone-700 mb-2">{t('wizard.enterPhone')}</h2>
          <p className="text-sm text-stone-500">{t('wizard.phoneSubtitle')}</p>
        </div>

        <div style={{ width: '22rem' }}>
          {/* Phone display */}
          <div className="bg-white border-2 border-stone-200 rounded-2xl px-5 py-4 mb-5 flex items-center space-x-3 shadow-sm">
            <svg className="w-5 h-5 text-stone-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
            </svg>
            <div className="flex-1 text-2xl font-mono font-bold text-stone-800 tracking-widest min-h-[36px] flex items-center">
              {phone ? (
                <span>{formatPhoneDisplay(phone)}</span>
              ) : (
                <span className="text-stone-300 text-base font-normal tracking-normal">{t('wizard.phoneHint')}</span>
              )}
            </div>
            {phone.length > 0 && (
              <span className="text-xs text-stone-400 shrink-0">{digitCount}</span>
            )}
          </div>

          {/* Numeric keypad */}
          <div className="grid grid-cols-3 gap-2.5 mb-5">
            {KEYPAD.flat().map((key) => (
              <button
                key={key}
                onClick={() => handleKey(key)}
                className={`h-16 rounded-xl text-xl font-semibold transition-all duration-150 cursor-pointer select-none ${
                  key === 'DEL'
                    ? 'bg-stone-100 text-stone-500 hover:bg-stone-200 active:bg-stone-300'
                    : 'bg-white border-2 border-stone-200 text-stone-700 hover:border-brand-300 hover:bg-brand-50 active:bg-brand-100 shadow-sm'
                }`}
              >
                {key === 'DEL' ? (
                  <svg className="w-6 h-6 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75L14.25 12m0 0l2.25 2.25M14.25 12l2.25-2.25M14.25 12L12 14.25m-2.58 4.92l-6.374-6.375a1.125 1.125 0 010-1.59L9.42 4.83c.21-.211.497-.33.795-.33H19.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25h-9.284c-.298 0-.585-.119-.795-.33z" />
                  </svg>
                ) : key}
              </button>
            ))}
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={digitCount < minPhoneDigits || isLoading}
            className="w-full py-4 bg-brand-600 text-white text-base font-bold rounded-xl hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-150 cursor-pointer shadow-sm"
          >
            {isLoading ? (
              <span className="flex items-center justify-center space-x-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {t('wizard.searching')}
              </span>
            ) : t('wizard.search')}
          </button>
        </div>
      </div>
    </div>
  );
}
