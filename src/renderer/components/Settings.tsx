import React, { useState, useEffect } from 'react';
import { AgentConfig, PrinterProtocol, PrinterConfig, PrintersConfig, SshTunnelStatus, UpdateStatus, Tab } from '../../shared/types';
import { Language, languageNames, getTranslation, printerTypeIcons } from '../i18n/translations';
import TelegramConfig from './TelegramConfig';
import rlog from '../utils/logger';
import { ShoppingCart, LayoutDashboard, FileText, CalendarDays, UserCheck, Bot, Activity, Shield, Bug, Printer, Tag, Ticket, UtensilsCrossed } from 'lucide-react';

interface SettingsProps {
  config: AgentConfig | null;
  onConfigChange: (config: Partial<AgentConfig>) => void;
}

// Printer types - defined locally for Vite compatibility
const PRINTER_TYPES = ['RECEIPT', 'LABEL', 'A4', 'TICKET', 'KITCHEN'] as const;
type PrinterTypeValue = typeof PRINTER_TYPES[number];

// Default printer config
const defaultPrinterConfig: PrinterConfig = {
  enabled: false,
  protocol: 'THERMAL',
  baudRate: 9600,
  labelWidth: 100,
  labelHeight: 50,
  paperWidth: 80,
  charsPerLine: 48,
  supportsCut: true,
  supportsCashDrawer: false,
};

const TAB_VISIBILITY_CONFIG: { tab: Tab; label: string; icon: React.ReactNode; color: string }[] = [
  { tab: 'pos',       label: 'Point of Sale',   icon: <ShoppingCart size={15} />,   color: 'text-blue-600 bg-blue-50' },
  { tab: 'billiard',  label: 'Billiard',         icon: <LayoutDashboard size={15} />, color: 'text-teal-600 bg-teal-50' },
  { tab: 'invoicing', label: 'Invoicing',        icon: <FileText size={15} />,        color: 'text-purple-600 bg-purple-50' },
  { tab: 'booksy',    label: 'Booksy Sync',      icon: <CalendarDays size={15} />,    color: 'text-orange-600 bg-orange-50' },
  { tab: 'checkin',   label: 'Check-in Kiosk',   icon: <UserCheck size={15} />,       color: 'text-green-600 bg-green-50' },
  { tab: 'chat',      label: 'Zira AI Chat',     icon: <Bot size={15} />,             color: 'text-brand-600 bg-brand-50' },
  { tab: 'status',    label: 'Status',           icon: <Activity size={15} />,        color: 'text-slate-600 bg-slate-100' },
  { tab: 'security',  label: 'Security',         icon: <Shield size={15} />,          color: 'text-red-600 bg-red-50' },
  { tab: 'debug',     label: 'Debug',            icon: <Bug size={15} />,             color: 'text-yellow-600 bg-yellow-50' },
];

export default function Settings({ config, onConfigChange }: SettingsProps) {
  const [ports, setPorts] = useState<string[]>([]);
  const [windowsPrinters, setWindowsPrinters] = useState<Array<{name: string; port: string}>>([]);
  const [selectedPort, setSelectedPort] = useState(config?.printerPort || '');
  const [protocol, setProtocol] = useState<PrinterProtocol>(
    config?.printerProtocol || 'THERMAL'
  );
  const [baudRate, setBaudRate] = useState(config?.printerBaudRate || 9600);
  const [serverUrl, setServerUrl] = useState(config?.serverUrl || 'https://api.enail.pro');
  const [name, setName] = useState(config?.name || 'Zira AI');
  const [autoStart, setAutoStart] = useState(config?.autoStart ?? true);
  const [copied, setCopied] = useState(false);
  const [savedBanner, setSavedBanner] = useState(false);
  const [showChangeSalonConfirm, setShowChangeSalonConfirm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // API Key connection state
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Language
  const [language, setLanguage] = useState<Language>(config?.language || 'en');

  // Tab visibility
  const [hiddenTabs, setHiddenTabs] = useState<Tab[]>((config?.hiddenTabs as Tab[]) ?? []);
  const t = getTranslation(language);

  // Test print state
  const [testingPrinter, setTestingPrinter] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ printerType: string; success: boolean; error?: string } | null>(null);
  // Calibrate state
  const [calibratingPrinter, setCalibratingPrinter] = useState<string | null>(null);
  const [calibrateResult, setCalibrateResult] = useState<{ printerType: string; success: boolean; error?: string; paperSize?: { widthMm: number; heightMm: number } } | null>(null);

  // Printer detection state
  const [posnetStatus, setPosnetStatus] = useState<{ devices: Array<{ vid: string; brand: string; model: string; windowsPrinterName: string | null; comPort: string | null; portName: string | null; connectionType: 'USB' | 'SERIAL' | 'NETWORK' | 'VIRTUAL'; driverInstalled: boolean; targetType?: string; recommendedProtocol?: string }>; posnetPresent: boolean; posnetComPort: string | null; posnetDriverInstalled: boolean } | null>(null);
  const [posnetChecking, setPosnetChecking] = useState(false);
  const [posnetInstalling, setPosnetInstalling] = useState(false);
  const [posnetInstallResult, setPosnetInstallResult] = useState<{ success: boolean; message: string } | null>(null);
  const [autoSettingUp, setAutoSettingUp] = useState(false);
  const [autoSetupResult, setAutoSetupResult] = useState<{ success: boolean; port?: string; message: string } | null>(null);
  const [settingUpDevice, setSettingUpDevice] = useState<string | null>(null); // brand being set up

  // POS settings
  const [posEnabled, setPosEnabled] = useState(config?.posEnabled ?? false);
  const [posMode, setPosMode] = useState<'retail' | 'salon' | 'b2b' | 'restaurant'>(config?.posMode || 'retail');
  const [posLanguage, setPosLanguage] = useState<Language | ''>(config?.posLanguage || '');
  const [customerDisplayEnabled, setCustomerDisplayEnabled] = useState(config?.customerDisplayEnabled ?? false);
  const [customerDisplayMonitor, setCustomerDisplayMonitor] = useState(config?.customerDisplayMonitor ?? 0);
  const [promoFolder, setPromoFolder] = useState((config as any)?.customerDisplayPromoFolder || '');
  const [promoInterval, setPromoInterval] = useState((config as any)?.customerDisplayPromoInterval ?? 5000);
  const [idleTimeout, setIdleTimeout] = useState((config as any)?.customerDisplayIdleTimeout ?? 120000);

  // Connected displays (dynamic)
  const [displays, setDisplays] = useState<Array<{
    index: number; id: number; label: string; width: number; height: number;
    x: number; y: number; isPrimary: boolean;
  }>>([]);

  // Zebra-specific settings (legacy)
  const [zebraPrinter, setZebraPrinter] = useState(config?.zebraPrinter || '');
  const [labelWidth, setLabelWidth] = useState(config?.labelWidth || 100);
  const [labelHeight, setLabelHeight] = useState(config?.labelHeight || 50);

  // AI Settings (local mode with tools)
  const [aiEnabled, setAiEnabled] = useState((config as any)?.aiEnabled ?? false);
  const [aiLocalMode, setAiLocalMode] = useState((config as any)?.aiLocalMode ?? false);
  const [aiApiKeyInput, setAiApiKeyInput] = useState((config as any)?.aiApiKey || '');

  // Unattended Remote Access
  const [remoteAccessEnabled, setRemoteAccessEnabled] = useState(config?.remoteAccessEnabled ?? false);
  const [remoteAccessPin, setRemoteAccessPin] = useState('');

  // SSH Tunnel state
  const [sshStatus, setSshStatus] = useState<SshTunnelStatus | null>(null);
  const [enableRemoteSupport, setEnableRemoteSupport] = useState(config?.sshTunnelEnabled ?? false);

  // Auto-update state
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState('1.0.0');

  // Multi-printer mode (new dictionary style)
  const [multiPrinterMode, setMultiPrinterMode] = useState(
    !!(config?.printers && Object.keys(config.printers).length > 0) ||
    !!(config?.receiptPrinter?.enabled || config?.labelPrinter?.enabled)
  );
  const [printers, setPrinters] = useState<PrintersConfig>(
    config?.printers || {}
  );

  // Legacy multi-printer (for backward compatibility)
  const [receiptPrinter, setReceiptPrinter] = useState<PrinterConfig>(
    config?.receiptPrinter || { ...defaultPrinterConfig }
  );
  const [labelPrinter, setLabelPrinter] = useState<PrinterConfig>(
    config?.labelPrinter || { ...defaultPrinterConfig }
  );

  // Load available ports and Windows printers
  useEffect(() => {
    let mounted = true;

    async function loadPorts() {
      try {
        const availablePorts = await window.electronAPI.listPorts();
        if (mounted) setPorts(availablePorts);
      } catch { /* ignore */ }
    }
    async function loadWindowsPrinters() {
      try {
        const printers = await window.electronAPI.listWindowsPrinters();
        if (mounted) setWindowsPrinters(printers);
      } catch { /* ignore */ }
    }
    loadPorts();
    loadWindowsPrinters();

    // Load connected displays
    async function loadDisplays() {
      try {
        const list = await window.electronAPI.display.list();
        if (mounted) setDisplays(list);
      } catch { /* display API may not exist in older builds */ }
    }
    loadDisplays();

    // Load remote access PIN from secure storage
    window.electronAPI.getRemotePin().then((r) => { if (mounted && r?.pin) setRemoteAccessPin(r.pin); }).catch(() => {});

    // Load SSH tunnel status
    window.electronAPI.sshTunnel.getStatus().then((s) => { if (mounted) setSshStatus(s); }).catch(() => {});
    const unsubSsh = window.electronAPI.sshTunnel.onStatusChanged(setSshStatus);

    // Listen for auto-update status
    const unsubUpdate = window.electronAPI.update.onStatus(setUpdateStatus);

    // Get app version
    window.electronAPI.debug.getDiagnostics().then((d) => {
      if (mounted && d?.appVersion) setAppVersion(d.appVersion);
    }).catch(() => {});

    return () => {
      mounted = false;
      unsubSsh?.();
      unsubUpdate?.();
    };
  }, []);

  // Update state when config changes
  useEffect(() => {
    if (config) {
      setSelectedPort(config.printerPort || '');
      setProtocol(config.printerProtocol || 'THERMAL');
      setBaudRate(config.printerBaudRate || 9600);
      setServerUrl(config.serverUrl || 'https://api.enail.pro');
      setName(config.name || 'Zira AI');
      setZebraPrinter(config.zebraPrinter || '');
      setLabelWidth(config.labelWidth || 100);
      setLabelHeight(config.labelHeight || 50);
      setAutoStart(config.autoStart ?? true);
      setLanguage(config.language || 'en');
      // POS settings
      setPosEnabled(config.posEnabled ?? false);
      setPosMode(config.posMode || 'retail');
      setPosLanguage(config.posLanguage || '');
      setCustomerDisplayEnabled(config.customerDisplayEnabled ?? false);
      setCustomerDisplayMonitor(config.customerDisplayMonitor ?? 0);
      setPromoFolder((config as any).customerDisplayPromoFolder || '');
      setPromoInterval((config as any).customerDisplayPromoInterval ?? 5000);
      setIdleTimeout((config as any).customerDisplayIdleTimeout ?? 120000);
      // Multi-printer settings (new dictionary)
      const hasPrintersDict = config.printers && Object.keys(config.printers).length > 0;
      const hasLegacyMulti = config.receiptPrinter?.enabled || config.labelPrinter?.enabled;
      setMultiPrinterMode(!!(hasPrintersDict || hasLegacyMulti));
      setPrinters(config.printers || {});
      // Legacy multi-printer settings
      setReceiptPrinter(config.receiptPrinter || { ...defaultPrinterConfig });
      setLabelPrinter(config.labelPrinter || { ...defaultPrinterConfig });
      // AI settings
      setAiEnabled((config as any).aiEnabled ?? false);
      setAiLocalMode((config as any).aiLocalMode ?? false);
      setAiApiKeyInput((config as any).aiApiKey || '');
      // Unattended Remote Access
      setRemoteAccessEnabled(config.remoteAccessEnabled ?? false);
      setRemoteAccessPin(config.remoteAccessPin || '');
    }
  }, [config]);

  const handleSave = async () => {
    setIsSaving(true);
    await window.electronAPI.setAutoStart(autoStart);

    const posConfig = {
      posEnabled,
      posMode,
      posLanguage: (posLanguage || '') as AgentConfig['posLanguage'],
      customerDisplayEnabled,
      customerDisplayMonitor,
      customerDisplayPromoFolder: promoFolder,
      customerDisplayPromoInterval: promoInterval,
      customerDisplayIdleTimeout: idleTimeout,
    };

    if (multiPrinterMode) {
      // Multi-printer mode config (use new dictionary)
      onConfigChange({
        name,
        autoStart,
        language,
        ...posConfig,
        printers,  // NEW: Use dictionary
        // Clear legacy multi-printer settings
        receiptPrinter: { ...defaultPrinterConfig, enabled: false },
        labelPrinter: { ...defaultPrinterConfig, enabled: false },
      });
    } else {
      // Legacy single printer config
      onConfigChange({
        name,
        printerPort: selectedPort,
        printerProtocol: protocol,
        printerBaudRate: baudRate,
        zebraPrinter,
        labelWidth,
        labelHeight,
        autoStart,
        language,
        ...posConfig,
        // Clear multi-printer settings when using legacy mode
        printers: {},  // Clear dictionary
        receiptPrinter: { ...defaultPrinterConfig, enabled: false },
        labelPrinter: { ...defaultPrinterConfig, enabled: false },
      });
    }
    setIsSaving(false);
    setSavedBanner(true);
    setTimeout(() => setSavedBanner(false), 3000);
  };

  // Helper functions for updating printer configs (legacy)
  const updateReceiptPrinter = (updates: Partial<PrinterConfig>) => {
    setReceiptPrinter(prev => ({ ...prev, ...updates }));
  };

  const updateLabelPrinter = (updates: Partial<PrinterConfig>) => {
    setLabelPrinter(prev => ({ ...prev, ...updates }));
  };

  // Helper function for updating printers dictionary
  const updatePrinter = (printerType: PrinterTypeValue, updates: Partial<PrinterConfig>) => {
    setPrinters(prev => ({
      ...prev,
      [printerType]: {
        ...(prev[printerType as keyof typeof prev] || defaultPrinterConfig),
        ...updates,
      },
    }));
  };

  // Get printer config for a type (with default)
  const getPrinterConfig = (printerType: PrinterTypeValue): PrinterConfig => {
    return printers[printerType as keyof typeof printers] || { ...defaultPrinterConfig };
  };

  const handleRefreshPorts = async () => {
    const availablePorts = await window.electronAPI.listPorts();
    setPorts(availablePorts);
  };

  const handleRefreshWindowsPrinters = async () => {
    const printers = await window.electronAPI.listWindowsPrinters();
    setWindowsPrinters(printers);
  };

  const handleCopyMachineId = async () => {
    if (config?.machineId) {
      await navigator.clipboard.writeText(config.machineId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Test print for a specific printer type using current (unsaved) config from state
  const handleTestPrint = async (printerType: string) => {
    setTestingPrinter(printerType);
    setTestResult(null);
    try {
      const printerConfig = getPrinterConfig(printerType as PrinterTypeValue);
      // Force enabled=true so testPrinterByConfig can create the driver even before saving
      const result = await window.electronAPI.testPrinterByConfig({ ...printerConfig, enabled: true });
      setTestResult({ printerType, success: result.success, error: result.error });
    } catch (error: any) {
      setTestResult({ printerType, success: false, error: error.message });
    } finally {
      setTestingPrinter(null);
      // Clear result after 5 seconds
      setTimeout(() => setTestResult(null), 5000);
    }
  };

  // Calibrate Zebra printer using current (unsaved) config from state
  const handleCalibrate = async (printerType: string) => {
    setCalibratingPrinter(printerType);
    setCalibrateResult(null);
    try {
      const printerConfig = getPrinterConfig(printerType as PrinterTypeValue);
      const result = await window.electronAPI.calibratePrinter({ ...printerConfig, enabled: true });
      setCalibrateResult({ printerType, success: result.success, error: result.error, paperSize: result.paperSize });
      // Auto-update label dimensions from detected paper size
      if (result.success && result.paperSize) {
        updatePrinter(printerType as PrinterTypeValue, {
          labelWidth: Math.round(result.paperSize.widthMm),
          labelHeight: Math.round(result.paperSize.heightMm),
        });
      }
    } catch (error: any) {
      setCalibrateResult({ printerType, success: false, error: error.message });
    } finally {
      setCalibratingPrinter(null);
      setTimeout(() => setCalibrateResult(null), 8000);
    }
  };

  // Test print for legacy single printer
  const handleLegacyTestPrint = async () => {
    setTestingPrinter('legacy');
    setTestResult(null);
    try {
      const result = await window.electronAPI.testPrint();
      setTestResult({ printerType: 'legacy', success: result.success, error: result.error });
    } catch (error: any) {
      setTestResult({ printerType: 'legacy', success: false, error: error.message });
    } finally {
      setTestingPrinter(null);
      // Clear result after 5 seconds
      setTimeout(() => setTestResult(null), 5000);
    }
  };

  // Detect printers + auto-setup all detected devices in one step
  const handleCheckPosnetDriver = async () => {
    setPosnetChecking(true);
    setPosnetInstallResult(null);
    setAutoSetupResult(null);
    try {
      const status = await window.electronAPI.getPosnetDriverStatus();
      setPosnetStatus(status);

      // Auto-fill detected COM port into any POSNET-protocol printer that has no port or a wrong port
      if (status.posnetComPort) {
        const detectedPort = status.posnetComPort;
        const availablePorts = await window.electronAPI.listPorts();
        setPorts(availablePorts);

        setPrinters(prev => {
          const updated = { ...prev };
          for (const [pt, pc] of Object.entries(updated)) {
            if (pc && (pc as PrinterConfig).protocol === 'POSNET') {
              (updated as any)[pt] = { ...pc, port: detectedPort };
            }
          }
          return updated;
        });
      }

      // Auto-setup all detected devices that have drivers installed
      // Uses backend-provided targetType from classifyPrinterCategory()
      const configured: string[] = [];
      const claimedSlots = new Set<string>();

      // First pass: mark already-configured slots
      for (const dev of status.devices) {
        const targetType = (dev.targetType || 'RECEIPT') as PrinterTypeValue;
        const isPosnet = dev.recommendedProtocol === 'POSNET';
        const cfg = getPrinterConfig(targetType);
        const alreadyConfigured = cfg.enabled && (
          (isPosnet && cfg.protocol === 'POSNET' && cfg.port === dev.comPort) ||
          (!isPosnet && cfg.windowsPrinter === dev.windowsPrinterName)
        );
        if (alreadyConfigured) claimedSlots.add(targetType);
      }

      // Second pass: auto-setup unconfigured devices
      for (const dev of status.devices) {
        if (!dev.driverInstalled && !dev.comPort) continue;

        const targetType = dev.targetType || 'RECEIPT';

        // Skip if this slot is already taken
        if (claimedSlots.has(targetType)) continue;

        // Auto-setup this device
        const result = await window.electronAPI.autoSetupPrinter(targetType, dev);
        if (result.success) {
          configured.push(`${dev.brand} ${dev.model} → ${targetType}`);
          claimedSlots.add(targetType);
        }
      }

      // Show summary if anything was auto-configured
      if (configured.length > 0) {
        setAutoSetupResult({
          success: true,
          message: `Auto-configured: ${configured.join(', ')}`,
        });
        // Refresh status after setup
        const freshStatus = await window.electronAPI.getPosnetDriverStatus();
        setPosnetStatus(freshStatus);
        const newPorts = await window.electronAPI.listPorts();
        setPorts(newPorts);
        const newPrintersList = await window.electronAPI.listWindowsPrinters();
        setWindowsPrinters(newPrintersList);
      }
    } finally {
      setPosnetChecking(false);
    }
  };

  // POSNET driver install
  const handleInstallPosnetDriver = async () => {
    setPosnetInstalling(true);
    setPosnetInstallResult(null);
    try {
      const result = await window.electronAPI.installPosnetDriver();
      setPosnetInstallResult(result);
      if (result.success) {
        // Re-check status and refresh COM ports after install
        const status = await window.electronAPI.getPosnetDriverStatus();
        setPosnetStatus(status);
        const newPorts = await window.electronAPI.listPorts();
        setPorts(newPorts);
      }
    } finally {
      setPosnetInstalling(false);
    }
  };

  // Universal auto setup — works for any printer brand
  const handleAutoSetup = async (targetType?: string, device?: any) => {
    setAutoSettingUp(true);
    setAutoSetupResult(null);
    try {
      const result = await window.electronAPI.autoSetupPrinter(targetType || 'RECEIPT', device);
      setAutoSetupResult(result);
      if (result.success) {
        // Refresh status + ports + printer config from backend
        const status = await window.electronAPI.getPosnetDriverStatus();
        setPosnetStatus(status);
        const newPorts = await window.electronAPI.listPorts();
        setPorts(newPorts);
        const newPrinters = await window.electronAPI.listWindowsPrinters();
        setWindowsPrinters(newPrinters);
        // Refresh printer config so Save doesn't overwrite auto-setup results
        const updatedConfig = await window.electronAPI.getConfig();
        if (updatedConfig?.printers) setPrinters(updatedConfig.printers);
      }
    } finally {
      setAutoSettingUp(false);
    }
  };

  // Scan for driver via Windows PnP
  const handleScanForDriver = async () => {
    setPosnetInstalling(true);
    setPosnetInstallResult(null);
    try {
      const result = await window.electronAPI.scanForDriver();
      setPosnetInstallResult(result);
      if (result.success) {
        // Re-detect to see if driver was found
        const status = await window.electronAPI.getPosnetDriverStatus();
        setPosnetStatus(status);
      }
    } finally {
      setPosnetInstalling(false);
    }
  };

  // Change salon / disconnect — uses dedicated handler that clears credentials server-side
  const handleChangeSalon = async () => {
    try {
      await window.electronAPI.changeSalon();
      // Refresh config from backend to get the cleared state
      const updated = await window.electronAPI.getConfig();
      onConfigChange(updated);
    } catch (error) {
      rlog.error('Failed to change salon:', error);
    } finally {
      setShowChangeSalonConfirm(false);
    }
  };

  // Connect with API Key
  const handleConnect = async () => {
    if (!apiKeyInput.trim()) {
      return;
    }
    setIsConnecting(true);
    setConnectionError(null);
    try {
      const result = await window.electronAPI.connectWithApiKey(apiKeyInput.trim());
      if (result.success) {
        // Connection successful — refresh config from backend (credentials stored server-side)
        const updated = await window.electronAPI.getConfig();
        onConfigChange({ ...updated, sshTunnelEnabled: enableRemoteSupport });
        setApiKeyInput('');
      } else {
        setConnectionError(result.error || t('pairing.connectionError'));
      }
    } catch (error: any) {
      setConnectionError(error.message || t('pairing.connectionError'));
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* General Settings */}
      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-4">
          {t('settings.general')}
        </h2>

        <div className="space-y-4">
          {/* Language Selector */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('settings.language')}
            </label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
            >
              {Object.entries(languageNames).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('settings.agentName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              placeholder={t('settings.agentNamePlaceholder')}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              {t('settings.serverUrl')}
            </label>
            <input
              type="text"
              value={serverUrl}
              readOnly
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500 cursor-not-allowed outline-none"
              placeholder="https://api.enail.pro"
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-slate-600">
                {t('settings.autoStart')}
              </label>
              <p className="text-xs text-slate-500">
                {t('settings.autoStartDesc')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAutoStart(!autoStart)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                autoStart ? 'bg-brand-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoStart ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Printer Detection */}
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Printer Detection</h2>
            <p className="text-xs text-slate-500 mt-0.5">Auto-detect and auto-recover all connected printers</p>
          </div>
          <button
            onClick={handleCheckPosnetDriver}
            disabled={posnetChecking}
            className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            {posnetChecking ? (
              <span className="flex items-center gap-1.5">
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Scanning...
              </span>
            ) : 'Detect Printers'}
          </button>
        </div>

        {posnetStatus && (
          <div className="space-y-2 mb-3">
            {posnetStatus.devices.length === 0 && (
              <p className="text-xs text-slate-400">No printers detected — connect a printer and try again</p>
            )}
            {posnetStatus.devices.map((dev, i) => {
              const isPosnet = dev.brand === 'POSNET' || dev.vid === '1424';
              const isZebra = dev.brand === 'Zebra' || dev.vid === '0A5F';
              const isDymo = dev.brand === 'DYMO';
              const isBusy = settingUpDevice === `${dev.brand}-${i}`;
              const model = (dev.model || '').toLowerCase();

              // Smart type classification (mirrors backend classifyPrinterCategory)
              const isLabelPrinter = isZebra || isDymo ||
                ['ql-', 'td-', 'pt-', 'labelwriter', 'label'].some(p => model.includes(p));
              const isThermalReceipt = !isPosnet && !isLabelPrinter && (
                ['Epson', 'Star Micronics', 'Citizen', 'Bixolon'].includes(dev.brand) ||
                ['thermal', 'receipt', 'pos ', 'tm-t', 'tm-m', 'tsp', 'srp-', 'ct-s'].some(p => model.includes(p))
              );
              const isA4Printer = !isPosnet && !isLabelPrinter && !isThermalReceipt &&
                ['HP', 'Canon', 'Samsung'].includes(dev.brand) && dev.connectionType !== 'SERIAL';

              // Determine target type
              const targetType: PrinterTypeValue = isPosnet ? 'RECEIPT' :
                isLabelPrinter ? 'LABEL' :
                isA4Printer ? 'A4' : 'RECEIPT';
              const targetProtocol: PrinterProtocol = isPosnet ? 'POSNET' :
                isZebra ? 'ZEBRA' :
                isA4Printer ? 'WINDOWS' : 'THERMAL';

              // Check if this device is already configured in the target slot
              const currentConfig = getPrinterConfig(targetType);
              const isAlreadyConfigured = currentConfig.enabled && (
                (isPosnet && currentConfig.protocol === 'POSNET' && currentConfig.port === dev.comPort) ||
                (!isPosnet && currentConfig.windowsPrinter === dev.windowsPrinterName)
              );

              return (
                <div key={i} className="bg-slate-50 rounded-lg px-3 py-2 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-slate-700">{dev.brand} — {dev.model}</div>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      dev.connectionType === 'USB' ? 'bg-blue-100 text-blue-700' :
                      dev.connectionType === 'SERIAL' ? 'bg-purple-100 text-purple-700' :
                      dev.connectionType === 'NETWORK' ? 'bg-cyan-100 text-cyan-700' :
                      'bg-slate-100 text-slate-500'
                    }`}>
                      {dev.connectionType}
                    </span>
                  </div>
                  <div className={dev.driverInstalled ? 'text-green-600' : 'text-amber-600'}>
                    {dev.driverInstalled ? '● Driver installed' : '○ Driver not installed'}
                  </div>
                  {dev.windowsPrinterName && dev.windowsPrinterName !== dev.model && (
                    <div className="text-slate-600">Windows name: <strong>{dev.windowsPrinterName}</strong></div>
                  )}
                  {dev.portName && (
                    <div className="text-slate-600">Port: <strong>{dev.portName}</strong></div>
                  )}
                  {dev.comPort && (
                    <div className="text-green-600">● COM port: <strong>{dev.comPort}</strong></div>
                  )}

                  {/* Per-device actions */}
                  {isAlreadyConfigured ? (
                    <div className="text-green-600 font-medium pt-1">
                      ✓ Configured as {targetType} printer
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {/* Any brand: install/scan driver if missing and no COM port fallback */}
                      {!dev.driverInstalled && !dev.comPort && (
                        <button
                          onClick={isPosnet ? handleInstallPosnetDriver : handleScanForDriver}
                          disabled={posnetInstalling || isBusy}
                          className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                        >
                          {posnetInstalling ? (
                            <>
                              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              {isPosnet ? 'Installing...' : 'Scanning...'}
                            </>
                          ) : (
                            <>
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                              {isPosnet ? 'Install POSNET Driver' : 'Scan for Driver'}
                            </>
                          )}
                        </button>
                      )}

                      {/* Any brand with driver or COM port: auto setup */}
                      {(dev.driverInstalled || dev.comPort) && (
                        <button
                          onClick={() => handleAutoSetup(targetType, dev)}
                          disabled={autoSettingUp || isBusy}
                          className={`px-2.5 py-1.5 rounded-md text-xs font-medium disabled:opacity-50 transition-colors flex items-center gap-1.5 ${
                            isZebra ? 'bg-purple-50 text-purple-700 hover:bg-purple-100' :
                            isPosnet ? 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100' :
                            'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          }`}
                        >
                          {autoSettingUp ? (
                            <>
                              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              Setting up...
                            </>
                          ) : (
                            <>
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                              </svg>
                              Auto Setup as {targetType}
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {posnetInstallResult && (
          <div className={`mb-3 px-3 py-2 rounded-lg text-xs ${
            posnetInstallResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            {posnetInstallResult.message}
            {posnetInstallResult.success && (posnetInstallResult as any).rebootRequired && (
              <span className="ml-1 font-medium">(Reboot may be required)</span>
            )}
          </div>
        )}

        {autoSetupResult && (
          <div className={`mb-3 px-3 py-2 rounded-lg text-xs ${
            autoSetupResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            {autoSetupResult.success
              ? autoSetupResult.message || `Configured on ${autoSetupResult.port || (autoSetupResult as any).windowsPrinter}`
              : autoSetupResult.message}
          </div>
        )}
      </div>

      {/* Printer Settings */}
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-700">
            {t('settings.printers')}
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">{t('settings.multiPrinter')}</span>
            <button
              type="button"
              onClick={() => setMultiPrinterMode(!multiPrinterMode)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                multiPrinterMode ? 'bg-brand-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  multiPrinterMode ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        {multiPrinterMode ? (
          <div className="space-y-4">
            {/* Dynamic Printer Sections - iterate over all PrinterType values */}
            {PRINTER_TYPES.map((printerType) => {
              const printerConfig = getPrinterConfig(printerType);
              const isLabel = printerType === 'LABEL';

              return (
                <div key={printerType} className="border border-slate-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 text-slate-600">
                        {printerType === 'RECEIPT' && <Printer size={16} />}
                        {printerType === 'LABEL' && <Tag size={16} />}
                        {printerType === 'A4' && <FileText size={16} />}
                        {printerType === 'TICKET' && <Ticket size={16} />}
                        {printerType === 'KITCHEN' && <UtensilsCrossed size={16} />}
                      </span>
                      <div>
                        <h3 className="text-sm font-medium text-slate-700">{t(`printer.${printerType}`)}</h3>
                        <p className="text-xs text-slate-500">{t(`printer.${printerType}.desc`)}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => updatePrinter(printerType, { enabled: !printerConfig.enabled })}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                        printerConfig.enabled ? 'bg-brand-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          printerConfig.enabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  {printerConfig.enabled && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.protocol')}</label>
                        <select
                          value={printerConfig.protocol}
                          onChange={(e) => updatePrinter(printerType, { protocol: e.target.value as PrinterProtocol })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                        >
                          {isLabel ? (
                            <>
                              <option value="ZEBRA">{t('protocol.ZEBRA.label')}</option>
                              <option value="WINDOWS">{t('protocol.WINDOWS.label')}</option>
                              <option value="THERMAL">{t('protocol.THERMAL.label')}</option>
                            </>
                          ) : (
                            <>
                              <option value="THERMAL">{t('protocol.THERMAL')}</option>
                              <option value="POSNET">{t('protocol.POSNET')}</option>
                              <option value="ZEBRA">{t('protocol.ZEBRA')}</option>
                              <option value="WINDOWS">{t('protocol.WINDOWS')}</option>
                            </>
                          )}
                        </select>
                      </div>

                      {printerConfig.protocol === 'POSNET' ? (
                        <>
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.comPort')}</label>
                            <div className="flex gap-2">
                              <select
                                value={printerConfig.port || ''}
                                onChange={(e) => updatePrinter(printerType, { port: e.target.value })}
                                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                              >
                                <option value="">{t('settings.selectPort')}</option>
                                {ports.map((port) => (
                                  <option key={port} value={port}>{port}</option>
                                ))}
                              </select>
                              <button
                                onClick={handleRefreshPorts}
                                className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.baudRate')}</label>
                            <select
                              value={printerConfig.baudRate || 9600}
                              onChange={(e) => updatePrinter(printerType, { baudRate: parseInt(e.target.value) })}
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                            >
                              <option value={9600}>9600</option>
                              <option value={19200}>19200</option>
                              <option value={38400}>38400</option>
                              <option value={57600}>57600</option>
                              <option value={115200}>115200</option>
                            </select>
                          </div>
                        </>
                      ) : printerConfig.protocol === 'THERMAL' ? (
                        <>
                          {/* USB / Windows Printer — for thermal USB printers, laser printers, etc. */}
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.windowsPrinter')} (USB)</label>
                            <div className="flex gap-2">
                              <select
                                value={printerConfig.windowsPrinter || ''}
                                onChange={(e) => updatePrinter(printerType, { windowsPrinter: e.target.value })}
                                className="flex-1 min-w-0 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none truncate"
                              >
                                <option value="">{t('settings.selectPrinter')}</option>
                                {windowsPrinters.map((p) => (
                                  <option key={p.name} value={p.name}>{p.name}{p.port ? ` [${p.port}]` : ''}</option>
                                ))}
                              </select>
                              <button
                                onClick={handleRefreshWindowsPrinters}
                                className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          <div className="relative flex items-center py-1">
                            <div className="flex-grow border-t border-slate-200" />
                            <span className="mx-2 text-xs text-slate-400">or serial</span>
                            <div className="flex-grow border-t border-slate-200" />
                          </div>
                          {/* Serial / COM Port — for older serial thermal printers */}
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.comPort')} (Serial)</label>
                            <div className="flex gap-2">
                              <select
                                value={printerConfig.port || ''}
                                onChange={(e) => updatePrinter(printerType, { port: e.target.value })}
                                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                              >
                                <option value="">{t('settings.selectPort')}</option>
                                {ports.map((port) => (
                                  <option key={port} value={port}>{port}</option>
                                ))}
                              </select>
                              <button
                                onClick={handleRefreshPorts}
                                className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.baudRate')}</label>
                            <select
                              value={printerConfig.baudRate || 9600}
                              onChange={(e) => updatePrinter(printerType, { baudRate: parseInt(e.target.value) })}
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                            >
                              <option value={9600}>9600</option>
                              <option value={19200}>19200</option>
                              <option value={38400}>38400</option>
                              <option value={57600}>57600</option>
                              <option value={115200}>115200</option>
                            </select>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.windowsPrinter')}</label>
                            <div className="flex gap-2">
                              <select
                                value={printerConfig.windowsPrinter || ''}
                                onChange={(e) => updatePrinter(printerType, { windowsPrinter: e.target.value })}
                                className="flex-1 min-w-0 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none truncate"
                              >
                                <option value="">{t('settings.selectPrinter')}</option>
                                {windowsPrinters.map((p) => (
                                  <option key={p.name} value={p.name}>{p.name}{p.port ? ` [${p.port}]` : ''}</option>
                                ))}
                              </select>
                              <button
                                onClick={handleRefreshWindowsPrinters}
                                className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer"
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          {/* Label size settings for LABEL printer type */}
                          {isLabel && (
                            <>
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.labelWidth')} (mm)</label>
                                  <input
                                    type="number"
                                    value={printerConfig.labelWidth || ''}
                                    onChange={(e) => updatePrinter(printerType, { labelWidth: parseInt(e.target.value) || 0 })}
                                    onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 10) updatePrinter(printerType, { labelWidth: 100 }); }}
                                    min={10}
                                    max={1000}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.labelHeight')} (mm)</label>
                                  <input
                                    type="number"
                                    value={printerConfig.labelHeight || ''}
                                    onChange={(e) => updatePrinter(printerType, { labelHeight: parseInt(e.target.value) || 0 })}
                                    onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 10) updatePrinter(printerType, { labelHeight: 50 }); }}
                                    min={10}
                                    max={1000}
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                                  />
                                </div>
                              </div>
                              <p className="text-xs text-slate-500">
                                {t('settings.popularSizes')}
                              </p>
                            </>
                          )}
                        </>
                      )}

                      {/* Test Print Button */}
                      <div className="pt-2 border-t border-slate-100">
                        <button
                          onClick={() => handleTestPrint(printerType)}
                          disabled={testingPrinter === printerType}
                          className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                            testingPrinter === printerType
                              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                              : 'bg-brand-50 text-brand-700 hover:bg-brand-100'
                          }`}
                        >
                          {testingPrinter === printerType ? (
                            <>
                              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                              {t('test.printing')}
                            </>
                          ) : (
                            <>
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                              </svg>
                              {t('test.button')}
                            </>
                          )}
                        </button>
                        {/* Test Result */}
                        {testResult && testResult.printerType === printerType && (
                          <div className={`mt-2 px-3 py-2 rounded-lg text-xs ${
                            testResult.success
                              ? 'bg-green-50 text-green-700'
                              : 'bg-red-50 text-red-700'
                          }`}>
                            {testResult.success ? t('test.success') : `${t('test.error')}: ${testResult.error}`}
                          </div>
                        )}

                        {/* Calibrate Button — Zebra only */}
                        {printerConfig.protocol === 'ZEBRA' && (
                          <>
                            <button
                              onClick={() => handleCalibrate(printerType)}
                              disabled={calibratingPrinter === printerType}
                              className={`w-full mt-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                                calibratingPrinter === printerType
                                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                  : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                              }`}
                            >
                              {calibratingPrinter === printerType ? (
                                <>
                                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                  </svg>
                                  {t('calibrate.running')}
                                </>
                              ) : (
                                <>
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                                  </svg>
                                  {t('calibrate.button')}
                                </>
                              )}
                            </button>
                            {calibrateResult && calibrateResult.printerType === printerType && (
                              <div className={`mt-2 px-3 py-2 rounded-lg text-xs ${
                                calibrateResult.success
                                  ? 'bg-green-50 text-green-700'
                                  : 'bg-red-50 text-red-700'
                              }`}>
                                {calibrateResult.success
                                  ? `${t('calibrate.success')}${calibrateResult.paperSize ? ` (${calibrateResult.paperSize.widthMm} x ${calibrateResult.paperSize.heightMm} mm)` : ''}`
                                  : `${t('test.error')}: ${calibrateResult.error}`}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* Legacy single printer mode */
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('settings.protocol')}
              </label>
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as PrinterProtocol)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              >
                <option value="THERMAL">{t('protocol.THERMAL')}</option>
                <option value="POSNET">{t('protocol.POSNET')}</option>
                <option value="ZEBRA">{t('protocol.ZEBRA')}</option>
              </select>
            </div>

            {/* COM Port settings - shown for THERMAL and POSNET */}
            {protocol !== 'ZEBRA' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('settings.comPort')}
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={selectedPort}
                      onChange={(e) => setSelectedPort(e.target.value)}
                      className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                    >
                      <option value="">{t('settings.selectPort')}</option>
                      {ports.map((port) => (
                        <option key={port} value={port}>
                          {port}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleRefreshPorts}
                      className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                      title="Refresh"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  </div>
                  {ports.length === 0 && (
                    <p className="mt-1 text-xs text-amber-600">
                      {t('settings.noPortsDetected')}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('settings.baudRate')}
                  </label>
                  <select
                    value={baudRate}
                    onChange={(e) => setBaudRate(parseInt(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  >
                    <option value={9600}>9600</option>
                    <option value={19200}>19200</option>
                    <option value={38400}>38400</option>
                    <option value={57600}>57600</option>
                    <option value={115200}>115200</option>
                  </select>
                </div>
              </>
            )}

            {/* Zebra printer settings */}
            {protocol === 'ZEBRA' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('settings.windowsPrinter')}
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={zebraPrinter}
                      onChange={(e) => setZebraPrinter(e.target.value)}
                      className="flex-1 min-w-0 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none truncate"
                    >
                      <option value="">{t('settings.selectPrinter')}</option>
                      {windowsPrinters.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name}{p.port ? ` [${p.port}]` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleRefreshWindowsPrinters}
                      className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                      title="Refresh"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  </div>
                  {windowsPrinters.length === 0 && (
                    <p className="mt-1 text-xs text-amber-600">
                      {t('settings.noPrintersDetected')}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">
                      {t('settings.labelWidth')} (mm)
                    </label>
                    <input
                      type="number"
                      value={labelWidth || ''}
                      onChange={(e) => setLabelWidth(parseInt(e.target.value) || 0)}
                      onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 10) setLabelWidth(100); }}
                      min={10}
                      max={1000}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">
                      {t('settings.labelHeight')} (mm)
                    </label>
                    <input
                      type="number"
                      value={labelHeight || ''}
                      onChange={(e) => setLabelHeight(parseInt(e.target.value) || 0)}
                      onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 10) setLabelHeight(50); }}
                      min={10}
                      max={1000}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                    />
                  </div>
                </div>

                <p className="text-xs text-slate-500">
                  {t('settings.popularSizes')}
                </p>
              </>
            )}

            {/* Test Print Button for Legacy Mode */}
            <div className="pt-4 border-t border-slate-200">
              <button
                onClick={handleLegacyTestPrint}
                disabled={testingPrinter === 'legacy'}
                className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  testingPrinter === 'legacy'
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-brand-50 text-brand-700 hover:bg-brand-100'
                }`}
              >
                {testingPrinter === 'legacy' ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    {t('test.printing')}
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                    {t('test.button')}
                  </>
                )}
              </button>
              {/* Test Result */}
              {testResult && testResult.printerType === 'legacy' && (
                <div className={`mt-2 px-3 py-2 rounded-lg text-xs ${
                  testResult.success
                    ? 'bg-green-50 text-green-700'
                    : 'bg-red-50 text-red-700'
                }`}>
                  {testResult.success ? t('test.success') : `${t('test.error')}: ${testResult.error}`}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* POS Settings */}
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-700">
            {t('settings.pos')}
          </h2>
          <button
            type="button"
            onClick={() => setPosEnabled(!posEnabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              posEnabled ? 'bg-brand-600' : 'bg-slate-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                posEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {posEnabled && (
          <div className="space-y-4">
            {/* POS Mode */}
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('settings.posMode')}
              </label>
              <select
                value={posMode}
                onChange={(e) => setPosMode(e.target.value as any)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              >
                <option value="retail">{t('pos.mode.retail')}</option>
                <option value="salon">{t('pos.mode.salon')}</option>
                <option value="b2b">{t('pos.mode.b2b')}</option>
                <option value="restaurant">{t('pos.mode.restaurant')}</option>
              </select>
              <p className="text-xs text-slate-500 mt-1">{t('settings.posModeDesc')}</p>
            </div>

            {/* POS Language */}
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('settings.posLanguage')}
              </label>
              <select
                value={posLanguage}
                onChange={(e) => setPosLanguage(e.target.value as Language | '')}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              >
                <option value="">{t('settings.posLanguageSameAsMain')}</option>
                {Object.entries(languageNames).map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-1">{t('settings.posLanguageDesc')}</p>
            </div>

            {/* Customer Display */}
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-slate-600">
                  {t('settings.customerDisplay')}
                </label>
                <p className="text-xs text-slate-500">
                  {t('settings.customerDisplayDesc')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCustomerDisplayEnabled(!customerDisplayEnabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  customerDisplayEnabled ? 'bg-brand-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    customerDisplayEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Open Customer Display Button */}
            {customerDisplayEnabled && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    const result = await window.electronAPI.window.open('customer');
                    if (!result.success) {
                      rlog.error('[Settings] Failed to open customer display:', result.error);
                    }
                  } catch (err) {
                    rlog.error('[Settings] Failed to open customer display:', err);
                  }
                }}
                className="w-full px-4 py-2 border border-brand-300 text-brand-700 rounded-lg text-sm font-medium hover:bg-brand-50 transition-colors cursor-pointer"
              >
                {t('settings.openCustomerDisplay')}
              </button>
            )}

            {/* Customer Display Monitor */}
            {customerDisplayEnabled && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('settings.customerDisplayMonitor')}
                </label>
                <select
                  value={customerDisplayMonitor}
                  onChange={(e) => setCustomerDisplayMonitor(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                >
                  {displays.length > 0 ? (
                    displays.map((d) => (
                      <option key={d.index} value={d.index}>
                        {d.isPrimary ? t('settings.monitorPrimary') : `${t('settings.monitorSecondary')} ${d.index}`}
                        {' '}&mdash; {d.width}x{d.height}
                        {d.label && d.label !== `Display ${d.index + 1}` ? ` (${d.label})` : ''}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value={0}>{t('settings.monitorPrimary')}</option>
                      <option value={1}>{t('settings.monitorSecondary')} (1)</option>
                      <option value={2}>{t('settings.monitorSecondary')} (2)</option>
                    </>
                  )}
                </select>
                <p className="text-xs text-slate-500 mt-1">{t('settings.customerDisplayMonitorDesc')}</p>
              </div>
            )}

            {/* Promo Images Folder */}
            {customerDisplayEnabled && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('settings.promoFolder')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={promoFolder}
                    readOnly
                    placeholder={t('settings.promoFolderDesc')}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-slate-50 text-slate-700 outline-none"
                  />
                  <button
                    onClick={async () => {
                      const folder = await window.electronAPI.selectFolder();
                      if (folder) setPromoFolder(folder);
                    }}
                    className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors whitespace-nowrap"
                  >
                    {t('settings.promoFolderBrowse')}
                  </button>
                  {promoFolder && (
                    <button
                      onClick={() => setPromoFolder('')}
                      className="px-2 py-2 border border-slate-300 rounded-lg text-sm text-red-500 hover:bg-red-50 transition-colors"
                      title="Clear"
                    >
                      &times;
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Promo Interval */}
            {customerDisplayEnabled && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('settings.promoInterval')}
                </label>
                <select
                  value={promoInterval}
                  onChange={(e) => setPromoInterval(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                >
                  <option value={3000}>3s</option>
                  <option value={5000}>5s</option>
                  <option value={8000}>8s</option>
                  <option value={10000}>10s</option>
                  <option value={15000}>15s</option>
                  <option value={30000}>30s</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">{t('settings.promoIntervalDesc')}</p>
              </div>
            )}

            {/* Idle Timeout */}
            {customerDisplayEnabled && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('settings.idleTimeout')}
                </label>
                <select
                  value={idleTimeout}
                  onChange={(e) => setIdleTimeout(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                >
                  <option value={30000}>30s</option>
                  <option value={60000}>1 min</option>
                  <option value={120000}>2 min</option>
                  <option value={300000}>5 min</option>
                  <option value={600000}>10 min</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">{t('settings.idleTimeoutDesc')}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pairing Card */}
      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-4">
          {t('pairing.title')}
        </h2>

        {config?.isPaired ? (
          <div className="space-y-3">
            <div className="p-3 bg-green-50 rounded-lg">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <div className="flex-1">
                  <p className="text-sm font-medium text-green-800">
                    {t('pairing.paired')}: {config.salonName}
                  </p>
                  <p className="text-xs text-green-600">
                    {t('pairing.id')}: {config.agentId?.substring(0, 8)}...
                  </p>
                </div>
              </div>
              {config.apiKey && (
                <div className="mt-2 pt-2 border-t border-green-200">
                  <p className="text-xs text-green-600">
                    {t('pairing.apiKey')}: {config.apiKey.length > 11
                      ? `${config.apiKey.substring(0, 7)}...${config.apiKey.substring(config.apiKey.length - 4)}`
                      : '••••••••'}
                  </p>
                </div>
              )}
            </div>
            {/* Remote Support Toggle */}
            <div className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50">
              <div>
                <span className="text-sm text-slate-700">{t('ssh.enableRemoteSupport')}</span>
                <p className="text-xs text-slate-400">{t('ssh.enableRemoteSupportDesc')}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const enabled = !enableRemoteSupport;
                  setEnableRemoteSupport(enabled);
                  onConfigChange({ sshTunnelEnabled: enabled });
                  if (enabled) {
                    window.electronAPI.sshTunnel.start();
                  } else {
                    window.electronAPI.sshTunnel.disconnect();
                  }
                }}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors cursor-pointer ${enableRemoteSupport ? 'bg-brand-600' : 'bg-slate-300'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enableRemoteSupport ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            {/* Unattended Remote Access */}
            <div className="border border-slate-200 rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-slate-700">{t('remote.unattendedAccess')}</span>
                  <p className="text-xs text-slate-400">{t('remote.unattendedAccessDesc')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const enabled = !remoteAccessEnabled;
                    setRemoteAccessEnabled(enabled);
                    if (enabled && !remoteAccessPin && config?.entitlements?.salonCode) {
                      const defaultPin = config.entitlements.salonCode;
                      setRemoteAccessPin(defaultPin);
                      window.electronAPI.setRemotePin(defaultPin);
                    }
                    onConfigChange({ remoteAccessEnabled: enabled });
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors cursor-pointer ${remoteAccessEnabled ? 'bg-brand-600' : 'bg-slate-300'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${remoteAccessEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>

              {remoteAccessEnabled && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    {t('remote.pin')}
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={remoteAccessPin}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                      setRemoteAccessPin(val);
                      window.electronAPI.setRemotePin(val);
                    }}
                    placeholder={t('remote.pinPlaceholder')}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono tracking-widest text-center focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  />
                  <p className="text-xs text-slate-400 mt-1">
                    {remoteAccessPin
                      ? t('remote.pinSet')
                      : t('remote.pinEmpty')}
                  </p>
                </div>
              )}
            </div>

            {showChangeSalonConfirm ? (
              <div className="border border-red-200 rounded-lg p-3 bg-red-50 space-y-2">
                <p className="text-sm text-red-700">{t('pairing.confirmChange')}</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleChangeSalon}
                    className="flex-1 px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors cursor-pointer"
                  >
                    {t('pairing.changeSalon')}
                  </button>
                  <button
                    onClick={() => setShowChangeSalonConfirm(false)}
                    className="flex-1 px-3 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowChangeSalonConfirm(true)}
                className="w-full px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 transition-colors cursor-pointer"
              >
                {t('pairing.changeSalon')}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* API Key Input */}
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('pairing.apiKey')}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={t('pairing.apiKeyPlaceholder')}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none font-mono"
                  disabled={isConnecting}
                />
                <button
                  onClick={handleConnect}
                  disabled={isConnecting || !apiKeyInput.trim()}
                  className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isConnecting ? t('pairing.connecting') : t('pairing.connect')}
                </button>
              </div>
              {connectionError && (
                <p className="text-xs text-red-600 mt-1">{connectionError}</p>
              )}
            </div>

            {/* Remote Support Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm text-slate-700">{t('ssh.enableRemoteSupport')}</span>
                <p className="text-xs text-slate-400">{t('ssh.enableRemoteSupportDesc')}</p>
              </div>
              <button
                type="button"
                onClick={() => setEnableRemoteSupport(!enableRemoteSupport)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors cursor-pointer ${enableRemoteSupport ? 'bg-brand-600' : 'bg-slate-300'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enableRemoteSupport ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 border-t border-slate-200"></div>
              <span className="text-xs text-slate-400">{t('pairing.or')}</span>
              <div className="flex-1 border-t border-slate-200"></div>
            </div>

            {/* Machine ID for manual pairing */}
            <div className="text-center">
              <p className="text-xs text-slate-500 mb-2">
                {t('pairing.instructions')}
              </p>
              <div className="inline-block px-4 py-3 bg-slate-100 rounded-lg">
                <p className="text-xs text-slate-500 mb-1">{t('pairing.machineId')}</p>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-mono text-slate-800">
                    {config?.machineId || t('pairing.loading')}
                  </p>
                  <button
                    onClick={handleCopyMachineId}
                    className="p-1.5 text-slate-500 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors"
                    title="Copy"
                  >
                    {copied ? (
                      <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
                </div>
                {copied && (
                  <p className="text-xs text-green-600 mt-1">{t('pairing.copied')}</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Telegram Remote Control */}
      <TelegramConfig
        config={config}
        onConfigChange={onConfigChange}
        language={language}
      />

      {/* AI Settings (Local Mode with Tools) */}
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-700">
            Zira AI Tools
          </h2>
          <button
            type="button"
            onClick={() => {
              const next = !aiLocalMode;
              setAiLocalMode(next);
              setAiEnabled(next);
              onConfigChange({ aiLocalMode: next, aiEnabled: next });
            }}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors cursor-pointer ${aiLocalMode ? 'bg-brand-600' : 'bg-slate-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${aiLocalMode ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-3">
          {t('ai.localModeDesc')}
        </p>

        {aiLocalMode && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                {t('ai.apiKey')}
              </label>
              <input
                type="password"
                data-keyboard="false"
                value={aiApiKeyInput}
                onChange={(e) => {
                  setAiApiKeyInput(e.target.value);
                  window.electronAPI.setAiApiKey(e.target.value);
                }}
                placeholder={t('ai.apiKeyPlaceholder')}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="text-xs text-slate-400 mt-1">
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    window.electronAPI.shell.openExternal('https://openrouter.ai/keys');
                  }}
                  className="text-brand-600 hover:underline cursor-pointer"
                >
                  {t('ai.apiKeyHelp')}
                </a>
              </p>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <p className="text-xs text-blue-700">
                <strong>Tools available:</strong> Open apps, control mouse/keyboard,
                take screenshots, check Booksy calendar
              </p>
            </div>
          </div>
        )}
      </div>

      {/* App Updates */}
      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">
          {t('update.title')}
        </h2>

        <div className="space-y-3">
          {/* Current version */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600">{t('update.currentVersion')}</span>
            <span className="text-sm font-mono text-slate-800">v{appVersion}</span>
          </div>

          {/* Status display */}
          {updateStatus && (
            <div className={`px-3 py-2 rounded-lg text-sm ${
              updateStatus.status === 'up-to-date' ? 'bg-green-50 text-green-700' :
              updateStatus.status === 'available' ? 'bg-blue-50 text-blue-700' :
              updateStatus.status === 'downloading' ? 'bg-blue-50 text-blue-700' :
              updateStatus.status === 'downloaded' ? 'bg-green-50 text-green-700' :
              updateStatus.status === 'error' ? 'bg-red-50 text-red-700' :
              'bg-slate-50 text-slate-600'
            }`}>
              {updateStatus.status === 'checking' && t('update.checking')}
              {updateStatus.status === 'up-to-date' && t('update.upToDate')}
              {updateStatus.status === 'available' && `${t('update.available')} v${updateStatus.version}`}
              {updateStatus.status === 'downloading' && (
                <div>
                  <div className="flex justify-between mb-1">
                    <span>{t('update.downloading')}</span>
                    <span>{updateStatus.percent}%</span>
                  </div>
                  <div className="w-full bg-blue-200 rounded-full h-1.5">
                    <div
                      className="bg-blue-600 h-1.5 rounded-full transition-all"
                      style={{ width: `${updateStatus.percent || 0}%` }}
                    />
                  </div>
                </div>
              )}
              {updateStatus.status === 'downloaded' && `${t('update.downloaded')} v${updateStatus.version}`}
              {updateStatus.status === 'error' && `${t('update.error')}: ${updateStatus.error}`}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            {updateStatus?.status === 'downloaded' ? (
              <button
                onClick={() => window.electronAPI.update.install()}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors cursor-pointer"
              >
                {t('update.installBtn')}
              </button>
            ) : (
              <button
                onClick={() => {
                  setUpdateStatus({ status: 'checking' });
                  window.electronAPI.update.check();
                }}
                disabled={updateStatus?.status === 'checking' || updateStatus?.status === 'downloading'}
                className="flex-1 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {updateStatus?.status === 'checking' ? t('update.checkingBtn') : t('update.checkBtn')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* SSH Tunnel Status */}
      {sshStatus && (
        <div className="panel p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">
            {t('ssh.title')}
          </h2>

          {/* Status indicator */}
          <div className="flex items-center gap-2 mb-3">
            <span className={`w-2.5 h-2.5 rounded-full ${
              sshStatus.state === 'connected' ? 'bg-green-500' :
              sshStatus.state === 'connecting' || sshStatus.state === 'reconnecting' ? 'bg-yellow-500 animate-pulse' :
              sshStatus.state === 'error' ? 'bg-red-500' :
              'bg-slate-300'
            }`} />
            <span className="text-sm text-slate-700">
              {t(`ssh.state.${sshStatus.state}`)}
            </span>
            {sshStatus.requestedBy && sshStatus.state === 'connected' && (
              <span className="text-xs text-slate-500 ml-auto">
                {t('ssh.requestedBy')}: {sshStatus.requestedBy}
              </span>
            )}
          </div>

          {/* SSH availability info */}
          <div className="space-y-1 mb-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className={sshStatus.sshAvailable ? 'text-green-600' : 'text-slate-400'}>
                {sshStatus.sshAvailable ? '\u2713' : '\u2717'}
              </span>
              {t('ssh.clientAvailable')}
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className={sshStatus.sshServerAvailable ? 'text-green-600' : 'text-slate-400'}>
                {sshStatus.sshServerAvailable ? '\u2713' : '\u2717'}
              </span>
              {t('ssh.serverAvailable')}
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className={sshStatus.keyGenerated ? 'text-green-600' : 'text-slate-400'}>
                {sshStatus.keyGenerated ? '\u2713' : '\u2717'}
              </span>
              {t('ssh.keyGenerated')}
            </div>
          </div>

          {/* Connected info */}
          {sshStatus.state === 'connected' && sshStatus.assignedPort && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-2 mb-3">
              <p className="text-xs text-green-700">
                {t('ssh.connectedOn')} {sshStatus.assignedPort}
              </p>
            </div>
          )}

          {/* Error */}
          {sshStatus.lastError && sshStatus.state === 'error' && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-2 mb-3">
              <p className="text-xs text-red-700">{sshStatus.lastError}</p>
            </div>
          )}

          {/* Disconnect button */}
          {(sshStatus.state === 'connected' || sshStatus.state === 'connecting' || sshStatus.state === 'reconnecting') && (
            <button
              onClick={() => window.electronAPI.sshTunnel.disconnect()}
              className="w-full px-3 py-2 text-sm bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
            >
              {t('ssh.disconnect')}
            </button>
          )}

          {/* Info text */}
          {sshStatus.state === 'disconnected' && (
            <p className="text-xs text-slate-400 italic">
              {t('ssh.infoText')}
            </p>
          )}
        </div>
      )}

      {/* Tab Visibility */}
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-slate-700">{t('settings.navigationTabs')}</h2>
          <span className="text-xs text-slate-400">
            {TAB_VISIBILITY_CONFIG.length - hiddenTabs.filter(t => TAB_VISIBILITY_CONFIG.some(c => c.tab === t)).length} / {TAB_VISIBILITY_CONFIG.length} visible
          </span>
        </div>
        <p className="text-xs text-slate-400 mb-4">{t('settings.navigationTabsDesc')}</p>
        <div className="space-y-1">
          {TAB_VISIBILITY_CONFIG.map(({ tab, label, icon, color }) => {
            const isVisible = !hiddenTabs.includes(tab);
            return (
              <label key={tab} className="flex items-center justify-between gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer">
                <div className="flex items-center gap-3">
                  <span className={`flex items-center justify-center w-7 h-7 rounded-lg ${color}`}>
                    {icon}
                  </span>
                  <span className="text-sm text-slate-700">{label}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isVisible}
                  onClick={() => {
                    const newHidden = isVisible
                      ? [...hiddenTabs, tab]
                      : hiddenTabs.filter(t => t !== tab);
                    setHiddenTabs(newHidden);
                    onConfigChange({ hiddenTabs: newHidden });
                  }}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none ${isVisible ? 'bg-brand-600' : 'bg-slate-200'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isVisible ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </label>
            );
          })}
        </div>
      </div>

      {/* Check-in Display */}
      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">Check-in Display</h2>
        <p className="text-xs text-slate-400 mb-4">Control which elements are visible on the Check-in tab. Hide staff-only panels for customer-facing setups.</p>
        <div className="space-y-1">
          {[
            { key: 'checkinShowStatsBar' as const, label: 'Stats bar', desc: 'Total · Waiting · In Service · Completed counts' },
            { key: 'checkinShowQueue' as const, label: 'Active queue panel', desc: 'Right-side list of waiting and in-service customers' },
          ].map(({ key, label, desc }) => {
            const enabled = (config?.[key] ?? true) as boolean;
            return (
              <label key={key} className="flex items-center justify-between gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer">
                <div>
                  <div className="text-sm text-slate-700">{label}</div>
                  <div className="text-xs text-slate-400">{desc}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => onConfigChange({ [key]: !enabled })}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none ${enabled ? 'bg-brand-600' : 'bg-slate-200'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </label>
            );
          })}
        </div>
      </div>

      {/* Save Banner */}
      {savedBanner && (
        <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {t('settings.saved')}
        </div>
      )}

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={isSaving}
        className="w-full px-4 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {isSaving && (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        )}
        {t('settings.save')}
      </button>
    </div>
  );
}
