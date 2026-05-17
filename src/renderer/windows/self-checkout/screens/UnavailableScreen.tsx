import React from 'react';
import { AlertTriangle, Hand, Store } from 'lucide-react';
import LanguageSwitch from '../LanguageSwitch';
import { ScLanguage, getScStrings } from '../i18n';

interface UnavailableScreenProps {
  lang: ScLanguage;
  reasons: string[];
  onLangChange: (lang: ScLanguage) => void;
  onCallStaff?: () => void;
}

// Map server-issued reason codes (snake_case, UPPER_CASE, or short labels)
// to localized strings; fall back to the raw text only when we don't
// recognize the code, so unknown reasons still surface something readable.
function localizeReason(reason: string, t: ReturnType<typeof getScStrings>): string {
  const key = reason.trim().toLowerCase().replace(/\s+/g, '_');
  switch (key) {
    case 'offline':
    case 'backend_offline':
    case 'no_connection':
      return t.reasonOffline;
    case 'printer_offline':
    case 'fiscal_offline':
    case 'no_fiscal_printer':
      return t.reasonPrinterOffline;
    case 'terminal_offline':
    case 'no_terminal':
      return t.reasonTerminalOffline;
    case 'shift_closed':
    case 'no_open_shift':
      return t.reasonShiftClosed;
    case 'unknown':
      return t.reasonUnknown;
    default:
      return reason;
  }
}

export default function UnavailableScreen({
  lang,
  reasons,
  onLangChange,
  onCallStaff,
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
        <LanguageSwitch lang={lang} onLangChange={onLangChange} />
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
                  {localizeReason(reason, t)}
                </li>
              ))}
            </ul>
          )}

          {onCallStaff && (
            <button
              type="button"
              onClick={onCallStaff}
              className="sc-help-action sc-focusable mx-auto mt-9 flex items-center gap-2 px-6 text-base"
            >
              <Hand size={22} />
              {t.callStaff}
            </button>
          )}
        </section>
      </main>
    </div>
  );
}
