import React, { useState, useRef, useCallback, useEffect } from 'react';
import TouchKeyboard from './TouchKeyboard';

type ActiveField = 'name' | 'notes' | null;

interface Props {
  t: (key: string) => string;
  initialPhone: string;
  onSubmit: (form: { name: string; phone: string; birthday?: string; notes?: string; marketingConsent?: boolean }) => void;
  onBack: () => void;
}

// Approximate keyboard heights by mode (for scroll-padding)
const KB_HEIGHT = { alpha: 248, full: 356 };

export default function NewCustomerScreen({ t, initialPhone, onSubmit, onBack }: Props) {
  const [name, setName] = useState('');
  const [phone] = useState(initialPhone);
  const [birthday, setBirthday] = useState('');
  const [notes, setNotes] = useState('');
  const [marketingConsent, setMarketingConsent] = useState(true);
  const [activeField, setActiveField] = useState<ActiveField>('name');

  const nameRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-focus name field on mount so keyboard opens immediately
  useEffect(() => {
    const timer = setTimeout(() => {
      nameRef.current?.focus();
    }, 200);
    return () => clearTimeout(timer);
  }, []);

  // Scroll active field into view above the keyboard
  useEffect(() => {
    if (!activeField) return;
    const el = activeField === 'name' ? nameRef.current : notesRef.current;
    if (!el) return;
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  }, [activeField]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name: name.trim(), phone: phone.trim(), birthday: birthday || undefined, notes: notes || undefined, marketingConsent });
  };

  const handleKey = useCallback((key: string) => {
    if (activeField === 'name') setName((prev) => prev + key);
    else if (activeField === 'notes') setNotes((prev) => prev + key);
  }, [activeField]);

  const handleBackspace = useCallback(() => {
    if (activeField === 'name') setName((prev) => prev.slice(0, -1));
    else if (activeField === 'notes') setNotes((prev) => prev.slice(0, -1));
  }, [activeField]);

  const handleDone = useCallback(() => {
    setActiveField(null);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, []);

  // Dismiss keyboard when tapping outside inputs/buttons
  const handleContainerTap = useCallback((e: React.PointerEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SVG' || tag === 'PATH') return;
    if ((e.target as HTMLElement).closest('button')) return;
    if (activeField) handleDone();
  }, [activeField, handleDone]);

  const kbHeight = activeField ? KB_HEIGHT[activeField === 'notes' ? 'full' : 'alpha'] : 0;

  return (
    <div className="h-full flex flex-col relative overflow-hidden" onPointerDown={handleContainerTap}>
      {/* Header */}
      <div className="flex items-center gap-3 px-1 pt-2 pb-3 shrink-0">
        <button
          onClick={onBack}
          aria-label="Go back"
          className="p-2 hover:bg-stone-100 rounded-lg transition-colors cursor-pointer"
        >
          <svg className="w-5 h-5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <div>
          <h2 className="text-2xl font-bold text-stone-700">{t('wizard.newCustomer')}</h2>
          <p className="text-xs text-stone-500 italic mt-0.5">{t('wizard.newGuestDesc')}</p>
        </div>
      </div>

      {/* Scrollable form */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{ paddingBottom: kbHeight > 0 ? kbHeight + 16 : 16, transition: 'padding-bottom 0.3s ease' }}
      >
        <div className="max-w-lg mx-auto px-1">

          {/* Form card */}
          <form onSubmit={handleSubmit} className="bg-stone-50 rounded-3xl border border-stone-200 p-6 shadow-sm">

            {/* Phone — read-only with edit button */}
            <div className="pb-5 mb-5 border-b border-stone-200">
              <label className="block text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">
                {t('wizard.phone')}
              </label>
              <div className="flex items-center gap-2">
                <div className={`flex-1 flex items-center gap-2 px-4 py-3 border-2 rounded-xl font-mono text-base font-bold tracking-wider ${
                  phone
                    ? 'bg-brand-50 border-brand-200 text-brand-700'
                    : 'bg-stone-100 border-stone-200 text-stone-400'
                }`}>
                  <svg className="w-4 h-4 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
                  </svg>
                  {phone || <span className="font-normal text-sm">{t('wizard.noPhoneEntered')}</span>}
                </div>
                <button
                  type="button"
                  onClick={onBack}
                  className="p-2.5 text-stone-400 hover:text-stone-600 hover:bg-stone-100 rounded-xl transition-colors cursor-pointer"
                  title="Edit phone"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Name + Birthday — 2-column grid */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              {/* Name */}
              <div>
                <label htmlFor="nc-name" className="block text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">
                  {t('wizard.customerName')}
                  <span className="ml-1 normal-case font-normal text-stone-400">({t('wizard.optional')})</span>
                </label>
                <div className="relative">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-300 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                  </svg>
                  <input
                    ref={nameRef}
                    id="nc-name"
                    type="text"
                    value={name}
                    readOnly
                    onFocus={() => setActiveField('name')}
                    className={`w-full pl-9 pr-3 py-3 text-sm border-2 rounded-xl focus:outline-none transition-all cursor-pointer ${
                      activeField === 'name'
                        ? 'border-brand-400 ring-2 ring-brand-200 bg-brand-50'
                        : 'border-stone-200 bg-white hover:border-stone-300'
                    }`}
                    placeholder={t('wizard.customerNamePlaceholder')}
                  />
                </div>
              </div>

              {/* Birthday */}
              <div>
                <label htmlFor="nc-birthday" className="block text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">
                  {t('wizard.birthday')}
                  <span className="ml-1 normal-case font-normal text-stone-400">({t('wizard.optional')})</span>
                </label>
                <div className="relative">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-300 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                  </svg>
                  <input
                    id="nc-birthday"
                    type="date"
                    value={birthday}
                    onChange={(e) => setBirthday(e.target.value)}
                    onFocus={() => setActiveField(null)}
                    className="w-full pl-9 pr-3 py-3 text-sm border-2 border-stone-200 bg-white rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-200 focus:border-brand-400 transition-all hover:border-stone-300"
                  />
                </div>
                <p className="text-[10px] text-brand-500 mt-1.5 flex items-center gap-1">
                  <span>🎂</span> {t('wizard.birthdayHint')}
                </p>
              </div>
            </div>

            {/* Notes */}
            <div className="mb-4">
              <label htmlFor="nc-notes" className="block text-[10px] font-bold text-stone-400 uppercase tracking-wider mb-2">
                {t('wizard.notes')}
                <span className="ml-1 normal-case font-normal text-stone-400">({t('wizard.optional')})</span>
              </label>
              <textarea
                ref={notesRef}
                id="nc-notes"
                value={notes}
                readOnly
                onFocus={() => setActiveField('notes')}
                rows={2}
                className={`w-full px-3 py-2.5 text-sm border-2 rounded-xl focus:outline-none transition-all resize-none cursor-pointer ${
                  activeField === 'notes'
                    ? 'border-brand-400 ring-2 ring-brand-200 bg-brand-50'
                    : 'border-stone-200 bg-white hover:border-stone-300'
                }`}
                placeholder={t('wizard.notesPlaceholder') || 'Allergies, preferences...'}
              />
            </div>

            {/* Marketing consent */}
            <label className="flex items-start gap-3 mb-5 cursor-pointer select-none" onClick={() => setMarketingConsent(!marketingConsent)}>
              <div className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${
                marketingConsent
                  ? 'bg-brand-600 border-brand-600'
                  : 'bg-white border-stone-300'
              }`}>
                {marketingConsent && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <span className="text-xs text-stone-600 leading-relaxed">{t('wizard.marketingConsent')}</span>
            </label>

            <button
              type="submit"
              className="w-full py-4 bg-brand-600 text-white text-sm font-bold rounded-xl hover:bg-brand-700 transition-colors cursor-pointer shadow-sm"
            >
              {t('wizard.createAndContinue')}
            </button>
          </form>

        </div>
      </div>

      {/* Touch keyboard */}
      <div className="absolute bottom-0 left-0 right-0 z-10">
        <TouchKeyboard
          visible={activeField !== null}
          mode={activeField === 'notes' ? 'full' : 'alpha'}
          onKey={handleKey}
          onBackspace={handleBackspace}
          onDone={handleDone}
        />
      </div>
    </div>
  );
}
