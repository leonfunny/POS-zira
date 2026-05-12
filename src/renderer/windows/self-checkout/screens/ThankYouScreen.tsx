// Thank-you screen. Auto-returns to welcome after 8 seconds.
import React, { useEffect } from 'react';
import { CheckCircle2 } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';
import { formatPLN } from '../useScCart';

interface ThankYouScreenProps {
  lang: ScLanguage;
  totalGrosze: number;
  onReset: () => void;
  onLangChange: (lang: ScLanguage) => void;
}

export default function ThankYouScreen({
  lang,
  totalGrosze,
  onReset,
  onLangChange,
}: ThankYouScreenProps) {
  const t = getScStrings(lang);
  useEffect(() => {
    const id = setTimeout(onReset, 8000);
    return () => clearTimeout(id);
  }, [onReset]);

  return (
    <div className="sc-shell flex h-screen w-screen flex-col select-none">
      <header className="flex justify-end px-10 py-6">
        <LanguageSwitch lang={lang} onLangChange={onLangChange} compact />
      </header>
      <main className="flex min-h-0 flex-1 items-center justify-center px-8 pb-8 text-center">
        <section className="sc-surface w-full max-w-3xl p-12">
          <div className="mx-auto flex h-36 w-36 items-center justify-center rounded-[40px] bg-emerald-50 text-[var(--sc-success)]">
            <CheckCircle2 size={92} />
          </div>
          <h1 className="mt-9 text-7xl font-black text-emerald-800">
            {t.thankYouTitle}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-2xl leading-9 text-[var(--sc-muted)]">
            {t.thankYouSub}
          </p>
          <div className="sc-tabular mt-9 text-5xl font-black text-[var(--sc-ink)]">
            {formatPLN(totalGrosze)}
          </div>
          <button
            type="button"
            onClick={onReset}
            className="sc-secondary-action sc-focusable mt-10 px-8 text-lg text-emerald-800"
          >
            {t.startButton}
          </button>
        </section>
      </main>
    </div>
  );
}
