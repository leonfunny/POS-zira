import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePosStore } from '../../hooks/usePosStore';
import { useConfig } from '../../hooks/useConfig';
import { useKeyboardManager } from '../../hooks/useKeyboardManager';
import { getTranslation, Language, languageNames } from '../../i18n/translations';
import rlog from '../../utils/logger';
import ShiftModal from './ShiftModal';
import ShiftReportModal from './ShiftReport';
import TouchKeyboard from '../shared/TouchKeyboard';
import RetailTemplate from './templates/retail/RetailTemplate';
import SalonTemplate from './templates/salon/SalonTemplate';
import B2BTemplate from './templates/b2b/B2BTemplate';
import RestaurantTemplate from './templates/restaurant/RestaurantTemplate';
import SyncConflictBanner from './SyncConflictBanner';

type PosMode = 'retail' | 'salon' | 'b2b' | 'restaurant';

const POS_LANGS: Language[] = ['en', 'pl', 'vi', 'uk', 'ru', 'zh', 'tr'];

function useLiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const MODE_LABELS: Record<PosMode, string> = {
  retail: 'pos.mode.retail',
  salon: 'pos.mode.salon',
  b2b: 'pos.mode.b2b',
  restaurant: 'pos.mode.restaurant',
};

interface POSLayoutProps {
  onFullscreen?: () => void;
}

export default function POSLayout({ onFullscreen }: POSLayoutProps = {}) {
  const { state, dispatch } = usePosStore();
  const { config, saveConfig } = useConfig();
  const [language, setLanguage] = useState<Language>((config?.posLanguage as Language) || (config?.language as Language) || 'pl');
  const [posMode, setPosMode] = useState<PosMode>((config?.posMode as PosMode) || 'salon');
  const [isOnline, setIsOnline] = useState(false);
  const [showShiftModal, setShowShiftModal] = useState<'open' | 'close' | null>(null);
  const [shiftReport, setShiftReport] = useState<any>(null);
  const [langOpen, setLangOpen] = useState(false);
  const [scanToast, setScanToast] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);
  const clock = useLiveClock();
  const { visible: keyboardVisible, mode: keyboardMode, onKey, onBackspace, onDone } = useKeyboardManager();

  // Hidden barcode capture for USB HID keyboard-style scanners.
  // Stays focused, captures rapid keystrokes ending with Enter, looks up product.
  // inputMode="none" prevents the on-screen touch keyboard from appearing.
  const barcodeRef = useRef<HTMLInputElement>(null);
  const [barcodeBuffer, setBarcodeBuffer] = useState('');

  const focusBarcode = useCallback(() => {
    const el = barcodeRef.current;
    if (!el) return;
    const active = document.activeElement;
    // Only skip if a VISIBLE text input/textarea/select has focus (user is typing).
    // Buttons, divs, body — always reclaim focus for scanner.
    if (active && active !== el) {
      const tag = active.tagName;
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && active !== el) {
        const type = (active as HTMLInputElement).type;
        // Allow reclaiming from hidden inputs and non-text inputs (buttons etc.)
        if (type !== 'hidden' && (active as HTMLElement).offsetParent !== null) return;
      }
    }
    el.focus();
  }, []);

  // Re-focus hidden input after clicks + periodically (catches focus lost to
  // buttons, shift-open, tab switches, etc.)
  useEffect(() => {
    const handler = () => setTimeout(focusBarcode, 300);
    document.addEventListener('click', handler);
    const interval = setInterval(focusBarcode, 1000);
    return () => { document.removeEventListener('click', handler); clearInterval(interval); };
  }, [focusBarcode]);

  useEffect(() => { focusBarcode(); }, [focusBarcode]);

  const showScanToast = useCallback((text: string, type: 'ok' | 'err') => {
    setScanToast({ text, type });
    setTimeout(() => setScanToast(null), 2000);
  }, []);

  const handleBarcodeKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = barcodeBuffer.trim();
      setBarcodeBuffer('');
      if (code.length >= 3 && dispatch) {
        try {
          const product = await window.electronAPI.pos.products.getByBarcode(code);
          if (product) {
            dispatch({
              type: 'cart/addItem',
              payload: {
                id: crypto.randomUUID(),
                variantId: product.id,
                name: product.name,
                sku: product.sku || '',
                price: product.retail_price,
                quantity: 1,
                total: product.retail_price,
                imageUrl: product.image_url || undefined,
                vatRate: product.vat_rate,
              },
            });
            showScanToast(`+ ${product.name}`, 'ok');
          } else {
            showScanToast(`Barcode not found: ${code}`, 'err');
          }
        } catch (err) {
          rlog.error('[POSLayout] Barcode lookup failed:', err);
          showScanToast('Scan failed', 'err');
        }
      }
    }
  }, [barcodeBuffer, dispatch, showScanToast]);

  // Sync language/mode from config
  useEffect(() => {
    if (config?.posLanguage) {
      setLanguage(config.posLanguage as Language);
    } else if (config?.language) {
      setLanguage(config.language as Language);
    }
    if (config?.posMode) {
      setPosMode(config.posMode as PosMode);
    }
  }, [config?.posLanguage, config?.language, config?.posMode]);

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang);
    setLangOpen(false);
    try {
      await saveConfig({ posLanguage: lang });
    } catch (e) {
      rlog.error('Failed to save language:', e);
    }
  };

  // Load initial connection status
  useEffect(() => {
    window.electronAPI.getStatus().then((status: any) => {
      setIsOnline(status?.connected ?? false);
    }).catch((err) => rlog.error('[POSLayout] Failed to load status:', err));
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
        {/* Hidden barcode input must exist even during loading so scanner keystrokes are captured */}
        <input
          ref={barcodeRef}
          value={barcodeBuffer}
          onChange={(e) => setBarcodeBuffer(e.target.value)}
          onKeyDown={handleBarcodeKeyDown}
          inputMode="none"
          data-keyboard="false"
          aria-hidden="true"
          tabIndex={-1}
          className="absolute w-0 h-0 opacity-0 pointer-events-none"
        />
        {t('pos.loading')}
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-50 text-gray-900 flex flex-col overflow-hidden">
      {/* Hidden barcode capture input for USB HID scanners */}
      <input
        ref={barcodeRef}
        value={barcodeBuffer}
        onChange={(e) => setBarcodeBuffer(e.target.value)}
        onKeyDown={handleBarcodeKeyDown}
        inputMode="none"
        data-keyboard="false"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute w-0 h-0 opacity-0 pointer-events-none"
      />
      {/* Barcode scan toast */}
      {scanToast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-top-2 duration-200 ${
          scanToast.type === 'ok'
            ? 'bg-emerald-600 text-white'
            : 'bg-red-600 text-white'
        }`}>
          {scanToast.text}
        </div>
      )}
      {/* Sync conflict banner (Path B) */}
      <SyncConflictBanner />
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
              className="px-4 py-2.5 text-sm bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 font-medium transition-colors border border-emerald-200 touch-manipulation"
            >
              {t('pos.shift.open')}
            </button>
          )}
          {session.isOpen && (
            <button
              onClick={() => setShowShiftModal('close')}
              className="px-4 py-2.5 text-sm bg-red-50 text-red-600 rounded-lg hover:bg-red-100 font-medium transition-colors border border-red-200 touch-manipulation"
            >
              {t('pos.shift.close')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          {/* Current time */}
          <div className="text-right">
            <span className="block text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-400">{clock.toLocaleDateString(language === 'vi' ? 'vi-VN' : language === 'pl' ? 'pl-PL' : language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span className="block text-sm font-bold text-slate-700 tabular-nums">
              {clock.toLocaleTimeString(language === 'vi' ? 'vi-VN' : language === 'pl' ? 'pl-PL' : language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          {/* Fullscreen icon button */}
          {onFullscreen && (
            <button
              onClick={onFullscreen}
              className="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors duration-150 cursor-pointer"
              title="Enter fullscreen mode"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9M20.25 20.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            </button>
          )}

          {/* Language — globe icon with dropdown */}
          <div className="relative">
            <button
              onClick={() => setLangOpen(!langOpen)}
              className="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors duration-150 cursor-pointer"
              title="Change language"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 003 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
            </button>
            {langOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setLangOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-30 bg-white rounded-xl border border-slate-200 shadow-lg py-1 min-w-[120px]">
                  {POS_LANGS.map((l) => (
                    <button
                      key={l}
                      onClick={() => handleLanguageChange(l)}
                      className={`w-full px-3 py-2 text-left text-sm transition-colors duration-150 cursor-pointer flex items-center justify-between ${
                        language === l ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <span>{languageNames[l]}</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase">{l}</span>
                    </button>
                  ))}
                </div>
              </>
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
      <div className="flex-1 flex flex-col overflow-hidden">
        {posMode === 'retail' && <RetailTemplate state={state} dispatch={dispatch} t={t} session={session} />}
        {posMode === 'salon' && <SalonTemplate state={state} dispatch={dispatch} t={t} session={session} />}
        {posMode === 'b2b' && <B2BTemplate state={state} dispatch={dispatch} t={t} session={session} />}
        {posMode === 'restaurant' && <RestaurantTemplate state={state} dispatch={dispatch} t={t} session={session} />}
      </div>

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

      {/* Touch keyboard for fullscreen mode */}
      <TouchKeyboard
        visible={keyboardVisible}
        mode={keyboardMode}
        onKey={onKey}
        onBackspace={onBackspace}
        onDone={onDone}
      />
    </div>
  );
}
