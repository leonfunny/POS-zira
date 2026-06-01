import React from 'react';
import {
  ShoppingCart,
  ScanBarcode,
  Tag,
  FileText,
  CalendarDays,
  ClipboardList,
  UserCheck,
  Bot,
  Activity,
  Shield,
  Settings,
  Bug,
  ChevronLeft,
  Maximize,
  LogOut,
  LayoutDashboard,
  Package,
  TrendingUp,
  Warehouse,
} from 'lucide-react';
import { Language, languageNames } from '../i18n/translations';
import { useTranslation } from '../i18n/useTranslation';
import { Tab, SIDEBAR_WIDTH } from '../../shared/types';

interface SidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  visibleTabs: Tab[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  connectionStatus: { connected: boolean };
  authUser: { email?: string; firstName?: string } | null;
  appVersion: string;
  onLogout: () => void;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  onFullscreen: () => void;
}

interface MenuItem {
  tab: Tab;
  icon: React.ReactNode;
  labelKey: string;
}

interface MenuGroup {
  labelKey: string;
  items: MenuItem[];
}

const MENU_GROUPS: MenuGroup[] = [
  {
    labelKey: 'sidebar.sales',
    items: [
      { tab: 'pos', icon: <ShoppingCart size={18} />, labelKey: 'sidebar.pos' },
      { tab: 'label', icon: <Tag size={18} />, labelKey: 'sidebar.label' },
      { tab: 'selfCheckout', icon: <ScanBarcode size={18} />, labelKey: 'sidebar.selfCheckout' },
      { tab: 'billiard', icon: <LayoutDashboard size={18} />, labelKey: 'sidebar.billiard' },
      { tab: 'orders', icon: <ClipboardList size={18} />, labelKey: 'sidebar.orders' },
      { tab: 'products', icon: <Package size={18} />, labelKey: 'sidebar.products' },
      { tab: 'warehouse', icon: <Warehouse size={18} />, labelKey: 'sidebar.warehouse' },
      { tab: 'forecast', icon: <TrendingUp size={18} />, labelKey: 'sidebar.forecast' },
      { tab: 'invoicing', icon: <FileText size={18} />, labelKey: 'sidebar.invoicing' },
    ],
  },
  {
    labelKey: 'sidebar.operations',
    items: [
      { tab: 'booksy', icon: <CalendarDays size={18} />, labelKey: 'sidebar.booksy' },
      { tab: 'bookings', icon: <CalendarDays size={18} />, labelKey: 'sidebar.bookings' },
      { tab: 'checkin', icon: <UserCheck size={18} />, labelKey: 'sidebar.checkin' },
    ],
  },
  {
    labelKey: 'sidebar.aiComms',
    items: [
      { tab: 'chat', icon: <Bot size={18} />, labelKey: 'sidebar.ziraAi' },
    ],
  },
  {
    labelKey: 'sidebar.system',
    items: [
      { tab: 'status', icon: <Activity size={18} />, labelKey: 'sidebar.status' },
      { tab: 'security', icon: <Shield size={18} />, labelKey: 'sidebar.security' },
      { tab: 'settings', icon: <Settings size={18} />, labelKey: 'sidebar.settings' },
      { tab: 'debug', icon: <Bug size={18} />, labelKey: 'sidebar.debug' },
    ],
  },
];

export default function Sidebar({
  activeTab,
  onTabChange,
  visibleTabs,
  collapsed,
  onToggleCollapse,
  connectionStatus,
  authUser,
  appVersion,
  onLogout,
  language,
  onLanguageChange,
  onFullscreen,
}: SidebarProps) {
  const { t } = useTranslation(language);

  return (
    <aside
      className={`sidebar fixed left-0 top-0 h-screen bg-white/90 backdrop-blur border-r border-[var(--sand-200)] z-40 flex flex-col overflow-hidden ${
        collapsed ? 'sidebar-collapsed' : ''
      }`}
      style={{ width: collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded }}
    >
      {/* Brand header */}
      {collapsed ? (
        <div className="h-14 flex items-center justify-center border-b border-[var(--sand-200)] shrink-0">
          <button
            onClick={onToggleCollapse}
            className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--primary)] to-[var(--primary-deep)] flex items-center justify-center hover:opacity-80 transition-opacity cursor-pointer"
            title={t('sidebar.expand')}
          >
            <span className="text-base font-bold text-white">Z</span>
          </button>
        </div>
      ) : (
        <div className="h-14 flex items-center gap-2.5 px-3 border-b border-[var(--sand-200)] shrink-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--primary)] to-[var(--primary-deep)] flex items-center justify-center shrink-0">
            <span className="text-base font-bold text-white">Z</span>
          </div>
          <span className="text-sm font-semibold tracking-[0.08em] text-[var(--ink)] whitespace-nowrap">
            ZIRA <span className="text-[var(--primary)]">-</span> AI
          </span>
          <button
            onClick={onToggleCollapse}
            className="ml-auto p-1 rounded hover:bg-[var(--sand-100)] text-[var(--ink-muted)] transition-colors shrink-0"
            title={t('sidebar.collapse')}
          >
            <ChevronLeft size={16} />
          </button>
        </div>
      )}

      {/* Menu groups */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        {MENU_GROUPS.map((group, gi) => {
          const visibleItems = group.items.filter((item) => visibleTabs.includes(item.tab));
          if (visibleItems.length === 0) return null;

          return (
            <div key={gi}>
              {/* Group header or separator */}
              {collapsed ? (
                <div className="mx-3 my-2 border-t border-[var(--sand-200)]" />
              ) : (
                <div className="text-[10px] uppercase tracking-[0.15em] text-slate-400 px-4 pt-4 pb-1 select-none">
                  {t(group.labelKey)}
                </div>
              )}

              {/* Items */}
              {visibleItems.map((item) => {
                const isActive = activeTab === item.tab;
                const label = t(item.labelKey);

                return (
                  <div key={item.tab} className="flex items-center">
                    <button
                      onClick={() => onTabChange(item.tab)}
                      data-tooltip={label}
                      className={`sidebar-item flex items-center gap-2.5 w-full text-left text-sm transition-colors ${
                        collapsed ? 'px-0 justify-center py-2.5 mx-1 rounded-lg' : 'px-4 py-2'
                      } ${
                        isActive
                          ? collapsed
                            ? 'bg-[var(--primary)]/10 text-[var(--primary-deep)]'
                            : 'bg-[var(--primary)]/10 border-l-[3px] border-[var(--primary)] text-[var(--primary-deep)] pl-[13px]'
                          : 'text-[var(--ink-muted)] hover:bg-[var(--sand-100)] hover:text-[var(--ink)]'
                      }`}
                    >
                      <span className="shrink-0">{item.icon}</span>
                      {!collapsed && <span className="truncate">{label}</span>}
                    </button>

                    {/* Fullscreen button for POS */}
                    {item.tab === 'pos' && isActive && !collapsed && (
                      <button
                        onClick={onFullscreen}
                        className="p-1.5 mr-2 rounded text-[var(--ink-muted)] hover:text-[var(--primary)] hover:bg-[var(--sand-100)] transition-colors shrink-0"
                        title={t('sidebar.fullscreen')}
                      >
                        <Maximize size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--sand-200)] shrink-0">
        {/* Connection status */}
        <div className={`flex items-center gap-2 px-3 py-2 text-xs ${collapsed ? 'justify-center' : ''}`}>
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              connectionStatus.connected ? 'bg-[var(--success)]' : 'bg-slate-400'
            }`}
          />
          {!collapsed && (
            <span className="text-[var(--ink-muted)] truncate">
              {connectionStatus.connected ? t('sidebar.connected') : t('sidebar.disconnected')}
            </span>
          )}
        </div>

        {/* Language selector */}
        {!collapsed && (
          <div className="px-3 pb-1.5">
            <select
              value={language}
              onChange={(e) => onLanguageChange(e.target.value as Language)}
              className="w-full text-xs bg-white border border-[var(--sand-200)] rounded-lg px-2 py-1.5 text-[var(--ink-muted)] cursor-pointer hover:bg-[var(--sand-50)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
            >
              {(Object.keys(languageNames) as Language[]).map((lang) => (
                <option key={lang} value={lang}>{languageNames[lang]}</option>
              ))}
            </select>
          </div>
        )}

        {/* User + sign out */}
        <div className={`flex items-center gap-2 px-3 py-2 ${collapsed ? 'justify-center' : ''}`}>
          {!collapsed && (
            <span className="text-xs text-[var(--ink-muted)] truncate flex-1">
              {authUser?.email || authUser?.firstName || '...'}
            </span>
          )}
          <button
            onClick={onLogout}
            className="sidebar-item p-1.5 rounded text-[var(--ink-muted)] hover:text-[var(--error)] hover:bg-red-50 transition-colors shrink-0"
            data-tooltip={t('sidebar.signOut')}
            title={t('sidebar.signOut')}
          >
            <LogOut size={14} />
          </button>
        </div>

        {/* Version */}
        {!collapsed && (
          <div className="px-3 pb-2 text-[10px] text-slate-400">
            v{appVersion}
          </div>
        )}
      </div>
    </aside>
  );
}
