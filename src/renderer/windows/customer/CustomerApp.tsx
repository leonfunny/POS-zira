// Customer Display window entry point for the second-screen experience.
//
// State machine driven by PosStore broadcasts (src/main/pos/pos-store.ts):
//   idle / promo  -> IdleView / PromoView
//   checkin       -> CheckInView
//   interactive   -> SalonInteractiveView
//   cart          -> CartView
//   thankyou      -> ThankYouView
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PosState } from '../../hooks/usePosStore';
import { getTranslation, Language } from '../../i18n/translations';
import rlog from '../../utils/logger';
import CartView from './views/CartView';
import CheckInView from './views/CheckInView';
import IdleView from './views/IdleView';
import PromoView from './views/PromoView';
import SalonInteractiveView from './views/SalonInteractiveView';
import ThankYouView from './views/ThankYouView';
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
        <div className="flex h-screen items-center justify-center bg-gradient-to-br from-white via-rose-50 to-amber-50 text-slate-900">
          <div className="text-center">
            <h1 className="mb-4 text-4xl font-bold text-slate-900">Display Error</h1>
            <p className="mb-6 text-slate-500">{this.state.error?.message}</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="rounded-xl bg-brand-500 px-6 py-3 text-lg font-medium text-white transition-colors hover:bg-brand-600"
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

  useEffect(() => {
    const EDGE_BLOCK_PX = 20;
    const STAFF_ZONE_Y = 120;
    const STAFF_SWIPE_PX = 80;

    const onTouchStart = (event: TouchEvent) => {
      const touches = event.touches;

      if (touches.length >= 3) {
        const allInZone = Array.from(touches).every((touch) => touch.clientY < STAFF_ZONE_Y);
        if (allInZone) {
          staffGestureStartY.current = Array.from(touches).map((touch) => touch.clientY);
          event.preventDefault();
          return;
        }
      }

      staffGestureStartY.current = [];

      if (touches.length === 1) {
        const touch = touches[0];
        const nearTop = touch.clientY < EDGE_BLOCK_PX;
        const nearLeft = touch.clientX < EDGE_BLOCK_PX;
        const nearRight = touch.clientX > window.innerWidth - EDGE_BLOCK_PX;
        if (nearTop || nearLeft || nearRight) {
          event.preventDefault();
        }
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length >= 3 && staffGestureStartY.current.length >= 3) {
        event.preventDefault();
        const currentY = Array.from(event.touches).map((touch) => touch.clientY);
        const allMovedDown = currentY.every(
          (y, index) => y - (staffGestureStartY.current[index] ?? 0) >= STAFF_SWIPE_PX,
        );
        if (allMovedDown) {
          staffGestureStartY.current = [];
          void window.electronAPI.display?.close?.();
        }
      }
    };

    const onTouchEnd = () => {
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
    rlog.info('[CustomerApp] mount - subscribing to pos state');

    const unsubscribe = window.electronAPI.pos.onStateChanged((nextState: PosState) => {
      rlog.info(
        '[CustomerApp] state changed mode=',
        nextState?.display?.mode,
        'items=',
        nextState?.cart?.items?.length,
      );
      setState(nextState);
    });

    window.electronAPI.pos.getState().then((nextState: PosState | null) => {
      rlog.info(
        '[CustomerApp] initial state mode=',
        nextState?.display?.mode,
        'items=',
        nextState?.cart?.items?.length,
      );
      setState((prev) => prev ?? nextState);
    });

    window.electronAPI.getConfig().then((config: any) => {
      setLang(resolveCustomerDisplayLanguage(config));
    });

    return unsubscribe;
  }, []);

  const t = getTranslation(lang);
  const displayMode = state?.display?.mode || 'idle';
  const display = state?.display;
  const hasSalonData = (display?.serviceCategories?.length ?? 0) > 0;
  const paymentStatus = display?.paymentStatus;

  const handleScreenTouch = useCallback(() => {
    if (displayMode === 'idle' || displayMode === 'promo') {
      void window.electronAPI.display?.touch?.();
    }
  }, [displayMode]);

  const handleBrowseServices = useCallback(() => {
    void window.electronAPI.display?.browseServices?.();
  }, []);

  const handleBackToIdle = useCallback(() => {
    void window.electronAPI.display?.backToIdle?.();
  }, []);

  const handleBackToCheckIn = useCallback(() => {
    void window.electronAPI.display?.backToCheckin?.();
  }, []);

  const handleRequestService = useCallback((serviceId: string) => {
    void window.electronAPI.display?.requestService?.(serviceId);
  }, []);

  const handleDisplayLanguageChange = useCallback(async (nextLanguage: Language) => {
    setLang(nextLanguage);
    try {
      await window.electronAPI.saveConfig({ customerDisplayLanguage: nextLanguage });
    } catch (error) {
      rlog.error('[CustomerApp] Failed to save customer display language:', error);
    }
  }, []);

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

    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-rose-50 via-white to-amber-50 text-slate-900">
        <div className="px-8 text-center">
          <h1 className="mb-6 text-6xl font-bold text-brand-600">
            {display?.salonName || t('customer.brandName')}
          </h1>
          <p className="mb-8 text-3xl font-light text-slate-500">
            {t('customer.welcome')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-white via-rose-50 to-amber-50 text-slate-900">
        {displayMode === 'cart' && state?.cart && (
          <>
            <CartView
              cart={state.cart}
              t={t}
              upsellItems={display?.upsellItems}
              onRequestService={handleRequestService}
            />
            {paymentStatus && (
              <div className="fixed inset-x-0 bottom-0 border-t border-brand-200 bg-brand-50 py-4 text-center backdrop-blur-sm animate-fadeIn">
                <div className="inline-flex items-center gap-3">
                  <div className="h-3 w-3 animate-pulse rounded-full bg-brand-500" />
                  <span className="text-xl font-medium text-brand-700">{paymentStatus}</span>
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
