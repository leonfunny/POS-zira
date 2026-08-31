import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import rlog from './utils/logger';
import { AgentConfig, DeviceStatus, ConnectionStatus, AuthUser, FeatureKey, Tab, SIDEBAR_WIDTH, DEFAULT_ENTITLEMENTS } from '../shared/types';
import Status from './components/Status';
import Settings from './components/Settings';
import Debug from './components/Debug';
import RemoteIndicator from './components/RemoteIndicator';
import Chat from './components/Chat';
import BooksySyncTab from './components/BooksySync';
import AuthScreen from './components/AuthScreen';
import InvoicingTab from './components/invoicing/InvoicingTab';
import OrdersTab from './components/OrdersTab';
import ProductModule from './components/products/ProductModule';
import LabelModule from './components/label/LabelModule';
import type { PosMode } from '../shared/types';
import WarehouseModule from './components/warehouse/WarehouseModule';
import ForecastOrderingTab from './components/forecast/ForecastOrderingTab';
import SecurityTab from './components/security/SecurityTab';
import CheckinWizard from './components/checkin/CheckinWizard';
import BookingsTodayScreen from './components/booking/BookingsTodayScreen';
import POSLayout from './components/pos/POSLayout';
import SelfCheckoutTab from './components/SelfCheckoutTab';
import BilliardFloorPlan from './components/billiard/BilliardFloorPlan';
import Sidebar from './components/Sidebar';
import TouchKeyboard from './components/shared/TouchKeyboard';
import { getTranslation, Language } from './i18n/translations';
import { useConfig } from './hooks/useConfig';
import { useAuth } from './hooks/useAuth';
import { useRemoteControl } from './hooks/useRemoteControl';
import { useEntitlements } from './hooks/useEntitlements';
import { useKeyboardManager } from './hooks/useKeyboardManager';
import { resetProductAdminCapabilitiesCache, useProductAdminCapabilities } from './hooks/useProductAdminCapabilities';
import type { BilliardPaymentIntent, RestoredCartReconciliation } from '../shared/billiard-pos-handoff';

// DEFAULT_ENTITLEMENTS now comes from shared/types — single source shared
// with the main process (the two copies used to diverge: pos true here,
// pos false there → blank/hidden POS depending on auth path).

// Tab to feature key mapping
const TAB_TO_FEATURE: Record<Tab, FeatureKey> = {
  pos: 'pos',
  label: 'label',
  selfCheckout: 'selfCheckout',
  billiard: 'billiard',
  chat: 'chat',
  status: 'status',
  booksy: 'booksy',
  checkin: 'checkin',
  bookings: 'bookings',
  invoicing: 'invoicing',
  orders: 'orders',
  products: 'products',
  warehouse: 'warehouse',
  forecast: 'forecast',
  security: 'security',
  settings: 'settings',
  debug: 'debug',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('checkin');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
  });
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [isPosFullscreen, setIsPosFullscreen] = useState(false);
  const [isCheckinFullscreen, setIsCheckinFullscreen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [touchKeyboardHeight, setTouchKeyboardHeight] = useState(0);
  const [productEditRequest, setProductEditRequest] = useState<{ variantId: string; returnTo: Tab } | null>(null);
  // Latches on the first billiard visit so venues that never open the tab pay
  // nothing for it, while everyone who uses it gets an instant tab switch.
  const [billiardVisited, setBilliardVisited] = useState(false);
  const [billiardPaymentIntent, setBilliardPaymentIntent] = useState<BilliardPaymentIntent | null>(null);
  const [restoredCartReconciliation, setRestoredCartReconciliation] = useState<RestoredCartReconciliation | null>(null);
  const billiardRecoveryKeyRef = useRef<string | null>(null);
  const billiardAsyncGenerationRef = useRef(0);
  const rendererAuthBoundaryRef = useRef<string | null>(null);

  // Hooks
  const { config, setConfig, updateConfig, saveConfig, refresh: refreshConfig } = useConfig();
  const { isAuthenticated, user: authUser, loading: authLoading, loginWithEmail, setAuthUser, logout, refresh: refreshAuth } = useAuth();
  const { state: remoteState, endSession } = useRemoteControl();
  const { entitlements, loading: entitlementsLoading, refresh: refreshEntitlements } = useEntitlements();
  const { visible: keyboardVisible, mode: keyboardMode, onKey, onBackspace, onDone } = useKeyboardManager();
  const { capabilities: productAdminCapabilities } = useProductAdminCapabilities(isAuthenticated);

  const rendererAuthBoundaryKey = isAuthenticated
    ? `${authUser?.id || ''}:${config?.salonId || authUser?.salonId || ''}:${(config as any)?.registerCode || config?.machineId || config?.agentId || ''}`
    : 'anonymous';
  useEffect(() => {
    if (rendererAuthBoundaryRef.current === rendererAuthBoundaryKey) return;
    rendererAuthBoundaryRef.current = rendererAuthBoundaryKey;
    billiardAsyncGenerationRef.current += 1;
    billiardRecoveryKeyRef.current = null;
    setBilliardPaymentIntent(null);
    setRestoredCartReconciliation(null);
  }, [rendererAuthBoundaryKey]);

  // Kiosk swipe-to-exit (must be top-level — used inside conditional render blocks below)
  const swipeTouchStartY = useRef<number | null>(null);
  const exitCheckinKiosk = useCallback(() => {
    setIsCheckinFullscreen(false);
    window.electronAPI.window.setKiosk(false);
  }, []);
  const exitPosKiosk = useCallback(() => {
    setIsPosFullscreen(false);
    window.electronAPI.window.setKiosk(false);
  }, []);

  const loading = authLoading || entitlementsLoading;

  // Sync sidebar collapsed state from config on load
  useEffect(() => {
    if (config?.sidebarCollapsed !== undefined) {
      setSidebarCollapsed(config.sidebarCollapsed);
    }
  }, [config?.sidebarCollapsed]);

  // Check if a feature is enabled
  const isFeatureEnabled = useCallback((feature: FeatureKey): boolean => {
    if (!entitlements) {
      return DEFAULT_ENTITLEMENTS[feature];
    }
    const entitlement = entitlements.features[feature];
    if (!entitlement) return DEFAULT_ENTITLEMENTS[feature];
    if (!entitlement.enabled) return false;
    if (entitlement.expiresAt) {
      const now = new Date();
      const expiry = new Date(entitlement.expiresAt);
      if (now > expiry) return false;
    }
    return true;
  }, [entitlements]);

  // Get visible tabs. Local module overrides (Settings → Module Manager) win
  // over plan entitlements: an explicit `true`/`false` for a tab forces it
  // shown/hidden on THIS device regardless of plan. With no explicit choice we
  // fall back to the entitlement default (and any legacy hiddenTabs flag).
  // `settings` is always visible so the user can never lock themselves out.
  const visibleTabs = useMemo((): Tab[] => {
    const allTabs: Tab[] = ['pos', 'label', 'selfCheckout', 'billiard', 'chat', 'status', 'booksy', 'checkin', 'bookings', 'invoicing', 'orders', 'products', 'warehouse', 'forecast', 'security', 'settings', 'debug'];
    const overrides = (config?.moduleOverrides ?? {}) as Partial<Record<Tab, boolean>>;
    const hiddenTabs: Tab[] = (config?.hiddenTabs as Tab[]) ?? [];
    return allTabs.filter(tab => {
      if (tab === 'settings') return true;
      const override = overrides[tab];
      if (typeof override === 'boolean') return override;
      return isFeatureEnabled(TAB_TO_FEATURE[tab]) && !hiddenTabs.includes(tab);
    });
  }, [isFeatureEnabled, config?.moduleOverrides, config?.hiddenTabs]);

  // Single source of truth for whether a tab's CONTENT may render. Must match
  // the sidebar (visibleTabs) exactly: Module Manager overrides win over plan
  // entitlements. Gating content on isFeatureEnabled alone renders a blank
  // page for any tab force-enabled via Settings → Module Manager (the sidebar
  // shows the tab but its body never mounts).
  const isTabAvailable = useCallback((tab: Tab): boolean => visibleTabs.includes(tab), [visibleTabs]);

  const handlePayBilliardInPos = useCallback(async (input: { posCheckout: any; tableName?: string | null }) => {
    if (!visibleTabs.includes('pos')) {
      throw new Error('Enable the POS module on this register before handing off a Billiard payment.');
    }
    const generation = ++billiardAsyncGenerationRef.current;
    const result = await window.electronAPI.pos.billiardCheckout.prepare(input);
    if (generation !== billiardAsyncGenerationRef.current) {
      throw new Error('The signed-in POS user changed while the Billiard checkout was being prepared.');
    }
    if (!result?.success || !result.intent) {
      throw new Error(result?.error || result?.durabilityError || 'Could not prepare the frozen Billiard cart in POS.');
    }
    setBilliardPaymentIntent(result.intent as BilliardPaymentIntent);
    setActiveTab('pos');
  }, [visibleTabs]);

  const handlePreflightBilliardInPos = useCallback(async () => {
    if (!visibleTabs.includes('pos')) {
      throw new Error('Enable the POS module on this register before ending the Billiard session.');
    }
    const result = await window.electronAPI.pos.billiardCheckout.preflight();
    if (!result?.success) {
      throw new Error(result?.error || 'POS cannot safely accept this Billiard payment yet.');
    }
  }, [visibleTabs]);

  // Crash/login recovery is scoped by the authenticated user and configured
  // register. Main will only return an intent after it has activated the exact
  // frozen cart (or verified that its local order is already committed).
  useEffect(() => {
    if (!isAuthenticated || authLoading || !visibleTabs.includes('pos')) return;
    const recoveryKey = `${authUser?.id || ''}:${config?.salonId || authUser?.salonId || ''}:${(config as any)?.registerCode || config?.machineId || config?.agentId || ''}`;
    if (!recoveryKey || billiardRecoveryKeyRef.current === recoveryKey) return;
    billiardRecoveryKeyRef.current = recoveryKey;
    const generation = ++billiardAsyncGenerationRef.current;
    let cancelled = false;
    void window.electronAPI.pos.billiardCheckout.recover().then((result: {
      success: boolean;
      intent?: BilliardPaymentIntent;
      restoredCartReconciliation?: RestoredCartReconciliation;
      error?: string;
      durabilityError?: string;
    }) => {
      if (cancelled || generation !== billiardAsyncGenerationRef.current) return;
      setRestoredCartReconciliation(result?.restoredCartReconciliation ?? null);
      if (result?.restoredCartReconciliation) setActiveTab('pos');
      if (!result?.success) {
        rlog.warn(`[App] Billiard POS recovery deferred: ${result?.error || 'unknown error'}`);
        return;
      }
      setBilliardPaymentIntent(result.intent ? result.intent as BilliardPaymentIntent : null);
      if (result.intent) {
        setActiveTab('pos');
      }
    }).catch((err: unknown) => {
      if (cancelled || generation !== billiardAsyncGenerationRef.current) return;
      rlog.warn('[App] Billiard POS recovery failed:', err);
    });
    return () => {
      cancelled = true;
      if (generation === billiardAsyncGenerationRef.current) {
        billiardAsyncGenerationRef.current += 1;
      }
    };
  }, [authLoading, authUser?.id, authUser?.salonId, config?.agentId, config?.machineId, (config as any)?.registerCode, config?.salonId, isAuthenticated, visibleTabs]);

  // Ensure activeTab is visible, otherwise switch to first visible tab
  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.includes(activeTab)) {
      setActiveTab(visibleTabs[0]);
    }
  }, [visibleTabs, activeTab]);

  useEffect(() => {
    if (activeTab === 'billiard') setBilliardVisited(true);
  }, [activeTab]);

  // Load connection/device status on mount
  useEffect(() => {
    async function loadStatus() {
      try {
        const statusData = await window.electronAPI.getStatus();
        setConnectionStatus({ connected: statusData.connected });
        setDeviceStatus(statusData.deviceStatus);
      } catch (err: any) {
        rlog.error('[App] Failed to load status:', err);
        setInitError(err.message || 'Failed to load application data');
      }
    }
    loadStatus();
  }, []);

  // Subscribe to connection/device events
  useEffect(() => {
    const unsubConnection = window.electronAPI.onConnectionStatus((status: any) => {
      setConnectionStatus(status);
    });

    const unsubDevice = window.electronAPI.onDeviceStatus((status: any) => {
      setDeviceStatus(status);
    });

    return () => {
      unsubConnection?.();
      unsubDevice?.();
    };
  }, []);

  // Ctrl+Shift+Q to exit kiosk mode (hidden from customers)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Q' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        if (isCheckinFullscreen) exitCheckinKiosk();
        if (isPosFullscreen) exitPosKiosk();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCheckinFullscreen, isPosFullscreen, exitCheckinKiosk, exitPosKiosk]);

  // Ctrl+B sidebar toggle
  const handleToggleSidebar = useCallback(async () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      await saveConfig({ sidebarCollapsed: next });
    } catch (err) {
      rlog.error('[App] Failed to save sidebar state:', err);
    }
  }, [sidebarCollapsed, saveConfig]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'b' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleToggleSidebar();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleToggleSidebar]);

  const handleConnect = async () => {
    try {
      await window.electronAPI.connect();
    } catch (err: any) {
      rlog.error('[App] Failed to connect:', err);
    }
  };

  const handleDisconnect = async () => {
    try {
      await window.electronAPI.disconnect();
    } catch (err: any) {
      rlog.error('[App] Failed to disconnect:', err);
    }
  };

  const handleEndRemoteSession = async () => {
    try {
      await endSession('User ended session');
    } catch (err: any) {
      rlog.error('[App] Failed to end remote session:', err);
    }
  };

  const handleLoginSuccess = async (user: AuthUser) => {
    resetProductAdminCapabilitiesCache();
    setAuthUser(user);
    // Reload status, config, and entitlements after login
    try {
      const [statusData] = await Promise.all([
        window.electronAPI.getStatus(),
        refreshConfig(),
        refreshEntitlements(),
      ]);
      setConnectionStatus({ connected: statusData.connected });
      setDeviceStatus(statusData.deviceStatus);
    } catch (err) {
      rlog.error('[App] Failed to load post-login data:', err);
    }
  };

  // Clear renderer-side transient state (connection status only). Legacy
  // held carts are removed solely after their durable SQLite import succeeds.
  // Note: per-user cart (pos.activeCart.<userId>) is intentionally preserved
  // so it restores when the same user logs back in.
  const clearRendererState = useCallback(() => {
    resetProductAdminCapabilitiesCache();
    billiardAsyncGenerationRef.current += 1;
    billiardRecoveryKeyRef.current = null;
    setBilliardPaymentIntent(null);
    setRestoredCartReconciliation(null);
    setProductEditRequest(null);
    setConnectionStatus({ connected: false });
    setDeviceStatus(null);
  }, []);

  // Both halves must hold. `canUpdateProduct` comes from the backend role;
  // `visibleTabs` comes from plan entitlements + Module Manager overrides — they
  // move independently. Gating on the capability alone renders a pencil that
  // calls setActiveTab('products'), which the "ensure activeTab is visible"
  // effect above then bounces to visibleTabs[0]: the operator is thrown onto an
  // unrelated tab having edited nothing.
  const canEditProductsFromSale = productAdminCapabilities?.canUpdateProduct === true
    && visibleTabs.includes('products');

  const requestProductEdit = useCallback((variantId: string, returnTo: Tab) => {
    if (!variantId || !canEditProductsFromSale) return;
    setProductEditRequest({ variantId, returnTo });
    setActiveTab('products');
  }, [canEditProductsFromSale]);

  const requestPosProductEdit = useCallback((variantId: string) => {
    if (!variantId || !canEditProductsFromSale) return;
    if (isPosFullscreen) {
      exitPosKiosk();
    }
    requestProductEdit(variantId, 'pos');
  }, [canEditProductsFromSale, exitPosKiosk, isPosFullscreen, requestProductEdit]);

  const exitProductEdit = useCallback(() => {
    const returnTo = productEditRequest?.returnTo;
    setProductEditRequest(null);
    if (returnTo) setActiveTab(returnTo);
  }, [productEditRequest]);

  useEffect(() => {
    if (activeTab !== 'products' && productEditRequest) setProductEditRequest(null);
  }, [activeTab, productEditRequest]);

  const handleLogout = async () => {
    try {
      clearRendererState();
      await logout();
      // Refresh config so Settings/Status tabs pick up cleared values
      await refreshConfig();
    } catch (err: any) {
      rlog.error('[App] Failed to logout:', err);
    }
  };

  const handleOfflineMode = async () => {
    // Clear any previous salon data to prevent data leakage from prior logins
    try {
      clearRendererState();
      await logout();
      await window.electronAPI.changeSalon();
      // Seed demo products/categories so offline mode isn't blank
      await window.electronAPI.pos.seedDemo();
      await refreshConfig();
    } catch (err: any) {
      rlog.warn('[App] Offline mode setup failed (non-critical):', err);
    }
    setAuthUser({
      id: 'offline',
      email: 'offline@local',
      firstName: 'Offline',
      lastName: 'Mode',
      role: 'OWNER',
      salonId: 'offline-salon',
      salonName: 'Offline Mode',
    });
  };

  const handleLanguageChange = async (lang: Language) => {
    try {
      await saveConfig({ language: lang });
    } catch (err) {
      rlog.error('[App] Failed to save language:', err);
    }
  };

  // Key forces full component tree remount when user identity changes
  // (e.g., logout → offline mode, or switching accounts), clearing all
  // in-memory state: cart, products, connection status, etc.
  const sessionKey = authUser?.id || 'anon';
  const appLanguage = (config?.language || 'en') as Language;
  const posUiLanguage = (config?.posLanguage || config?.language || 'en') as Language;
  const keyboardLanguage = (activeTab === 'pos' || activeTab === 'label') ? posUiLanguage : appLanguage;
  const appT = getTranslation(appLanguage);
  const keyboardT = getTranslation(keyboardLanguage);
  const tOrApp = useCallback((key: string, fallback: string) => {
    const value = appT(key);
    return value && value !== key ? value : fallback;
  }, [appT]);
  const productEditBackLabel = productEditRequest?.returnTo === 'orders'
    ? tOrApp('products.backToOrder', 'Back to order')
    : tOrApp('products.backToCart', 'Back to cart');
  const showGlobalKeyboard = keyboardVisible && activeTab !== 'checkin';
  const globalKeyboardInset = showGlobalKeyboard ? touchKeyboardHeight : 0;
  const posFullscreenKeyboardInset = keyboardVisible ? touchKeyboardHeight : 0;
  const keyboardInsetStyle = useCallback((keyboardInset: number): React.CSSProperties => ({
    '--touch-keyboard-inset': `${keyboardInset}px`,
  } as React.CSSProperties), []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
        <p className="text-sm text-slate-500">Loading...</p>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 p-8">
        <div className="text-red-500 text-4xl">!</div>
        <h1 className="text-lg font-semibold text-slate-800">Initialization error</h1>
        <p className="text-sm text-slate-500 text-center">{initError}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700"
        >
          Try again
        </button>
        <p className="text-xs text-slate-400 mt-4">
          Press F12 to open DevTools and see details.
        </p>
      </div>
    );
  }

  // Show login screen if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-50">
        <AuthScreen onLoginSuccess={handleLoginSuccess} onOfflineMode={handleOfflineMode} />
      </div>
    );
  }

  // Fullscreen POS mode — kiosk-style, same exit mechanism as checkin
  // Exit via 3-finger swipe down from top (≥150px) or Ctrl+Shift+Q
  if (isPosFullscreen && activeTab === 'pos' && isTabAvailable('pos')) {
    return (
      <div
        key={sessionKey}
        className="h-screen w-screen flex flex-col select-none"
        style={keyboardInsetStyle(posFullscreenKeyboardInset)}
        onTouchStart={(e) => {
          if (e.touches.length === 3 && e.touches[0].clientY <= 80) {
            swipeTouchStartY.current = e.touches[0].clientY;
          } else {
            swipeTouchStartY.current = null;
          }
        }}
        onTouchEnd={(e) => {
          if (swipeTouchStartY.current === null) return;
          const endY = e.changedTouches[0].clientY;
          if (endY - swipeTouchStartY.current >= 150) exitPosKiosk();
          swipeTouchStartY.current = null;
        }}
      >
        <div
          className="flex-1 overflow-y-auto"
          style={{ paddingBottom: posFullscreenKeyboardInset > 0 ? `${posFullscreenKeyboardInset}px` : '0' }}
        >
          <POSLayout
            onEditProduct={canEditProductsFromSale ? requestPosProductEdit : undefined}
            billiardPaymentIntent={billiardPaymentIntent}
            restoredCartReconciliation={restoredCartReconciliation}
            canResolveUncertainTender={String(authUser?.role || '').toUpperCase() === 'OWNER'}
            onBilliardTenderResolved={(intent) => {
              setBilliardPaymentIntent(intent);
              setRestoredCartReconciliation(null);
            }}
            onRestoredTenderResolved={() => setRestoredCartReconciliation(null)}
            onRestoredCartTenderOutcomeUncertain={(reconciliation) => {
              setRestoredCartReconciliation(reconciliation);
              setActiveTab('pos');
            }}
            onBilliardPaymentIntentConsumed={(nonce) => {
              setBilliardPaymentIntent((current) => current?.nonce === nonce ? null : current);
            }}
          />
        </div>
        <TouchKeyboard
          visible={keyboardVisible}
          mode={keyboardMode}
          onKey={onKey}
          onBackspace={onBackspace}
          onDone={onDone}
          doneLabel={keyboardT('keyboard.done')}
          spaceLabel={keyboardT('keyboard.space')}
          onHeightChange={setTouchKeyboardHeight}
        />
      </div>
    );
  }

  // Fullscreen check-in mode — hide all chrome for customer-facing use
  // Exit via 3-finger swipe down from top (≥150px) or Ctrl+Shift+Q
  if (isCheckinFullscreen && isTabAvailable('checkin')) {
    return (
      <div
        key={sessionKey}
        className="h-screen w-screen bg-slate-50 p-4 select-none"
        onTouchStart={(e) => {
          if (e.touches.length === 3 && e.touches[0].clientY <= 80) {
            swipeTouchStartY.current = e.touches[0].clientY;
          } else {
            swipeTouchStartY.current = null;
          }
        }}
        onTouchEnd={(e) => {
          if (swipeTouchStartY.current === null) return;
          const endY = e.changedTouches[0].clientY;
          if (endY - swipeTouchStartY.current >= 150) exitCheckinKiosk();
          swipeTouchStartY.current = null;
        }}
      >
        {/* Kiosk mode: no visible UI chrome — staff exits via 3-finger swipe or Ctrl+Shift+Q */}
        <CheckinWizard />
      </div>
    );
  }

  return (
    <div
      key={sessionKey}
      className="h-screen flex flex-col overflow-hidden app-shell"
      style={keyboardInsetStyle(globalKeyboardInset)}
    >
      {/* Remote Control Indicator */}
      <RemoteIndicator
        remoteState={remoteState}
        onEndSession={handleEndRemoteSession}
      />

      {/* Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          visibleTabs={visibleTabs}
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          connectionStatus={connectionStatus}
          authUser={authUser}
          appVersion={deviceStatus?.appVersion || '1.0.0'}
          onLogout={handleLogout}
          language={(config?.language as Language) || 'en'}
          onLanguageChange={handleLanguageChange}
          onFullscreen={() => { setIsPosFullscreen(true); window.electronAPI.window.setKiosk(true); }}
          salonName={config?.salonName || authUser?.salonName}
          salonCode={config?.salonCode}
        />

        {/* Content */}
        <main
          className="flex-1 overflow-y-auto transition-[margin-left] duration-200"
          style={{
            marginLeft: sidebarCollapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded,
            paddingBottom: globalKeyboardInset > 0 ? `${globalKeyboardInset}px` : '0',
          }}
        >
          {visibleTabs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
              <p className="text-sm text-slate-500">No features available. Contact your administrator.</p>
            </div>
          ) : (
            <div className={activeTab === 'pos' || activeTab === 'billiard' ? 'h-full' : 'p-4'}>
              {activeTab === 'pos' && isTabAvailable('pos') && (
                <POSLayout
                  onFullscreen={() => { setIsPosFullscreen(true); window.electronAPI.window.setKiosk(true); }}
                  onEditProduct={canEditProductsFromSale ? requestPosProductEdit : undefined}
                  billiardPaymentIntent={billiardPaymentIntent}
                  restoredCartReconciliation={restoredCartReconciliation}
                  canResolveUncertainTender={String(authUser?.role || '').toUpperCase() === 'OWNER'}
                  onBilliardTenderResolved={(intent) => {
                    setBilliardPaymentIntent(intent);
                    setRestoredCartReconciliation(null);
                  }}
                  onRestoredTenderResolved={() => setRestoredCartReconciliation(null)}
                  onRestoredCartTenderOutcomeUncertain={(reconciliation) => {
                    setRestoredCartReconciliation(reconciliation);
                    setActiveTab('pos');
                  }}
                  onBilliardPaymentIntentConsumed={(nonce) => {
                    setBilliardPaymentIntent((current) => current?.nonce === nonce ? null : current);
                  }}
                />
              )}
              {activeTab === 'label' && isTabAvailable('label') && (
                <LabelModule language={posUiLanguage} posMode={config?.posMode as PosMode | undefined} />
              )}
              {activeTab === 'selfCheckout' && isTabAvailable('selfCheckout') && (
                <SelfCheckoutTab language={(config?.language as Language) || 'en'} />
              )}
              {/* Mounted on first visit and kept mounted afterwards: tearing the
                  floor plan down on every tab switch made it re-fetch auth,
                  re-derive its locked view and remount its zoom canvas, which
                  is what flickered the toolbar and the tables on re-entry. */}
              {billiardVisited && isTabAvailable('billiard') && (
                <div className={activeTab === 'billiard' ? 'h-full' : 'hidden'}>
                  <BilliardFloorPlan
                    active={activeTab === 'billiard'}
                    language={(config?.language as Language) || 'en'}
                    onPreflightPos={handlePreflightBilliardInPos}
                    onPayInPos={handlePayBilliardInPos}
                  />
                </div>
              )}
              {activeTab === 'chat' && isTabAvailable('chat') && (
                <Chat language={(config?.language as Language) || 'en'} />
              )}
              {activeTab === 'status' && isTabAvailable('status') && (
                <Status
                  config={config}
                  connectionStatus={connectionStatus}
                  deviceStatus={deviceStatus}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                  onConfigChange={(newConfig) => setConfig(newConfig as AgentConfig)}
                />
              )}
              {activeTab === 'booksy' && isTabAvailable('booksy') && <BooksySyncTab />}
              {activeTab === 'checkin' && isTabAvailable('checkin') && <CheckinWizard onFullscreen={() => { setIsCheckinFullscreen(true); window.electronAPI.window.setKiosk(true); }} />}
              {activeTab === 'bookings' && isTabAvailable('bookings') && <BookingsTodayScreen />}
              {activeTab === 'invoicing' && isTabAvailable('invoicing') && (
                <InvoicingTab language={(config?.language as Language) || 'en'} />
              )}
              {activeTab === 'orders' && isTabAvailable('orders') && (
                <OrdersTab
                  language={(config?.language as Language) || 'en'}
                  onEditProduct={canEditProductsFromSale ? (variantId) => requestProductEdit(variantId, 'orders') : undefined}
                />
              )}
              {activeTab === 'products' && isTabAvailable('products') && (
                <ProductModule
                  language={(config?.language as Language) || 'en'}
                  openVariantId={productEditRequest?.variantId}
                  onExitExternal={exitProductEdit}
                  externalBackLabel={productEditBackLabel}
                />
              )}
              {activeTab === 'warehouse' && isTabAvailable('warehouse') && (
                <WarehouseModule language={(config?.language as Language) || 'en'} />
              )}
              {activeTab === 'forecast' && isTabAvailable('forecast') && (
                <ForecastOrderingTab language={(config?.language as Language) || 'en'} />
              )}
              {activeTab === 'security' && isTabAvailable('security') && (
                <SecurityTab config={config} />
              )}
              {activeTab === 'settings' && isTabAvailable('settings') && (
                <Settings
                  config={config}
                  onConfigChange={updateConfig}
                  isModuleEntitled={(tab: Tab) => isFeatureEnabled(TAB_TO_FEATURE[tab])}
                />
              )}
              {activeTab === 'debug' && isTabAvailable('debug') && <Debug />}
            </div>
          )}
        </main>
      </div>

      {/* Global touch keyboard — all tabs except checkin (which has its own) */}
      <TouchKeyboard
        visible={showGlobalKeyboard}
        mode={keyboardMode}
        onKey={onKey}
        onBackspace={onBackspace}
        onDone={onDone}
        doneLabel={keyboardT('keyboard.done')}
        spaceLabel={keyboardT('keyboard.space')}
        onHeightChange={setTouchKeyboardHeight}
      />
    </div>
  );
}
