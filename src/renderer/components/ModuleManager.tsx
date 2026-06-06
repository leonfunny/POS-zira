import React from 'react';
import { RotateCcw, Lock } from 'lucide-react';
import { AgentConfig, Tab } from '../../shared/types';
import { MENU_GROUPS } from './Sidebar';

interface ModuleManagerProps {
  config: AgentConfig | null;
  onConfigChange: (config: Partial<AgentConfig>) => void | Promise<any>;
  /** Plan/entitlement default for a tab (true = in plan). */
  isModuleEntitled?: (tab: Tab) => boolean;
  t: (key: string) => string;
}

/** Settings is the escape hatch — never hideable, or the user locks themselves out. */
const ALWAYS_ON: Tab[] = ['settings'];

/**
 * Module Manager — lists every module and lets the cashier show/hide it on THIS
 * device. Local-only: writes `config.moduleOverrides`, never touches the salon
 * plan. An explicit choice overrides the plan entitlement (can force-show a
 * module the plan does not include); with no choice we fall back to the plan.
 */
export default function ModuleManager({ config, onConfigChange, isModuleEntitled, t }: ModuleManagerProps) {
  const overrides = (config?.moduleOverrides ?? {}) as Partial<Record<Tab, boolean>>;

  const isEntitled = (tab: Tab): boolean => (isModuleEntitled ? isModuleEntitled(tab) : true);

  const effectiveEnabled = (tab: Tab): boolean => {
    if (ALWAYS_ON.includes(tab)) return true;
    const override = overrides[tab];
    return typeof override === 'boolean' ? override : isEntitled(tab);
  };

  const setOverride = (tab: Tab, value: boolean) => {
    if (ALWAYS_ON.includes(tab)) return;
    onConfigChange({ moduleOverrides: { ...overrides, [tab]: value } });
  };

  const resetToDefaults = () => {
    onConfigChange({ moduleOverrides: {} });
  };

  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800">
            {t('settings.modules') || 'Module Manager'}
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            {t('settings.modulesDesc') ||
              'Show or hide modules in the sidebar on this device. Changes are local and do not affect your plan.'}
          </p>
        </div>
        <button
          type="button"
          onClick={resetToDefaults}
          disabled={!hasOverrides}
          className={`shrink-0 inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
            hasOverrides
              ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
              : 'border-slate-100 text-slate-300 cursor-not-allowed'
          }`}
        >
          <RotateCcw size={14} />
          <span>{t('settings.modulesReset') || 'Reset to plan defaults'}</span>
        </button>
      </div>

      {/* Groups */}
      {MENU_GROUPS.map((group) => (
        <div key={group.labelKey} className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {t(group.labelKey) || group.labelKey.replace('sidebar.', '')}
          </div>
          <ul className="divide-y divide-slate-50">
            {group.items.map((item) => {
              const enabled = effectiveEnabled(item.tab);
              const entitled = isEntitled(item.tab);
              const locked = ALWAYS_ON.includes(item.tab);
              return (
                <li key={item.tab} className="flex items-center gap-3 px-4 py-3">
                  <span className={`shrink-0 ${enabled ? 'text-brand-600' : 'text-slate-300'}`}>
                    {item.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-700">
                        {t(item.labelKey) || item.labelKey.replace('sidebar.', '')}
                      </span>
                      {!entitled && !locked && (
                        <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
                          {t('settings.moduleOutsidePlan') || 'outside plan'}
                        </span>
                      )}
                      {locked && (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                          <Lock size={10} />
                          {t('settings.moduleAlwaysOn') || 'always on'}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={t(item.labelKey) || item.tab}
                    disabled={locked}
                    onClick={() => setOverride(item.tab, !enabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                      enabled ? 'bg-brand-600' : 'bg-slate-300'
                    } ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                        enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
