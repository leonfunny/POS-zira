import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePosStore } from '../../hooks/usePosStore';
import { useConfig } from '../../hooks/useConfig';
import { useBarcodeForwarder } from '../../hooks/useBarcodeForwarder';
import { getTranslation, Language, languageNames } from '../../i18n/translations';
import { resolveName } from '../../../shared/catalog-names';
import rlog from '../../utils/logger';
import ShiftModal from './ShiftModal';
import ShiftReportModal from './ShiftReport';
import RetailTemplate from './templates/retail/RetailTemplate';
import SalonTemplate from './templates/salon/SalonTemplate';
import B2BTemplate from './templates/b2b/B2BTemplate';
import RestaurantTemplate from './templates/restaurant/RestaurantTemplate';
import SyncConflictBanner from './SyncConflictBanner';
import ScanImportModal, { ScanImportDraftPreview } from './ScanImportModal';
import QuickAddCameraModal, {
  QuickAddCapturedImage,
  QuickAddFinalizeInput,
  QuickAddPreparedResult,
} from './QuickAddCameraModal';

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
  useBarcodeForwarder();
  const { state, dispatch } = usePosStore();
  const { config, saveConfig } = useConfig();
  const [language, setLanguage] = useState<Language>((config?.posLanguage as Language) || (config?.language as Language) || 'pl');
  const [posMode, setPosMode] = useState<PosMode>((config?.posMode as PosMode) || 'salon');
  const [isOnline, setIsOnline] = useState(false);
  const [showShiftModal, setShowShiftModal] = useState<'open' | 'close' | null>(null);
  const [shiftReport, setShiftReport] = useState<any>(null);
  const [langOpen, setLangOpen] = useState(false);
  const [scanToast, setScanToast] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);
  const [scanImport, setScanImport] = useState<{
    open: boolean;
    ean: string;
    preview: ScanImportDraftPreview | null;
    loading: boolean;
    error: string | null;
  }>({ open: false, ean: '', preview: null, loading: false, error: null });
  const [showQuickAddCamera, setShowQuickAddCamera] = useState(false);
  const clock = useLiveClock();

  // Hidden barcode capture for USB HID keyboard-style scanners.
  // Stays focused, captures rapid keystrokes ending with Enter, looks up product.
  // inputMode="none" prevents the on-screen touch keyboard from appearing.
  const barcodeRef = useRef<HTMLInputElement>(null);
  const [barcodeBuffer, setBarcodeBuffer] = useState('');
  // Tracks the most recent time a real text input received keyboard activity.
  // The auto-refocus uses this to back off so SearchBar / customer name fields
  // can be typed via the TouchKeyboard without losing focus to the hidden
  // barcode capture input.
  const lastTextInputActivityRef = useRef(0);

  const focusBarcode = useCallback(() => {
    const el = barcodeRef.current;
    if (!el) return;
    const active = document.activeElement;
    // Back off entirely if a visible text input had keyboard activity in the
    // last 5 seconds. HID barcode scanners inject the whole code in <100ms
    // and trigger Enter, so they don't need the hidden input to be focused
    // ahead of time.
    if (Date.now() - lastTextInputActivityRef.current < 5000) return;
    if (active && active !== el) {
      const tag = active.tagName;
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && active !== el) {
        const type = (active as HTMLInputElement).type;
        if (type !== 'hidden' && (active as HTMLElement).offsetParent !== null) return;
      }
    }
    el.focus();
  }, []);

  // Track input/keyup activity on real text inputs so focusBarcode can back off.
  useEffect(() => {
    const isTextInputTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
      if ((el as HTMLInputElement).type === 'hidden') return false;
      if ((el as HTMLElement).offsetParent === null) return false;
      if ((el as HTMLInputElement).dataset.keyboard === 'false') return false;
      return true;
    };
    const handler = (e: Event) => {
      if (isTextInputTarget(e.target)) lastTextInputActivityRef.current = Date.now();
    };
    document.addEventListener('input', handler, true);
    document.addEventListener('keydown', handler, true);
    document.addEventListener('focusin', handler, true);
    return () => {
      document.removeEventListener('input', handler, true);
      document.removeEventListener('keydown', handler, true);
      document.removeEventListener('focusin', handler, true);
    };
  }, []);

  // Re-focus hidden input only after clicks (not on a polling interval) and
  // only when no text input has had recent activity. Polling every second
  // races with TouchKeyboard taps and steals focus from SearchBar mid-type.
  useEffect(() => {
    const handler = () => setTimeout(focusBarcode, 300);
    document.addEventListener('click', handler);
    return () => { document.removeEventListener('click', handler); };
  }, [focusBarcode]);

  useEffect(() => { focusBarcode(); }, [focusBarcode]);

  const showScanToast = useCallback((text: string, type: 'ok' | 'err') => {
    setScanToast({ text, type });
    setTimeout(() => setScanToast(null), 2000);
  }, []);

  // Resolve translator above the barcode callback so it can localize the
  // "Sold out" toast string for scanned items.
  const t = getTranslation(language);

  /**
   * Open the scan-import modal for an EAN that's not in the local catalog.
   * Tries the local draft mirror first (fast, offline-safe), falls back to
   * the network lookup-by-ean only if nothing local matches.
   */
  const openScanImport = useCallback(async (ean: string) => {
    const code = ean.trim();
    if (!code) return;
    setScanImport({ open: true, ean: code, preview: null, loading: true, error: null });
    try {
      const local = await window.electronAPI.pos.draftProducts.getByBarcode(code);
      let preview: ScanImportDraftPreview | null = local
        ? {
            id: local.id,
            name: local.name,
            barcode: local.barcode,
            retail_price: local.retail_price,
            vat_rate: local.vat_rate,
            image_url: local.image_url,
            status: local.status,
          }
        : null;

      if (!preview) {
        const remote = await window.electronAPI.pos.masterCatalog.lookupByEan(code);
        if (remote?.ok && remote.draft) {
          const d = remote.draft;
          preview = {
            id: d.id,
            name: d.name ?? d.title ?? code,
            barcode: d.barcode ?? code,
            retail_price: Number(d.retail_price ?? d.retailPrice ?? d.purchasePrice ?? 0) || 0,
            vat_rate: Number(d.vat_rate ?? d.vatRate ?? 23) || 23,
            image_url: d.image_url ?? d.imageUrl ?? null,
            status: d.status,
          };
        }
      }

      if (!preview) {
        setScanImport({ open: false, ean: code, preview: null, loading: false, error: null });
        showScanToast(`Barcode not found: ${code}`, 'err');
        return;
      }

      setScanImport({ open: true, ean: code, preview, loading: false, error: null });
    } catch (err: any) {
      rlog.warn('[POSLayout] scan-import lookup failed', err?.message);
      setScanImport({ open: false, ean: code, preview: null, loading: false, error: null });
      showScanToast(`Barcode not found: ${code}`, 'err');
    }
  }, [showScanToast]);

  const closeScanImport = useCallback(() => {
    setScanImport({ open: false, ean: '', preview: null, loading: false, error: null });
  }, []);

  const prepareQuickAdd = useCallback(async (
    images: QuickAddCapturedImage[],
    idempotencyKey: string,
  ): Promise<QuickAddPreparedResult> => {
    // Product `name` is the canonical catalog/receipt name. Keep AI analysis
    // in Polish regardless of the operator UI language; display localization
    // is a separate layer in this app.
    const result = await window.electronAPI.pos.quickAdd.prepare({ images, language: 'pl', idempotencyKey });
    if (!result?.ok) throw new Error(result?.error || 'Quick add prepare failed');
    if (!result.product?.id || !result.variant?.id) throw new Error('Quick add create returned no product ids');
    return {
      analysis: result.analysis ?? {},
      product: result.product,
      variant: result.variant,
    };
  }, []);

  const finalizeQuickAdd = useCallback(async (input: QuickAddFinalizeInput) => {
    const result = await window.electronAPI.pos.quickAdd.finalize({
      productId: input.productId,
      variantId: input.variantId,
      retailPrice: input.retailPriceGrosze / 100,
      quantity: input.quantity,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result?.ok) throw new Error(result?.error || 'Quick add finalize failed');

    const variant =
      result.variant
      ?? await window.electronAPI.pos.products.getById(input.variantId)
      ?? (input.ean ? await window.electronAPI.pos.products.getByBarcode(input.ean) : null);
    if (!variant || !dispatch) {
      // The backend mutation already succeeded. Do not surface this as a
      // retryable failure just because the local mirror has not caught up.
      showScanToast('Product saved; catalog refresh pending', 'ok');
      setShowQuickAddCamera(false);
      return;
    }

    const displayName = resolveName(variant, language);
    dispatch({
      type: 'cart/addItem',
      payload: {
        id: crypto.randomUUID(),
        variantId: variant.id,
        name: variant.name,
        sku: variant.sku || '',
        price: variant.retail_price,
        quantity: 1,
        total: variant.retail_price,
        imageUrl: variant.image_url || undefined,
        vatRate: variant.vat_rate,
        name_translations: variant.name_translations ?? null,
      },
    });
    showScanToast(`+ ${displayName}`, 'ok');
    setShowQuickAddCamera(false);
  }, [dispatch, language, showScanToast]);

  const confirmScanImport = useCallback(async () => {
    const ean = scanImport.ean;
    if (!ean) return;
    setScanImport((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await window.electronAPI.pos.masterCatalog.scanCreate({
        ean,
        idempotencyKey: `scan-${ean}-${Date.now()}`,
      });
      if (!result?.ok) {
        setScanImport((s) => ({ ...s, loading: false, error: result?.error || 'Import failed' }));
        return;
      }
      // After scanCreate, main triggers a deltaSync so the variant should be
      // in product_variants now. Look it up and add to cart.
      const variant = await window.electronAPI.pos.products.getByBarcode(ean);
      if (variant && dispatch) {
        const displayName = resolveName(variant, language);
        dispatch({
          type: 'cart/addItem',
          payload: {
            id: crypto.randomUUID(),
            variantId: variant.id,
            name: variant.name,
            sku: variant.sku || '',
            price: variant.retail_price,
            quantity: 1,
            total: variant.retail_price,
            imageUrl: variant.image_url || undefined,
            vatRate: variant.vat_rate,
            name_translations: variant.name_translations ?? null,
          },
        });
        showScanToast(`+ ${displayName}`, 'ok');
      } else {
        showScanToast(
          result.outcome === 'IMPORT_DRAFT'
            ? `Imported draft: ${ean}`
            : `Imported: ${ean}`,
          'ok',
        );
      }
      closeScanImport();
    } catch (err: any) {
      rlog.error('[POSLayout] scan-import confirm failed', err?.message);
      setScanImport((s) => ({ ...s, loading: false, error: err?.message ?? 'Import failed' }));
    }
  }, [scanImport.ean, dispatch, language, showScanToast, closeScanImport]);

  const handleBarcodeKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = barcodeBuffer.trim();
      setBarcodeBuffer('');
      if (code.length >= 3 && dispatch) {
        try {
          const product = await window.electronAPI.pos.products.getByBarcode(code);
          if (product) {
            // Toast shows the operator-language display name; cart line stores
            // canonical `name` + raw `name_translations` so it re-resolves on
            // language change and receipts keep canonical text.
            const displayName = resolveName(product, language);
            if (product.category_id !== 'cat-5' && (product.available_qty ?? product.in_stock) <= 0) {
              showScanToast(`${displayName} — ${t('pos.product.soldOut') || 'Sold out'}`, 'err');
            } else {
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
                  name_translations: product.name_translations ?? null,
                },
              });
              showScanToast(`+ ${displayName}`, 'ok');
            }
          } else {
            // Unknown EAN — try the master catalog. openScanImport opens the
            // preview modal if a draft exists locally or remotely; otherwise
            // it falls back to the "Barcode not found" toast.
            await openScanImport(code);
          }
        } catch (err) {
          rlog.error('[POSLayout] Barcode lookup failed:', err);
          showScanToast('Scan failed', 'err');
        }
      }
    }
  }, [barcodeBuffer, dispatch, showScanToast, language, t, openScanImport]);

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
    }).catch((err: any) => rlog.error('[POSLayout] Failed to load status:', err));
  }, []);

  // Listen for connection status changes
  useEffect(() => {
    const unsub = window.electronAPI.onConnectionStatus((status: any) => {
      setIsOnline(status?.connected ?? false);
    });
    return () => unsub?.();
  }, []);

  const session = state?.session ?? { shiftId: null, staffId: null, staffName: null, isOpen: false, openedAt: null };

  const handleShiftOpen = async (data: { staffName?: string; openingCash?: number; closingCash?: number }) => {
    const result = await window.electronAPI.pos.shift.open({
      staffId: crypto.randomUUID(),
      staffName: data.staffName || t('pos.cashier'),
      openingCash: data.openingCash ?? 0,
    });
    if (!result.success) throw new Error(result.error || 'Failed to open shift');
    setShowShiftModal(null);
  };

  const handleShiftClose = async (data: { staffName?: string; openingCash?: number; closingCash?: number }) => {
    if (!session.shiftId) throw new Error('No active shift');
    const result = await window.electronAPI.pos.shift.close({
      shiftId: session.shiftId,
      closingCash: data.closingCash ?? 0,
    });
    if (!result.success) throw new Error(result.error || 'Failed to close shift');
    setShowShiftModal(null);
    if (result.report) setShiftReport(result.report);
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
          aria-label="Barcode scanner"
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
        aria-label="Barcode scanner"
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
      {/* Scan import preview modal */}
      <ScanImportModal
        open={scanImport.open}
        preview={scanImport.preview}
        ean={scanImport.ean}
        onConfirm={confirmScanImport}
        onCancel={closeScanImport}
        loading={scanImport.loading}
        error={scanImport.error}
        t={t}
      />
      <QuickAddCameraModal
        open={showQuickAddCamera}
        onClose={() => setShowQuickAddCamera(false)}
        onPrepare={prepareQuickAdd}
        onFinalize={finalizeQuickAdd}
        t={t}
      />
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
        {posMode === 'retail' && (
          <RetailTemplate
            state={state}
            dispatch={dispatch}
            t={t}
            session={session}
            onUnknownBarcodeScanned={openScanImport}
            onQuickAddCamera={() => setShowQuickAddCamera(true)}
          />
        )}
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
    </div>
  );
}
