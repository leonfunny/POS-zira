import React, { useState, useEffect } from 'react';
import { AgentConfig, TelegramBotStatus } from '../../shared/types';
import { getTranslation, Language } from '../i18n/translations';

interface TelegramConfigProps {
  config: AgentConfig | null;
  onConfigChange: (config: Partial<AgentConfig>) => void;
  language: Language;
}

export default function TelegramConfig({ config, onConfigChange, language }: TelegramConfigProps) {
  const t = getTranslation(language);

  // Local state
  const [enabled, setEnabled] = useState(config?.telegramEnabled || false);
  const [token, setToken] = useState(config?.telegramToken || '');
  const [allowedIds, setAllowedIds] = useState(
    (config?.telegramAllowedIds || []).join(', ')
  );
  const [enableInput, setEnableInput] = useState(config?.telegramEnableInput || false);
  const [enableBrowser, setEnableBrowser] = useState(config?.telegramEnableBrowser || false);

  // Bot status
  const [botStatus, setBotStatus] = useState<TelegramBotStatus | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  // Sync state with config
  useEffect(() => {
    if (config) {
      setEnabled(config.telegramEnabled || false);
      setToken(config.telegramToken || '');
      setAllowedIds((config.telegramAllowedIds || []).join(', '));
      setEnableInput(config.telegramEnableInput || false);
      setEnableBrowser(config.telegramEnableBrowser || false);
    }
  }, [config]);

  // Fetch bot status on mount and periodically
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = await window.electronAPI.telegram.getStatus();
        setBotStatus(status);
      } catch (error) {
        console.error('Failed to get Telegram status:', error);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000); // Every 5 seconds

    return () => clearInterval(interval);
  }, []);

  // Handle save
  const handleSave = () => {
    // Parse allowed IDs
    const parsedIds = allowedIds
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id) && id > 0);

    onConfigChange({
      telegramEnabled: enabled,
      telegramToken: token,
      telegramAllowedIds: parsedIds,
      telegramEnableInput: enableInput,
      telegramEnableBrowser: enableBrowser,
    });
  };

  // Handle restart
  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      await window.electronAPI.telegram.restart();
      // Wait a bit for bot to start
      setTimeout(async () => {
        const status = await window.electronAPI.telegram.getStatus();
        setBotStatus(status);
        setIsRestarting(false);
      }, 2000);
    } catch (error) {
      console.error('Failed to restart Telegram:', error);
      setIsRestarting(false);
    }
  };

  return (
    <div className="panel p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-4">
        {t('telegram.title')}
      </h2>

      <div className="space-y-4">
        {/* Enable Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-slate-600">
              {t('telegram.enable')}
            </label>
            <p className="text-xs text-slate-500">{t('telegram.enableDesc')}</p>
          </div>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              enabled ? 'bg-brand-600' : 'bg-slate-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {enabled && (
          <>
            {/* Bot Status */}
            {botStatus && (
              <div className={`p-3 rounded-lg text-sm ${
                botStatus.running
                  ? 'bg-green-50 text-green-700'
                  : 'bg-slate-100 text-slate-600'
              }`}>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{t('telegram.status')}: </span>
                    {botStatus.running ? t('telegram.running') : t('telegram.stopped')}
                    {botStatus.botUsername && (
                      <span className="ml-2 text-xs">
                        @{botStatus.botUsername}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={handleRestart}
                    disabled={isRestarting}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      isRestarting
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                        : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-300'
                    }`}
                  >
                    {isRestarting ? t('telegram.restarting') : t('telegram.restart')}
                  </button>
                </div>
                {botStatus.lastError && (
                  <div className="mt-2 text-xs text-red-600">
                    {t('telegram.error')}: {botStatus.lastError}
                  </div>
                )}
              </div>
            )}

            {/* Bot Token */}
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('telegram.token')}
                {botStatus?.hasToken && !token && (
                  <span className="ml-2 text-xs text-green-600 font-normal">
                    OK {t('telegram.tokenConfigured') || 'Configured (encrypted)'}
                  </span>
                )}
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none font-mono"
                placeholder={botStatus?.hasToken && !token
                  ? '****************'
                  : t('telegram.tokenPlaceholder')}
              />
              <p className="mt-1 text-xs text-slate-500">
                {botStatus?.hasToken && !token
                  ? (t('telegram.tokenHelpConfigured') || 'Token is securely stored. Enter a new token to replace it.')
                  : t('telegram.tokenHelp')}
              </p>
            </div>

            {/* Allowed User IDs */}
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('telegram.allowedIds')}
              </label>
              <input
                type="text"
                value={allowedIds}
                onChange={(e) => setAllowedIds(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none font-mono"
                placeholder={t('telegram.allowedIdsPlaceholder')}
              />
              <p className="mt-1 text-xs text-slate-500">
                {t('telegram.allowedIdsHelp')}
              </p>
            </div>

            {/* Security Warning */}
            {(enableInput || enableBrowser) && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <span className="text-amber-500">!</span>
                  <div>
                    <p className="text-sm font-medium text-amber-800">
                      {t('telegram.securityWarning')}
                    </p>
                    <p className="text-xs text-amber-700 mt-1">
                      {t('telegram.securityWarningText')}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Enable Input Control */}
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-slate-600">
                  {t('telegram.enableInput')}
                </label>
                <p className="text-xs text-slate-500">{t('telegram.enableInputDesc')}</p>
              </div>
              <button
                type="button"
                onClick={() => setEnableInput(!enableInput)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  enableInput ? 'bg-amber-500' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enableInput ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Enable Browser Control */}
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-slate-600">
                  {t('telegram.enableBrowser')}
                </label>
                <p className="text-xs text-slate-500">{t('telegram.enableBrowserDesc')}</p>
              </div>
              <button
                type="button"
                onClick={() => setEnableBrowser(!enableBrowser)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              enableBrowser ? 'bg-brand-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enableBrowser ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Save Button (only if changed) */}
      {enabled && (
        <div className="mt-4 pt-4 border-t border-slate-200">
            <button
              onClick={handleSave}
              className="w-full px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
            >
              {t('settings.save')}
            </button>
        </div>
      )}
    </div>
  );
}
