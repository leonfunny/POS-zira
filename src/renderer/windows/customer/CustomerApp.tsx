// Customer Display window — entry point for the second-screen experience.
//
// Intended for a dual-monitor salon setup: operator works on the POS window,
// the customer sees this window on a separate monitor (or full-screen kiosk
// on a single monitor when `customerDisplayForceKiosk` is on).
//
// State machine driven by PosStore broadcasts (src/main/pos/pos-store.ts):
//   idle / promo  → IdleView / PromoView (touch-to-enter, auto carousel)
//   checkin       → CheckInView          (customer self check-in)
//   interactive   → SalonInteractiveView (customer browses services)
//   cart          → CartView             (live order summary + payment status)
//   thankyou      → ThankYouView         (post-payment, returns to idle)
//
// Touch handling below adds a kiosk gesture guard (block edge swipes) and a
// staff exit gesture (3-finger swipe-down from the top).
import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { PosState } from '../../hooks/usePosStore';
import { getTranslation, Language } from '../../i18n/translations';
import rlog from '../../utils/logger';
import IdleView from './views/IdleView';
import CartView from './views/CartView';
import ThankYouView from './views/ThankYouView';
import PromoView from './views/PromoView';
import SalonInteractiveView from './views/SalonInteractiveView';
import CheckInView from './views/CheckInView';
import { resolveCustomerDisplayLanguage } from './customer-display-model';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    rlog.error('[CustomerDisplay] Render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-white via-rose-50 to-amber-50 text-slate-900 flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-4xl font-bold mb-4 text-slate-900">Display Error</h1>
            <p className="text-slate-500 mb-6">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-6 py-3 bg-brand-500 hover:bg-brand-600 text-white rounded-xl text-lg transition-colors font-medium"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function CustomerApp() {
  const [state, setState] = useState<PosState | null>(null);
  const [lang, setLang] = useState<Language>('en');
  const staffGestureStartY = useRef<number[]>([]);

  // Kiosk gesture guard:
  //   • Single-finger touches that start within 20px of any edge are blocked to prevent
  //     OS-level swipe-from-edge gestures (which can exit fullscreen/kiosk on Windows).
  //   • 3-finger swipe DOWN from the top area (all fingers starting above 120px and
  //     moving ≥80px downward) triggers staff exit. This is hard for customers to do
  //     accidentally but easy for staff once they know the gesture.
  useEffect(() => {
    const EDGE_BLOCK_PX = 20;    // pixels from screen edge to intercept single-finger swipes
    const STAFF_ZONE_Y = 120;    // pixels from top within which the 3-finger gesture must start
    const STAFF_SWIPE_PX = 80;   // minimum downward movement to confirm staff exit

    const onTouchStart = (e: TouchEvent) => {
      const touches = e.touches;

      // --- Staff exit: 3+ fingers in top zone ---
      if (touches.length >= 3) {
        const allInZone = Array.from(touches).every(t => t.clientY < STAFF_ZONE_Y);
        if (allInZone) {
          staffGestureStartY.current = Array.from(touches).map(t => t.clientY);
          e.preventDefault(); // prevent OS from acting on this multi-finger gesture
          return;
        }
      }

      // Reset staff gesture if other touches occur
      staffGestureStartY.current = [];

      // --- Block single-finger edge swipes ---
      if (touches.length === 1) {
        const t = touches[0];
        const nearTop = t.clientY < EDGE_BLOCK_PX;
        const nearLeft = t.clientX < EDGE_BLOCK_PX;
        const nearRight = t.clientX > window.innerWidth - EDGE_BLOCK_PX;
        if (nearTop || nearLeft || nearRight) {
          e.preventDefault();
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 3 && staffGestureStartY.current.length >= 3) {
        e.preventDefault(); // keep blocking while the staff gesture is in progress
        const currentY = Array.from(e.touches).map(t => t.clientY);
        const allMovedDown = currentY.every(
          (y, i) => y - (staffGestureStartY.current[i] ?? 0) >= STAFF_SWIPE_PX,
        );
        if (allMovedDown) {
          staffGestureStartY.current = []; // prevent double-trigger
          window.electronAPI.display?.close?.();
        }
      }
    };

    const onTouchEnd = () => {
      // Reset if fingers lifted before completing the swipe
      if (staffGestureStartY.current.length > 0) {
        staffGestureStartY.current = [];
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  useEffect(() => {
    rlog.info('[CustomerApp] mount — subscribing to pos state');
    // DEBUG: forward mount event to main so it lands in combined.log.
    // Also report which API methods are available on window.electronAPI — this proves
    // preload-display.js was loaded and contextBridge succeeded.
    try {
      const api: any = window.electronAPI;
      const topKeys = api ? Object.keys(api).join(',') : '(electronAPI undefined)';
      const displayKeys = api?.display ? Object.keys(api.display).join(',') : '(display undefined)';
      api?.display?.debugLog?.(
        `mount — electronAPI keys=[${topKeys}] display keys=[${displayKeys}]`,
      );
    } catch (err) {
      rlog.error('[CustomerApp] debugLog failed at mount:', err);
    }

    // Attach listener FIRST so no broadcasts are missed between getState and subscription.
    const unsub = window.electronAPI.pos.onStateChanged((s: PosState) => {
      rlog.info('[CustomerApp] state changed mode=', s?.display?.mode, 'items=', s?.cart?.items?.length);
      window.electronAPI.display?.debugLog?.(
        `state changed mode=${s?.display?.mode} items=${s?.cart?.items?.length ?? 0}`,
      );
      setState(s);
    });
    // Pull initial state — but only apply it if the listener hasn't already delivered newer state.
    // Without this guard, a broadcast that fires between getState() and its .then can be clobbered
    // by the stale initial state arriving second.
    window.electronAPI.pos.getState().then((s: PosState | null) => {
      rlog.info('[CustomerApp] initial state mode=', s?.display?.mode, 'items=', s?.cart?.items?.length);
      window.electronAPI.display?.debugLog?.(
        `initial getState mode=${s?.display?.mode} items=${s?.cart?.items?.length ?? 0}`,
      );
      setState((prev) => prev ?? s);
    });

    // Load language from config
    window.electronAPI.getConfig().then((cfg: any) => {
      setLang(resolveCustomerDisplayLanguage(cfg));
    });

    return unsub;
  }, []);

  const t = getTranslation(lang);
  const displayMode = state?.display?.mode || 'idle';
  const display = state?.display;

  // Send touch event to main process for idle/promo modes
  const handleScreenTouch = useCallback(() => {
    // DEBUG: log unconditionally so we can tell whether the pointer event even fires
    // vs. the optional chain silently dropping the invoke because display.touch is undefined.
    const hasTouch = typeof window.electronAPI?.display?.touch;
    window.electronAPI?.display?.debugLog?.(
      `handleScreenTouch fired mode=${displayMode} typeof(display.touch)=${hasTouch}`,
    );
    if (displayMode === 'idle' || displayMode === 'promo') {
      try {
        const p = window.electronAPI.display?.touch?.();
        // If touch() returned a Promise, await its result so we can log the outcome.
        if (p && typeof (p as any).then === 'function') {
          (p as Promise<unknown>)
            .then(() => {
              window.electronAPI?.display?.debugLog?.('display.touch() invoke resolved');
            })
            .catch((err: any) => {
              window.electronAPI?.display?.debugLog?.(
                `display.touch() invoke rejected: ${err?.message ?? String(err)}`,
              );
            });
        }
      } catch (err: any) {
        window.electronAPI?.display?.debugLog?.(
          `display.touch() threw: ${err?.message ?? String(err)}`,
        );
      }
    }
  }, [displayMode]);

  // Handle browse services from check-in
  const handleBrowseServices = useCallback(() => {
    window.electronAPI.display?.browseServices?.();
  }, []);

  // Handle back to idle/promo from check-in
  const handleBackToIdle = useCallback(() => {
    window.electronAPI.display?.backToIdle?.();
  }, []);

  const handleBackToCheckIn = useCallback(() => {
    window.electronAPI.display?.backToCheckin?.();
  }, []);

  const handleRequestService = useCallback((serviceId: string) => {
    window.electronAPI.display?.requestService?.(serviceId);
  }, []);

  const handleDisplayLanguageChange = useCallback(async (nextLanguage: Language) => {
    setLang(nextLanguage);
    try {
      await window.electronAPI.saveConfig({ customerDisplayLanguage: nextLanguage });
    } catch (error) {
      rlog.error('[CustomerApp] Failed to save customer display language:', error);
    }
  }, []);

  // Determine if we have salon data (service categories populated = salon mode)
  const hasSalonData = (display?.serviceCategories?.length ?? 0) > 0;

  // Wrap touchable modes with a touch/click capture layer
  if (displayMode === 'promo') {
    return (
      <div onPointerDown={handleScreenTouch}>
        <PromoView
          images={display?.promoImages || []}
          intervalMs={display?.promoIntervalMs || 5000}
        />
      </div>
    );
  }

  if (displayMode === 'idle') {
    return (
      <div onPointerDown={handleScreenTouch}>
        <IdleView t={t} salonName={display?.salonName} />
      </div>
    );
  }

  if (displayMode === 'checkin') {
    return (
      <CheckInView
        t={t}
        language={lang}
        salonName={display?.salonName}
        categories={display?.serviceCategories || []}
        upsellItems={display?.upsellItems}
        onBrowseServices={handleBrowseServices}
        onBack={handleBackToIdle}
        onLanguageChange={handleDisplayLanguageChange}
      />
    );
  }

  if (displayMode === 'interactive') {
    // Use SalonInteractiveView when we have service categories, otherwise fallback
    if (hasSalonData) {
      return (
        <SalonInteractiveView
          t={t}
          language={lang}
          categories={display!.serviceCategories!}
          salonName={display?.salonName}
          onHome={handleBackToIdle}
          onReturnToCheckIn={handleBackToCheckIn}
          onBack={handleBackToIdle}
          onLanguageChange={handleDisplayLanguageChange}
        />
      );
    }
    // Fallback: simple idle-like interactive (legacy)
    return (
      <div className="min-h-screen bg-gradient-to-br from-rose-50 via-white to-amber-50 text-slate-900 flex items-center justify-center">
        <div className="text-center px-8">
          <h1 className="text-6xl font-bold mb-6 text-brand-600">
            {display?.salonName || t('customer.brandName')}
          </h1>
          <p className="text-3xl text-slate-500 mb-8 font-light">
            {t('customer.welcome')}
          </p>
        </div>
      </div>
    );
  }

  const paymentStatus = display?.paymentStatus;

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gradient-to-br from-white via-rose-50 to-amber-50 text-slate-900 flex items-center justify-center">
        {displayMode === 'cart' && state?.cart && (
          <>
            <CartView
              cart={state.cart}
              t={t}
              upsellItems={display?.upsellItems}
              onRequestService={handleRequestService}
            />
            {paymentStatus && (
              <div className="fixed bottom-0 inset-x-0 bg-brand-50 border-t border-brand-200 backdrop-blur-sm py-4 text-center animate-fadeIn">
                <div className="inline-flex items-center gap-3">
                  <div className="w-3 h-3 bg-brand-500 rounded-full animate-pulse" />
                  <span className="text-xl text-brand-700 font-medium">{paymentStatus}</span>
                </div>
              </div>
            )}
          </>
        )}
        {displayMode === 'thankyou' && (
          <ThankYouView
            lastOrderTotal={display?.lastOrderTotal}
            t={t}
            bookingUrl={display?.bookingUrl}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
