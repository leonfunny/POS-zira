import React from 'react';
import { ScLanguage, SC_LANGUAGES, getScStrings } from '../i18n';

interface UnavailableScreenProps {
  lang: ScLanguage;
  reasons: string[];
  onLangChange: (lang: ScLanguage) => void;
}

export default function UnavailableScreen({
  lang,
  reasons,
  onLangChange,
}: UnavailableScreenProps) {
  const t = getScStrings(lang);

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-50 text-slate-900 select-none">
      <div className="flex justify-end gap-2 px-8 py-6">
        {SC_LANGUAGES.map((l) => (
          <button
            key={l.code}
            type="button"
            onClick={() => onLangChange(l.code)}
            className={`flex h-12 min-w-16 items-center justify-center rounded-xl border-2 px-4 text-xl font-semibold ${
              l.code === lang
                ? 'border-slate-900 bg-white'
                : 'border-slate-200 bg-white text-slate-500'
            }`}
            aria-label={l.label}
          >
            {l.flag}
          </button>
        ))}
      </div>

      <div className="flex flex-1 items-center justify-center px-10 pb-20">
        <div className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <div className="mb-6 text-6xl">×</div>
          <h1 className="text-5xl font-black tracking-tight">
            {t.closedTitle}
          </h1>
          <p className="mt-5 text-2xl text-slate-600">
            {t.closedSubtitle}
          </p>
          {reasons.length > 0 && (
            <ul className="mt-8 space-y-3 text-left text-lg text-slate-700">
              {reasons.map((reason) => (
                <li key={reason} className="rounded-lg bg-slate-50 px-4 py-3">
                  {reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
