import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import rlog from './utils/logger';
import { AgentConfig, DeviceStatus, ConnectionStatus, AuthUser, FeatureKey, Tab, SIDEBAR_WIDTH } from '../shared/types';
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

// Default entitlements for when offline or not fetched yet
const DEFAULT_ENTITLEMENTS: Record<FeatureKey, boolean> = {
  chat: true,        // Always show chat
  status: true,      // Always enabled
  booksy: true,
  invoicing: true,   // Free feature
  orders: true,      // Order history — free
  products: true,    // Product/catalog management
  warehouse: true,   // Warehouse documents
  forecast: true,    // Forecast ordering
  settings: true,    // Always enabled
  debug: true,
  pos: true,         // Always show POS tab
  label: true,
  selfCheckout: true,
  billiard: true,    // POS-zira uses billiard offline/local, not only after server login
  remote: false,
  telegram: false,
  security: true,
  checkin: true,
  bookings: true,    // Dashboard-synced appointments
};

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

  // Hooks
  const { config, setConfig, updateConfig, saveConfig, refresh: refreshConfig } = useConfig();
  const { isAuthenticated, user: authUser, loading: authLoading, loginWithEmail, setAuthUser, logout, refresh: refreshAuth } = useAuth();
  const { state: remoteState, endSession } = useRemoteControl();
  const { entitlements, loading: entitlementsLoading, refresh: refreshEntitlements } = useEntitlements();
  const { visible: keyboardVisible, mode: keyboardMode, onKey, onBackspace, onDone } = useKeyboardManager();

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

  // Ensure activeTab is visible, otherwise switch to first visible tab
  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.includes(activeTab)) {
      setActiveTab(visibleTabs[0]);
    }
  }, [visibleTabs, activeTab]);

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

  // Clear renderer-side transient state (held orders, connection status)
  // Note: per-user cart (pos.activeCart.<userId>) is intentionally preserved
  // so it restores when the same user logs back in.
  const clearRendererState = useCallback(() => {
    try {
      window.localStorage.removeItem('pos.heldCarts');
    } catch {}
    setConnectionStatus({ connected: false });
    setDeviceStatus(null);
  }, []);

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
  const keyboardT = getTranslation(keyboardLanguage);

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
          style={{ paddingBottom: keyboardVisible ? '300px' : '0' }}
        >
          <POSLayout />
        </div>
        <TouchKeyboard
          visible={keyboardVisible}
          mode={keyboardMode}
          onKey={onKey}
          onBackspace={onBackspace}
          onDone={onDone}
          doneLabel={keyboardT('keyboard.done')}
          spaceLabel={keyboardT('keyboard.space')}
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

  const showGlobalKeyboard = keyboardVisible && activeTab !== 'checkin';

  return (
    <div key={sessionKey} className="h-screen flex flex-col overflow-hidden app-shell">
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
        />

        {/* Content */}
        <main
          className="flex-1 overflow-y-auto transition-[margin-left] duration-200"
          style={{
            marginLeft: sidebarCollapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded,
            paddingBottom: showGlobalKeyboard ? '300px' : '0',
          }}
        >
          {visibleTabs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
              <p className="text-sm text-slate-500">No features available. Contact your administrator.</p>
            </div>
          ) : (
            <div className={activeTab === 'pos' || activeTab === 'billiard' ? 'h-full' : 'p-4'}>
              {activeTab === 'pos' && isTabAvailable('pos') && <POSLayout onFullscreen={() => { setIsPosFullscreen(true); window.electronAPI.window.setKiosk(true); }} />}
              {activeTab === 'label' && isTabAvailable('label') && (
                <LabelModule language={posUiLanguage} />
              )}
              {activeTab === 'selfCheckout' && isTabAvailable('selfCheckout') && (
                <SelfCheckoutTab language={(config?.language as Language) || 'en'} />
              )}
              {activeTab === 'billiard' && isTabAvailable('billiard') && (
                <BilliardFloorPlan language={(config?.language as Language) || 'en'} />
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
                <OrdersTab language={(config?.language as Language) || 'en'} />
              )}
              {activeTab === 'products' && isTabAvailable('products') && (
                <ProductModule language={(config?.language as Language) || 'en'} />
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
      />
    </div>
  );
}
