import React, { useState, useEffect, useRef } from 'react';
import { usePosStore } from '../../hooks/usePosStore';
import { getTranslation, Language, languageNames } from '../../i18n/translations';
import ShiftModal from './ShiftModal';
import ShiftReportModal from './ShiftReport';
import RetailTemplate from './templates/retail/RetailTemplate';
import SalonTemplate from './templates/salon/SalonTemplate';
import B2BTemplate from './templates/b2b/B2BTemplate';
import RestaurantTemplate from './templates/restaurant/RestaurantTemplate';

type PosMode = 'retail' | 'salon' | 'b2b' | 'restaurant';

const LANGUAGE_FLAGS: Record<Language, string> = {
  en: 'EN',
  vi: 'VI',
  tr: 'TR',
  zh: 'ZH',
  uk: 'UK',
  ru: 'RU',
  pl: 'PL',
};

const LANGUAGES: Language[] = ['en', 'pl', 'vi', 'uk', 'ru', 'zh', 'tr'];

const MODE_LABELS: Record<PosMode, string> = {
  retail: 'pos.mode.retail',
  salon: 'pos.mode.salon',
  b2b: 'pos.mode.b2b',
  restaurant: 'pos.mode.restaurant',
};

export default function POSLayout() {
  const { state, dispatch } = usePosStore();
  const [language, setLanguage] = useState<Language>('pl');
  const [posMode, setPosMode] = useState<PosMode>('salon');
  const [isOnline, setIsOnline] = useState(false);
  const [showShiftModal, setShowShiftModal] = useState<'open' | 'close' | null>(null);
  const [shiftReport, setShiftReport] = useState<any>(null);
  const [showLangDropdown, setShowLangDropdown] = useState(false);
  const langDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) {
        setShowLangDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang);
    setShowLangDropdown(false);
    try {
      await window.electronAPI.setConfig({ posLanguage: lang });
    } catch (e) {
      console.error('Failed to save language:', e);
    }
  };

  // Load config (language + posMode) + initial connection status
  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      if (cfg?.posLanguage) {
        setLanguage(cfg.posLanguage);
      } else if (cfg?.language) {
        setLanguage(cfg.language);
      }
      if (cfg?.posMode) {
        setPosMode(cfg.posMode);
      }
    }).catch((err) => console.error('[POSLayout] Failed to load config:', err));

    window.electronAPI.getStatus().then((status: any) => {
      setIsOnline(status?.connected ?? false);
    }).catch((err) => console.error('[POSLayout] Failed to load status:', err));
  }, []);

  // Listen for connection status changes
  useEffect(() => {
    const unsub = window.electronAPI.onConnectionStatus((status: any) => {
      setIsOnline(status?.connected ?? false);
    });
    return () => unsub?.();
  }, []);

  const t = getTranslation(language);
  const session = state?.session ?? { shiftId: null, staffId: null, staffName: null, isOpen: false, openedAt: null };

  const handleShiftOpen = async (data: { staffName?: string; openingCash?: number; closingCash?: number }) => {
    const result = await window.electronAPI.pos.shift.open({
      staffId: crypto.randomUUID(),
      staffName: data.staffName || t('pos.cashier'),
      openingCash: data.openingCash ?? 0,
    });
    if (result.success) {
      setShowShiftModal(null);
    }
  };

  const handleShiftClose = async (data: { staffName?: string; openingCash?: number; closingCash?: number }) => {
    if (!session.shiftId) return;
    const result = await window.electronAPI.pos.shift.close({
      shiftId: session.shiftId,
      closingCash: data.closingCash ?? 0,
    });
    if (result.success) {
      setShowShiftModal(null);
      setShiftReport(result.report);
    }
  };

  if (!state) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-gray-400">
        {t('pos.loading')}
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-50 text-gray-900 flex flex-col overflow-hidden">
      {/* Header - shared across all modes */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-gray-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold text-brand-600 tracking-wide">Zira POS</h1>
          <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">
            {t(MODE_LABELS[posMode])}
          </span>
          {session.staffName && (
            <span className="text-xs text-gray-500 font-medium">
              {session.staffName}
            </span>
          )}
          {!session.isOpen && (
            <button
              onClick={() => setShowShiftModal('open')}
              className="px-3 py-1.5 text-xs bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 font-medium transition-colors border border-emerald-200"
            >
              {t('pos.shift.open')}
            </button>
          )}
          {session.isOpen && (
            <button
              onClick={() => setShowShiftModal('close')}
              className="px-3 py-1.5 text-xs bg-red-50 text-red-600 rounded-lg hover:bg-red-100 font-medium transition-colors border border-red-200"
            >
              {t('pos.shift.close')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Language Switcher */}
          <div className="relative" ref={langDropdownRef}>
            <button
              onClick={() => setShowLangDropdown(!showLangDropdown)}
              className="px-3 py-1.5 text-xs rounded-lg bg-slate-50 text-gray-600 border border-gray-200 hover:bg-gray-100 flex items-center gap-1.5 transition-colors font-medium"
            >
              <span className="text-sm">{LANGUAGE_FLAGS[language]}</span>
              <span className="hidden sm:inline">{languageNames[language]}</span>
              <svg className={`w-3 h-3 transition-transform ${showLangDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showLangDropdown && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-50 min-w-[140px] py-1 overflow-hidden">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    onClick={() => handleLanguageChange(lang)}
                    className={`w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-slate-50 transition-colors ${
                      language === lang ? 'bg-slate-50 text-brand-600' : 'text-gray-600'
                    }`}
                  >
                    <span className="text-sm">{LANGUAGE_FLAGS[lang]}</span>
                    <span>{languageNames[lang]}</span>
                    {language === lang && (
                      <svg className="w-3 h-3 ml-auto text-brand-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Connection status */}
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            isOnline ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-red-50 text-red-600 border-red-200'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-red-500'}`} />
            {isOnline ? t('pos.online') : t('pos.offline')}
          </span>
        </div>
      </div>

      {/* Mode-specific layout */}
      {posMode === 'retail' && <RetailTemplate state={state} dispatch={dispatch} t={t} session={session} />}
      {posMode === 'salon' && <SalonTemplate state={state} dispatch={dispatch} t={t} session={session} />}
      {posMode === 'b2b' && <B2BTemplate state={state} dispatch={dispatch} t={t} session={session} />}
      {posMode === 'restaurant' && <RestaurantTemplate state={state} dispatch={dispatch} t={t} session={session} />}

      {/* Shift modals - shared */}
      {showShiftModal === 'open' && (
        <ShiftModal
          mode="open"
          onSubmit={handleShiftOpen}
          onClose={() => setShowShiftModal(null)}
          t={t}
        />
      )}
      {showShiftModal === 'close' && (
        <ShiftModal
          mode="close"
          shiftId={session.shiftId}
          onSubmit={handleShiftClose}
          onClose={() => setShowShiftModal(null)}
          t={t}
        />
      )}
      {shiftReport && (
        <ShiftReportModal
          report={shiftReport}
          onClose={() => setShiftReport(null)}
          t={t}
        />
      )}
    </div>
  );
}
