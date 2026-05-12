import React from 'react';
import { AlertTriangle, Store } from 'lucide-react';
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
    <div className="sc-shell flex h-screen w-screen flex-col select-none">
      <header className="flex items-center justify-between px-10 py-8">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--sc-primary)] text-2xl font-black text-white">
            Z
          </div>
          <div className="text-lg font-black uppercase tracking-[0.18em] text-[var(--sc-primary-deep)]">
            Zira AI
          </div>
        </div>
        <div className="flex gap-3">
          {SC_LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => onLangChange(l.code)}
              className="sc-language-button sc-focusable"
              data-active={l.code === lang}
              aria-label={l.label}
            >
              {l.flag}
            </button>
          ))}
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-10 pb-16">
        <section className="sc-surface w-full max-w-4xl p-12 text-center">
          <div className="mx-auto flex h-32 w-32 items-center justify-center rounded-[32px] bg-red-50 text-[var(--sc-danger)]">
            <Store size={70} />
          </div>
          <div className="mx-auto mt-8 inline-flex items-center gap-3 rounded-full border border-red-200 bg-red-50 px-5 py-3 text-lg font-black text-[var(--sc-danger)]">
            <AlertTriangle size={24} />
            {t.productionMode}
          </div>
          <h1 className="mt-6 text-6xl font-black text-[var(--sc-ink)]">
            {t.closedTitle}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-2xl leading-9 text-[var(--sc-muted)]">
            {t.closedSubtitle}
          </p>
          {reasons.length > 0 && (
            <ul className="mx-auto mt-9 max-w-2xl space-y-3 text-left">
              {reasons.map((reason) => (
                <li key={reason} className="rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] px-5 py-4 text-lg font-semibold text-[var(--sc-ink)]">
                  {reason}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
