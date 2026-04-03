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
        <div className="min-h-screen bg-black text-white flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-4xl font-bold mb-4">Display Error</h1>
            <p className="text-slate-400 mb-6">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg text-lg transition-colors"
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
    window.electronAPI.pos.getState().then(setState);
    const unsub = window.electronAPI.pos.onStateChanged(setState);

    // Load language from config
    window.electronAPI.getConfig().then((cfg: any) => {
      if (cfg?.language) setLang(cfg.language as Language);
    });

    return unsub;
  }, []);

  const t = getTranslation(lang);
  const displayMode = state?.display?.mode || 'idle';
  const display = state?.display;

  // Send touch event to main process for idle/promo modes
  const handleScreenTouch = useCallback(() => {
    if (displayMode === 'idle' || displayMode === 'promo') {
      window.electronAPI.display?.touch?.();
    }
  }, [displayMode]);

  // Handle service request from customer display
  const handleRequestService = useCallback((serviceId: string) => {
    window.electronAPI.display?.requestService?.(serviceId);
  }, []);

  // Handle browse services from check-in
  const handleBrowseServices = useCallback(() => {
    window.electronAPI.display?.browseServices?.();
  }, []);

  // Handle back to idle/promo from check-in
  const handleBackToIdle = useCallback(() => {
    window.electronAPI.display?.backToIdle?.();
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
        salonName={display?.salonName}
        onBrowseServices={handleBrowseServices}
        onBack={handleBackToIdle}
      />
    );
  }

  if (displayMode === 'interactive') {
    // Use SalonInteractiveView when we have service categories, otherwise fallback
    if (hasSalonData) {
      return (
        <SalonInteractiveView
          t={t}
          categories={display!.serviceCategories!}
          salonName={display?.salonName}
          onRequestService={handleRequestService}
        />
      );
    }
    // Fallback: simple idle-like interactive (legacy)
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 to-black text-white flex items-center justify-center">
        <div className="text-center px-8">
          <h1 className="text-6xl font-bold mb-6 bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            {display?.salonName || t('customer.brandName')}
          </h1>
          <p className="text-3xl text-slate-300 mb-8">
            {t('customer.welcome')}
          </p>
        </div>
      </div>
    );
  }

  const paymentStatus = display?.paymentStatus;

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        {displayMode === 'cart' && state?.cart && (
          <>
            <CartView
              cart={state.cart}
              t={t}
              upsellItems={display?.upsellItems}
              onRequestService={handleRequestService}
            />
            {paymentStatus && (
              <div className="fixed bottom-0 inset-x-0 bg-purple-900/90 backdrop-blur-sm py-4 text-center animate-fadeIn">
                <div className="inline-flex items-center gap-3">
                  <div className="w-3 h-3 bg-purple-400 rounded-full animate-pulse" />
                  <span className="text-xl text-white">{paymentStatus}</span>
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
