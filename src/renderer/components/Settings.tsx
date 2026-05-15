import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AgentConfig, PrinterProtocol, PrinterConfig, PrintersConfig, SshTunnelStatus, UpdateStatus, Tab, ALLOWED_PROTOCOLS_BY_TYPE, PrinterType, LiveCustomerDisplayProfile, PosnetDiagnoseResult, charsPerLineFor, ServerPrinterMapping, LocalPrinterMirrorRow, SalonPrinterMapping, SalonPrinterAssignment, SalonPrinterRole } from '../../shared/types';
import { resolveCustomerDisplayProfile } from '../../shared/customer-display-profile';
import { Language, languageNames, getTranslation, printerTypeIcons } from '../i18n/translations';
import TelegramConfig from './TelegramConfig';
import rlog from '../utils/logger';
import { ShoppingCart, ScanBarcode, LayoutDashboard, FileText, CalendarDays, UserCheck, Bot, Activity, Shield, Bug, Printer, Tag, Ticket, UtensilsCrossed, Plus, Pencil, Trash2, X, CheckCircle2, AlertTriangle, Share2 } from 'lucide-react';

interface PortMismatchValidation {
  ok: boolean;
  code: 'OK' | 'PROTOCOL_DEVICE_MISMATCH' | 'UNKNOWN_DEVICE' | 'NO_DEVICE_ON_PORT';
  detail?: string;
  detectedBrand?: string;
  detectedVid?: string;
  suggestedProtocol?: PrinterProtocol;
}

/**
 * Live banner that warns when a slot is configured with a protocol that
 * doesn't match the device actually present on the chosen COM port.
 *
 * Example: slot has protocol=POSNET, port=COM3, but COM3 hosts an ELZAB
 * Zeta Online (VID_C1CA). Without this warning the user would only see
 * cryptic "no response" errors on test print.
 */
function PortProtocolMismatchBanner({
  port,
  protocol,
  onApplySuggested,
}: {
  port: string | undefined;
  protocol: PrinterProtocol;
  onApplySuggested: (suggested: PrinterProtocol) => void;
}) {
  const [validation, setValidation] = useState<PortMismatchValidation | null>(null);

  useEffect(() => {
    if (!port) { setValidation(null); return; }
    let cancelled = false;
    const validateFn = (window.electronAPI as any).validatePrinterPort;
    if (typeof validateFn !== 'function') return;
    validateFn(port, protocol).then((r: PortMismatchValidation) => {
      if (!cancelled) setValidation(r);
    }).catch(() => { if (!cancelled) setValidation(null); });
    return () => { cancelled = true; };
  }, [port, protocol]);

  if (!validation || validation.ok) return null;
  if (validation.code !== 'PROTOCOL_DEVICE_MISMATCH') return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex items-start gap-2.5">
      <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-amber-900">
          {validation.detectedBrand ? `${validation.detectedBrand} detected on ${port}` : 'Protocol mismatch'}
        </p>
        <p className="mt-0.5 text-xs text-amber-800">{validation.detail}</p>
        {validation.suggestedProtocol && (
          <button
            type="button"
            onClick={() => onApplySuggested(validation.suggestedProtocol!)}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white rounded-md text-xs font-bold transition-colors cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Switch to {validation.suggestedProtocol}
          </button>
        )}
      </div>
    </div>
  );
}

interface SettingsProps {
  config: AgentConfig | null;
  onConfigChange: (config: Partial<AgentConfig>) => void | Promise<any>;
}

// Printer types - defined locally for Vite compatibility
const PRINTER_TYPES = ['RECEIPT', 'FISCAL', 'LABEL', 'A4', 'TICKET', 'KITCHEN'] as const;
type PrinterTypeValue = typeof PRINTER_TYPES[number];
type SettingsTab = 'general' | 'pos' | 'printers';
const SELF_CHECKOUT_RECEIPT_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT';
const PAPER_CONTROL_PRINTER_TYPES = ['RECEIPT', 'TICKET', 'KITCHEN'] as const;

function isPaperControlPrinterType(printerType: PrinterTypeValue): boolean {
  return PAPER_CONTROL_PRINTER_TYPES.includes(printerType as typeof PAPER_CONTROL_PRINTER_TYPES[number]);
}

// Default printer config
const defaultPrinterConfig: PrinterConfig = {
  enabled: false,
  protocol: 'THERMAL',
  baudRate: 9600,
  labelWidth: 50,
  labelHeight: 30,
  paperWidth: 80,
  charsPerLine: 48,
  supportsCut: true,
  supportsCashDrawer: false,
};

interface DetectedPrinterDevice {
  vid: string;
  pid?: string;
  brand: string;
  model: string;
  windowsPrinterName: string | null;
  comPort: string | null;
  portName: string | null;
  connectionType: 'USB' | 'SERIAL' | 'NETWORK' | 'VIRTUAL';
  driverInstalled: boolean;
  targetType?: string;
  recommendedProtocol?: string;
  autoSetupEligible?: boolean;
}

interface PrinterDetectionStatus {
  devices: DetectedPrinterDevice[];
  posnetPresent: boolean;
  posnetComPort: string | null;
  posnetDriverInstalled: boolean;
  serialPorts?: string[];
  windowsPrinters?: WindowsPrinterOption[];
}

type WindowsPrinterOption = { name: string; port: string };

type CustomPrinterForm = {
  id?: string;
  displayName: string;
  printerType: PrinterTypeValue;
  protocol: PrinterProtocol;
  windowsPrinterName: string;
  address: string;
  paperWidth: number;
  paperHeight: number;
  isEnabled: boolean;
};

const emptyCustomPrinterForm = (): CustomPrinterForm => ({
  displayName: '',
  printerType: 'LABEL',
  protocol: 'WINDOWS',
  windowsPrinterName: '',
  address: '',
  paperWidth: 100,
  paperHeight: 150,
  isEnabled: true,
});

function preferredProtocolForType(printerType: PrinterTypeValue): PrinterProtocol {
  if (printerType === 'LABEL') return 'WINDOWS';
  const allowed = ALLOWED_PROTOCOLS_BY_TYPE[printerType as PrinterType] || ['WINDOWS'];
  return allowed.includes('WINDOWS') ? 'WINDOWS' : allowed[0];
}

function normalizePrinterList(response: any): ServerPrinterMapping[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.printers)) return response.printers;
  return [];
}

function normalizeSalonPrinterList(response: any): SalonPrinterMapping[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.printers)) return response.printers;
  return [];
}

function normalizePrinterAssignments(response: any): SalonPrinterAssignment[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.assignments)) return response.assignments;
  return [];
}

function getServerPrinterName(printer: ServerPrinterMapping): string {
  return printer.displayName || printer.name || printer.printerType || 'Printer';
}

function getServerPrinterTarget(printer: ServerPrinterMapping): string {
  return printer.windowsPrinterName || printer.address || 'no target';
}

function hasServerPrinterTarget(printer: ServerPrinterMapping): boolean {
  return !!(printer.windowsPrinterName?.trim() || printer.address?.trim());
}

function shortId(id?: string | null): string {
  if (!id) return '';
  return id.length > 8 ? id.slice(0, 8) : id;
}

function isReceiptServerPrinter(printer: ServerPrinterMapping): boolean {
  return String(printer.printerType || '').toUpperCase() === 'RECEIPT';
}

function isSharedReceiptRouteCandidate(printer: SalonPrinterMapping, selectedPrinterId: string): boolean {
  return isReceiptServerPrinter(printer) && (printer.id === selectedPrinterId || hasServerPrinterTarget(printer));
}

function deriveMultiPrinterMode(config: AgentConfig | null | undefined): boolean {
  if (!config) return false;
  if (typeof config.multiPrinterMode === 'boolean') return config.multiPrinterMode;
  return !!(
    (config.printers && Object.keys(config.printers).length > 0) ||
    config.receiptPrinter?.enabled ||
    config.labelPrinter?.enabled
  );
}

function buildPrinterPayloadFromConfig(config: AgentConfig | null | undefined): Partial<AgentConfig> {
  const multiPrinterMode = deriveMultiPrinterMode(config);
  if (multiPrinterMode) {
    return {
      multiPrinterMode: true,
      printers: config?.printers || {},
      receiptPrinter: config?.receiptPrinter || { ...defaultPrinterConfig, enabled: false },
      labelPrinter: config?.labelPrinter || { ...defaultPrinterConfig, enabled: false },
    };
  }

  return {
    multiPrinterMode: false,
    printerPort: config?.printerPort || '',
    printerProtocol: config?.printerProtocol || 'THERMAL',
    printerBaudRate: config?.printerBaudRate || 9600,
    zebraPrinter: config?.zebraPrinter || '',
    labelWidth: config?.labelWidth || 50,
    labelHeight: config?.labelHeight || 30,
    printers: {},
    receiptPrinter: config?.receiptPrinter || { ...defaultPrinterConfig, enabled: false },
    labelPrinter: config?.labelPrinter || { ...defaultPrinterConfig, enabled: false },
  };
}

function getPrinterPayloadSignature(payload: Partial<AgentConfig>): string {
  return JSON.stringify(payload);
}

function readCachedPrinterDetectionStatus(): PrinterDetectionStatus | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem('zira.posnetStatus');
    return raw ? JSON.parse(raw) as PrinterDetectionStatus : null;
  } catch {
    return null;
  }
}

function mergeWindowsPrinterOptions(
  ...groups: Array<WindowsPrinterOption[] | undefined>
): WindowsPrinterOption[] {
  const byName = new Map<string, WindowsPrinterOption>();

  for (const group of groups) {
    for (const printer of group || []) {
      const name = printer?.name?.trim();
      if (!name) continue;

      const key = name.toLowerCase();
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { name, port: printer.port || '' });
      } else if (!existing.port && printer.port) {
        byName.set(key, { ...existing, port: printer.port });
      }
    }
  }

  return Array.from(byName.values());
}

function getConfiguredWindowsPrinterOptions(config: AgentConfig | null | undefined): WindowsPrinterOption[] {
  const configured: WindowsPrinterOption[] = [];
  const add = (name: string | null | undefined) => {
    const trimmed = name?.trim();
    if (trimmed) configured.push({ name: trimmed, port: '' });
  };

  for (const printer of Object.values(config?.printers || {})) {
    add(printer?.windowsPrinter);
  }
  add(config?.receiptPrinter?.windowsPrinter);
  add(config?.labelPrinter?.windowsPrinter);
  add(config?.zebraPrinter);

  return mergeWindowsPrinterOptions(configured);
}

function getInitialWindowsPrinterOptions(config: AgentConfig | null | undefined): WindowsPrinterOption[] {
  return mergeWindowsPrinterOptions(
    readCachedPrinterDetectionStatus()?.windowsPrinters,
    getConfiguredWindowsPrinterOptions(config),
  );
}

function getWindowsPrinterOptionsForSelect(
  windowsPrinters: WindowsPrinterOption[],
  selectedPrinter: string | undefined,
): WindowsPrinterOption[] {
  return mergeWindowsPrinterOptions(
    windowsPrinters,
    selectedPrinter ? [{ name: selectedPrinter, port: '' }] : undefined,
  );
}

const TAB_VISIBILITY_CONFIG: { tab: Tab; label: string; icon: React.ReactNode; color: string }[] = [
  { tab: 'pos',          label: 'Point of Sale',   icon: <ShoppingCart size={15} />,   color: 'text-blue-600 bg-blue-50' },
  { tab: 'selfCheckout', label: 'Self-Checkout',   icon: <ScanBarcode size={15} />,    color: 'text-emerald-600 bg-emerald-50' },
  { tab: 'billiard',     label: 'Billiard',         icon: <LayoutDashboard size={15} />, color: 'text-teal-600 bg-teal-50' },
  { tab: 'invoicing', label: 'Invoicing',        icon: <FileText size={15} />,        color: 'text-purple-600 bg-purple-50' },
  { tab: 'booksy',    label: 'Booksy Sync',      icon: <CalendarDays size={15} />,    color: 'text-orange-600 bg-orange-50' },
  { tab: 'bookings',  label: 'Bookings',         icon: <CalendarDays size={15} />,    color: 'text-indigo-600 bg-indigo-50' },
  { tab: 'checkin',   label: 'Check-in Kiosk',   icon: <UserCheck size={15} />,       color: 'text-green-600 bg-green-50' },
  { tab: 'chat',      label: 'Zira AI Chat',     icon: <Bot size={15} />,             color: 'text-brand-600 bg-brand-50' },
  { tab: 'status',    label: 'Status',           icon: <Activity size={15} />,        color: 'text-slate-600 bg-slate-100' },
  { tab: 'security',  label: 'Security',         icon: <Shield size={15} />,          color: 'text-red-600 bg-red-50' },
  { tab: 'debug',     label: 'Debug',            icon: <Bug size={15} />,             color: 'text-yellow-600 bg-yellow-50' },
];

export default function Settings({ config, onConfigChange }: SettingsProps) {
  const [ports, setPorts] = useState<string[]>([]);
  const [windowsPrinters, setWindowsPrinters] = useState<WindowsPrinterOption[]>(
    () => getInitialWindowsPrinterOptions(config),
  );
  const [selectedPort, setSelectedPort] = useState(config?.printerPort || '');
  const [protocol, setProtocol] = useState<PrinterProtocol>(
    config?.printerProtocol || 'THERMAL'
  );
  const [baudRate, setBaudRate] = useState(config?.printerBaudRate || 9600);
  const [serverUrl, setServerUrl] = useState(config?.serverUrl || 'https://api.enail.pro');
  const [name, setName] = useState(config?.name || 'Zira AI');
  const [autoStart, setAutoStart] = useState(config?.autoStart ?? true);
  const [copied, setCopied] = useState(false);
  const [showChangeSalonConfirm, setShowChangeSalonConfirm] = useState(false);

  // API Key connection state
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Language
  const [language, setLanguage] = useState<Language>(config?.language || 'en');

  // Tab visibility
  const [hiddenTabs, setHiddenTabs] = useState<Tab[]>((config?.hiddenTabs as Tab[]) ?? []);
  const t = getTranslation(language);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');

  // Test print state
  const [testingPrinter, setTestingPrinter] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    printerType: string;
    success: boolean;
    error?: string;
    steps?: Array<{ step: string; ok: boolean; detail?: string; error?: string; durationMs?: number }>;
    modelName?: string;
    charsetUsed?: string;
    cutModeUsed?: string;
  } | null>(null);
  // Live progress — updated as each step streams back from main process
  const [liveSteps, setLiveSteps] = useState<Array<{ step: string; ok: boolean; detail?: string; error?: string }>>([]);
  // Calibrate state
  const [calibratingPrinter, setCalibratingPrinter] = useState<string | null>(null);
  const [calibrateResult, setCalibrateResult] = useState<{ printerType: string; success: boolean; error?: string; paperSize?: { widthMm: number; heightMm: number } } | null>(null);

  // Printer detection state — persisted to sessionStorage so switching tabs
  // (which unmounts Settings) doesn't wipe the detected printer list from the
  // UI. Main-side registry keeps the real cache; this is just for instant UI
  // restore.
  const [posnetStatus, setPosnetStatus] = useState<PrinterDetectionStatus | null>(() => {
    return readCachedPrinterDetectionStatus();
  });
  useEffect(() => {
    try {
      if (posnetStatus) sessionStorage.setItem('zira.posnetStatus', JSON.stringify(posnetStatus));
      else sessionStorage.removeItem('zira.posnetStatus');
    } catch { /* quota/private mode — best-effort */ }
  }, [posnetStatus]);
  const [posnetChecking, setPosnetChecking] = useState(false);
  const [posnetInstalling, setPosnetInstalling] = useState(false);
  const [posnetInstallResult, setPosnetInstallResult] = useState<{ success: boolean; message: string } | null>(null);
  const [autoSettingUp, setAutoSettingUp] = useState(false);
  const [autoSetupResult, setAutoSetupResult] = useState<{ success: boolean; port?: string; message: string } | null>(null);
  const [settingUpDevice, setSettingUpDevice] = useState<string | null>(null); // brand being set up
  const [refreshingDevice, setRefreshingDevice] = useState<string | null>(null); // device being refreshed
  const [refreshDeviceResult, setRefreshDeviceResult] = useState<{ key: string; success: boolean; message: string } | null>(null);
  const [diagnosingDevice, setDiagnosingDevice] = useState<string | null>(null);
  const [diagnoseResult, setDiagnoseResult] = useState<{ key: string; result: PosnetDiagnoseResult } | null>(null);

  // POS settings
  const [posEnabled, setPosEnabled] = useState(config?.posEnabled ?? false);
  const [posMode, setPosMode] = useState<'retail' | 'salon' | 'b2b' | 'restaurant'>(config?.posMode || 'retail');
  const [posLanguage, setPosLanguage] = useState<Language | ''>(config?.posLanguage || '');
  const [receiptSellerName, setReceiptSellerName] = useState(config?.receiptSellerName || '');
  const [receiptSellerAddress, setReceiptSellerAddress] = useState(config?.receiptSellerAddress || '');
  const [receiptSellerNip, setReceiptSellerNip] = useState(config?.receiptSellerNip || '');
  const [customerDisplayEnabled, setCustomerDisplayEnabled] = useState(config?.customerDisplayEnabled ?? false);
  const [customerDisplayProfile, setCustomerDisplayProfile] = useState<LiveCustomerDisplayProfile>(
    resolveCustomerDisplayProfile(config),
  );
  const customerDisplayProfileRef = useRef<LiveCustomerDisplayProfile>(customerDisplayProfile);
  const customerDisplayProfileSelectRef = useRef<HTMLSelectElement | null>(null);
  customerDisplayProfileRef.current = customerDisplayProfile;
  const [customerDisplayMonitor, setCustomerDisplayMonitor] = useState(config?.customerDisplayMonitor ?? 0);
  const [customerDisplayForceKiosk, setCustomerDisplayForceKiosk] = useState(config?.customerDisplayForceKiosk ?? true);
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
  const [labelWidth, setLabelWidth] = useState(config?.labelWidth || 50);
  const [labelHeight, setLabelHeight] = useState(config?.labelHeight || 30);

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
  const [savingPrinterChanges, setSavingPrinterChanges] = useState(false);
  const [printerSaveResult, setPrinterSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  // Multi-printer mode (new dictionary style)
  const [multiPrinterMode, setMultiPrinterMode] = useState(deriveMultiPrinterMode(config));
  const [printers, setPrinters] = useState<PrintersConfig>(
    config?.printers || {}
  );
  const [serverPrinters, setServerPrinters] = useState<ServerPrinterMapping[]>([]);
  const [serverPrintersLoading, setServerPrintersLoading] = useState(false);
  const [serverPrintersError, setServerPrintersError] = useState<string | null>(null);
  const [localPrinterRows, setLocalPrinterRows] = useState<LocalPrinterMirrorRow[]>([]);
  const [localPrinterRowsLoading, setLocalPrinterRowsLoading] = useState(false);
  const [localPrinterRowsError, setLocalPrinterRowsError] = useState<string | null>(null);
  const [salonPrinters, setSalonPrinters] = useState<SalonPrinterMapping[]>([]);
  const [printerAssignments, setPrinterAssignments] = useState<SalonPrinterAssignment[]>([]);
  const [sharedPrintersLoading, setSharedPrintersLoading] = useState(false);
  const [sharedPrintersError, setSharedPrintersError] = useState<string | null>(null);
  const [sharedPrinterSavingId, setSharedPrinterSavingId] = useState<string | null>(null);
  const [customPrinterForm, setCustomPrinterForm] = useState<CustomPrinterForm>(() => emptyCustomPrinterForm());
  const [customPrinterModalOpen, setCustomPrinterModalOpen] = useState(false);
  const [customPrinterSaving, setCustomPrinterSaving] = useState(false);
  const [customPrinterDeletingId, setCustomPrinterDeletingId] = useState<string | null>(null);
  const deviceRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const printerSaveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const printerAutoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const printerSaveInFlightRef = useRef(false);
  const pendingPrinterSaveRef = useRef(false);
  const failedPrinterSignatureRef = useRef<string | null>(null);
  const syncedPrinterSignatureRef = useRef(getPrinterPayloadSignature(buildPrinterPayloadFromConfig(config)));
  const latestPrinterPayloadRef = useRef(buildPrinterPayloadFromConfig(config));
  const latestPrinterSignatureRef = useRef(getPrinterPayloadSignature(latestPrinterPayloadRef.current));
  const componentMountedRef = useRef(true);

  const buildGeneralConfigPayload = useCallback((overrides: Partial<AgentConfig> = {}): Partial<AgentConfig> => ({
    name,
    autoStart,
    language,
    posEnabled,
    posMode,
    posLanguage: (posLanguage || '') as AgentConfig['posLanguage'],
    receiptSellerName,
    receiptSellerAddress,
    receiptSellerNip,
    customerDisplayEnabled,
    customerDisplayProfile,
    customerDisplayMonitor,
    customerDisplayForceKiosk,
    customerDisplayPromoFolder: promoFolder,
    customerDisplayPromoInterval: promoInterval,
    customerDisplayIdleTimeout: idleTimeout,
    ...overrides,
  }), [
    name, autoStart, language,
    posEnabled, posMode, posLanguage,
    receiptSellerName, receiptSellerAddress, receiptSellerNip,
    customerDisplayEnabled, customerDisplayProfile, customerDisplayMonitor, customerDisplayForceKiosk,
    promoFolder, promoInterval, idleTimeout,
  ]);

  const buildPrinterConfigPayload = useCallback((): Partial<AgentConfig> => {
    if (multiPrinterMode) {
      return {
        multiPrinterMode: true,
        printers,
        receiptPrinter: { ...defaultPrinterConfig, enabled: false },
        labelPrinter: { ...defaultPrinterConfig, enabled: false },
      };
    }

    return {
      multiPrinterMode: false,
      printerPort: selectedPort,
      printerProtocol: protocol,
      printerBaudRate: baudRate,
      zebraPrinter,
      labelWidth,
      labelHeight,
      printers: {},
      receiptPrinter: { ...defaultPrinterConfig, enabled: false },
      labelPrinter: { ...defaultPrinterConfig, enabled: false },
    };
  }, [
    multiPrinterMode, printers,
    selectedPort, protocol, baudRate, zebraPrinter, labelWidth, labelHeight,
  ]);

  const currentPrinterPayload = buildPrinterConfigPayload();
  const currentPrinterPayloadSignature = getPrinterPayloadSignature(currentPrinterPayload);
  latestPrinterPayloadRef.current = currentPrinterPayload;
  latestPrinterSignatureRef.current = currentPrinterPayloadSignature;

  const clearPrinterSaveResultLater = useCallback(() => {
    if (printerSaveStatusTimerRef.current) {
      clearTimeout(printerSaveStatusTimerRef.current);
    }
    printerSaveStatusTimerRef.current = setTimeout(() => {
      if (componentMountedRef.current) {
        setPrinterSaveResult(null);
      }
    }, 4000);
  }, []);

  const refreshPrinterDiscovery = useCallback(async () => {
    const status = await window.electronAPI.getPosnetDriverStatus() as PrinterDetectionStatus;
    setPosnetStatus(status);
    setPorts(status.serialPorts || []);
    setWindowsPrinters(status.windowsPrinters || []);
    return status;
  }, []);

  const schedulePrinterDiscoveryRefresh = useCallback((delayMs = 500) => {
    if (deviceRefreshTimerRef.current) clearTimeout(deviceRefreshTimerRef.current);
    deviceRefreshTimerRef.current = setTimeout(() => {
      refreshPrinterDiscovery().catch(() => {});
    }, delayMs);
  }, [refreshPrinterDiscovery]);

  const loadLocalPrinterRows = useCallback(async () => {
    setLocalPrinterRowsLoading(true);
    setLocalPrinterRowsError(null);
    try {
      const rows = await window.electronAPI.printAgentPrinters.localList();
      setLocalPrinterRows(Array.isArray(rows) ? rows : []);
    } catch (err: any) {
      setLocalPrinterRowsError(err?.message || 'Failed to load local printer rows');
    } finally {
      setLocalPrinterRowsLoading(false);
    }
  }, []);

  const loadServerPrinters = useCallback(async () => {
    if (!config?.agentId) return;
    setServerPrintersLoading(true);
    setServerPrintersError(null);
    try {
      const response = await window.electronAPI.printAgentPrinters.list();
      const rows = normalizePrinterList(response);
      setServerPrinters(rows);
      setWindowsPrinters(prev => mergeWindowsPrinterOptions(
        prev,
        rows
          .map((printer) => printer.windowsPrinterName)
          .filter(Boolean)
          .map((name) => ({ name: name as string, port: '' })),
      ));
      await loadLocalPrinterRows();
    } catch (err: any) {
      setServerPrintersError(err?.message || 'Failed to load server printers');
    } finally {
      setServerPrintersLoading(false);
    }
  }, [config?.agentId, loadLocalPrinterRows]);

  const loadSharedPrinterRouting = useCallback(async () => {
    setSharedPrintersLoading(true);
    setSharedPrintersError(null);
    try {
      const [printersResult, assignmentsResult] = await Promise.allSettled([
        window.electronAPI.printAgentPrinters.salonList({
          shareableOnly: true,
          role: SELF_CHECKOUT_RECEIPT_ROLE,
        }),
        window.electronAPI.printAgentPrinters.assignmentsList(),
      ]);

      if (printersResult.status === 'fulfilled') {
        const rows = normalizeSalonPrinterList(printersResult.value);
        setSalonPrinters(rows);
        setWindowsPrinters(prev => mergeWindowsPrinterOptions(
          prev,
          rows
            .map((printer) => printer.windowsPrinterName)
            .filter(Boolean)
            .map((name) => ({ name: name as string, port: '' })),
        ));
      } else {
        setSalonPrinters([]);
      }

      if (assignmentsResult.status === 'fulfilled') {
        setPrinterAssignments(normalizePrinterAssignments(assignmentsResult.value));
      } else {
        setPrinterAssignments([]);
      }

      const firstError = printersResult.status === 'rejected'
        ? printersResult.reason
        : assignmentsResult.status === 'rejected'
          ? assignmentsResult.reason
          : null;
      if (firstError) {
        setSharedPrintersError(firstError?.message || 'Failed to load shared printer settings');
      }
    } catch (err: any) {
      setSalonPrinters([]);
      setPrinterAssignments([]);
      setSharedPrintersError(err?.message || 'Failed to load shared printer settings');
    } finally {
      setSharedPrintersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (config?.agentId) {
      loadServerPrinters().catch(() => {});
    } else {
      setServerPrinters([]);
    }
  }, [config?.agentId, loadServerPrinters]);

  useEffect(() => {
    if (settingsTab === 'printers') {
      loadLocalPrinterRows().catch(() => {});
      loadSharedPrinterRouting().catch((err: any) => {
        setSharedPrintersError(err?.message || 'Failed to load shared printer settings');
        setSharedPrintersLoading(false);
      });
    }
  }, [settingsTab, loadLocalPrinterRows, loadSharedPrinterRouting]);

  // Load available ports and Windows printers
  useEffect(() => {
    let mounted = true;
    componentMountedRef.current = true;
    refreshPrinterDiscovery().catch(() => {});

    // Load connected displays
    async function loadDisplays() {
      try {
        const list = await window.electronAPI.display.list();
        if (mounted) setDisplays(list);
      } catch { /* display API may not exist in older builds */ }
    }
    loadDisplays();

    // Load remote access PIN from secure storage
    window.electronAPI.getRemotePin().then((r: any) => { if (mounted && r?.pin) setRemoteAccessPin(r.pin); }).catch(() => {});

    // Load SSH tunnel status
    window.electronAPI.sshTunnel.getStatus().then((s: any) => { if (mounted) setSshStatus(s); }).catch(() => {});
    const unsubSsh = window.electronAPI.sshTunnel.onStatusChanged(setSshStatus);

    // Listen for auto-update status
    const unsubUpdate = window.electronAPI.update.onStatus(setUpdateStatus);

    // Listen for health-check status changes — auto-refresh printer lists
    // when the backend detects a plug/unplug event
    const unsubDevice = window.electronAPI.onDeviceStatus(() => {
      if (!mounted) return;
      schedulePrinterDiscoveryRefresh(500);
      loadLocalPrinterRows().catch(() => {});
    });

    // Get app version
    window.electronAPI.debug.getDiagnostics().then((d: any) => {
      if (mounted && d?.appVersion) setAppVersion(d.appVersion);
    }).catch(() => {});

    return () => {
      mounted = false;
      componentMountedRef.current = false;
      unsubSsh?.();
      unsubUpdate?.();
      unsubDevice?.();
      if (deviceRefreshTimerRef.current) clearTimeout(deviceRefreshTimerRef.current);
      if (printerSaveStatusTimerRef.current) clearTimeout(printerSaveStatusTimerRef.current);
    };
  }, [refreshPrinterDiscovery, schedulePrinterDiscoveryRefresh, loadLocalPrinterRows]);

  // Update state when config changes
  useEffect(() => {
    if (config) {
      const incomingPrinterSignature = getPrinterPayloadSignature(buildPrinterPayloadFromConfig(config));
      setServerUrl(config.serverUrl || 'https://api.enail.pro');
      setName(config.name || 'Zira AI');
      setAutoStart(config.autoStart ?? true);
      setLanguage(config.language || 'en');
      // POS settings
      setPosEnabled(config.posEnabled ?? false);
      setPosMode(config.posMode || 'retail');
      setPosLanguage(config.posLanguage || '');
      setReceiptSellerName(config.receiptSellerName || '');
      setReceiptSellerAddress(config.receiptSellerAddress || '');
      setReceiptSellerNip(config.receiptSellerNip || '');
      setCustomerDisplayEnabled(config.customerDisplayEnabled ?? false);
      const nextProfile = resolveCustomerDisplayProfile(config);
      customerDisplayProfileRef.current = nextProfile;
      setCustomerDisplayProfile(nextProfile);
      setCustomerDisplayMonitor(config.customerDisplayMonitor ?? 0);
      setCustomerDisplayForceKiosk(config.customerDisplayForceKiosk ?? true);
      setPromoFolder((config as any).customerDisplayPromoFolder || '');
      setPromoInterval((config as any).customerDisplayPromoInterval ?? 5000);
      setIdleTimeout((config as any).customerDisplayIdleTimeout ?? 120000);
      // AI settings
      setAiEnabled((config as any).aiEnabled ?? false);
      setAiLocalMode((config as any).aiLocalMode ?? false);
      setAiApiKeyInput((config as any).aiApiKey || '');
      // Unattended Remote Access
      setRemoteAccessEnabled(config.remoteAccessEnabled ?? false);
      setRemoteAccessPin(config.remoteAccessPin || '');

      if (incomingPrinterSignature !== syncedPrinterSignatureRef.current) {
        setSelectedPort(config.printerPort || '');
        setProtocol(config.printerProtocol || 'THERMAL');
        setBaudRate(config.printerBaudRate || 9600);
        setZebraPrinter(config.zebraPrinter || '');
        setLabelWidth(config.labelWidth || 50);
        setLabelHeight(config.labelHeight || 30);
        setMultiPrinterMode(deriveMultiPrinterMode(config));
        setPrinters(config.printers || {});
        syncedPrinterSignatureRef.current = incomingPrinterSignature;
      }
      setWindowsPrinters(prev => mergeWindowsPrinterOptions(prev, getConfiguredWindowsPrinterOptions(config)));
    }
  }, [config]);

  // ─── Auto-save: debounced save on any config state change ─────────────────
  const configSyncedRef = useRef(false);  // true once initial config has been synced to state
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mark config as synced after the config→state useEffect runs
  useEffect(() => {
    if (config) {
      // Defer so the setState batch from the sync effect settles first
      const id = setTimeout(() => { configSyncedRef.current = true; }, 0);
      return () => clearTimeout(id);
    }
  }, [config]);

  // Debounced auto-save whenever config-bearing state changes
  useEffect(() => {
    if (!configSyncedRef.current) return;  // skip initial config→state sync
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      const payload = buildGeneralConfigPayload();
      onConfigChange(payload);
      window.electronAPI.setAutoStart(autoStart).catch(() => {});
    }, 600);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [buildGeneralConfigPayload, autoStart, onConfigChange]);
  // ─── End auto-save ───────────────────────────────────────────────────────────
  const persistPrinterChanges = useCallback(async (
    payload: Partial<AgentConfig> = latestPrinterPayloadRef.current,
    options: { silent?: boolean } = {},
  ) => {
    const signature = getPrinterPayloadSignature(payload);
    if (signature === syncedPrinterSignatureRef.current) return;

    if (printerSaveInFlightRef.current) {
      pendingPrinterSaveRef.current = true;
      return;
    }

    printerSaveInFlightRef.current = true;
    if (!options.silent && componentMountedRef.current) {
      if (printerSaveStatusTimerRef.current) {
        clearTimeout(printerSaveStatusTimerRef.current);
      }
      setSavingPrinterChanges(true);
      setPrinterSaveResult(null);
    }

    try {
      await Promise.resolve(onConfigChange(payload));
      syncedPrinterSignatureRef.current = signature;
      failedPrinterSignatureRef.current = null;

      if (!options.silent && componentMountedRef.current) {
        setPrinterSaveResult({ success: true, message: 'Printer settings saved' });
      }
    } catch (error: any) {
      failedPrinterSignatureRef.current = signature;
      if (!options.silent && componentMountedRef.current) {
        setPrinterSaveResult({
          success: false,
          message: error?.message || 'Failed to save printer settings',
        });
      }
    } finally {
      printerSaveInFlightRef.current = false;

      if (!options.silent && componentMountedRef.current) {
        setSavingPrinterChanges(false);
        clearPrinterSaveResultLater();
      }

      if (pendingPrinterSaveRef.current) {
        pendingPrinterSaveRef.current = false;
        if (latestPrinterSignatureRef.current !== syncedPrinterSignatureRef.current) {
          void persistPrinterChanges(
            latestPrinterPayloadRef.current,
            { silent: !componentMountedRef.current },
          );
        }
      }
    }
  }, [clearPrinterSaveResultLater, onConfigChange]);

  useEffect(() => {
    if (!configSyncedRef.current) return;
    if (currentPrinterPayloadSignature === syncedPrinterSignatureRef.current) return;
    if (currentPrinterPayloadSignature === failedPrinterSignatureRef.current) return;

    if (printerAutoSaveTimerRef.current) clearTimeout(printerAutoSaveTimerRef.current);
    printerAutoSaveTimerRef.current = setTimeout(() => {
      void persistPrinterChanges(latestPrinterPayloadRef.current);
    }, 600);

    return () => {
      if (printerAutoSaveTimerRef.current) clearTimeout(printerAutoSaveTimerRef.current);
    };
  }, [currentPrinterPayloadSignature, persistPrinterChanges]);

  useEffect(() => {
    return () => {
      if (printerAutoSaveTimerRef.current) clearTimeout(printerAutoSaveTimerRef.current);
      if (latestPrinterSignatureRef.current !== syncedPrinterSignatureRef.current) {
        void persistPrinterChanges(latestPrinterPayloadRef.current, { silent: true });
      }
    };
  }, [persistPrinterChanges]);

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

  const openCustomPrinterForm = (printer?: ServerPrinterMapping) => {
    if (printer) {
      const printerType = ((printer.printerType || 'LABEL').toUpperCase() as PrinterTypeValue);
      const protocol = (printer.protocol || preferredProtocolForType(printerType)) as PrinterProtocol;
      setCustomPrinterForm({
        id: printer.id,
        displayName: printer.displayName || printer.name || '',
        printerType,
        protocol,
        windowsPrinterName: printer.windowsPrinterName || '',
        address: printer.address || '',
        paperWidth: printer.paperWidth || (printerType === 'LABEL' ? 100 : 80),
        paperHeight: printer.paperHeight || 150,
        isEnabled: printer.isEnabled ?? true,
      });
    } else {
      setCustomPrinterForm(emptyCustomPrinterForm());
    }
    setCustomPrinterModalOpen(true);
    setServerPrintersError(null);
  };

  const updateCustomPrinterForm = (updates: Partial<CustomPrinterForm>) => {
    setCustomPrinterForm(prev => {
      const next = { ...prev, ...updates };
      if (updates.printerType && updates.printerType !== prev.printerType) {
        next.protocol = preferredProtocolForType(updates.printerType);
        next.paperWidth = updates.printerType === 'LABEL' ? 100 : 80;
        next.paperHeight = updates.printerType === 'LABEL' ? 150 : prev.paperHeight;
      }
      return next;
    });
  };

  const buildCustomPrinterPayload = (form: CustomPrinterForm): Partial<ServerPrinterMapping> => {
    const usesWindowsPrinter = form.protocol === 'WINDOWS' || form.protocol === 'ZEBRA' || form.protocol === 'THERMAL';
    const paperWidth = form.paperWidth || (form.printerType === 'LABEL' ? 100 : 80);
    return {
      displayName: form.displayName.trim(),
      printerType: form.printerType,
      protocol: form.protocol,
      windowsPrinterName: usesWindowsPrinter ? form.windowsPrinterName.trim() : null,
      address: usesWindowsPrinter ? null : form.address.trim(),
      baudRate: 9600,
      paperWidth,
      paperHeight: form.printerType === 'LABEL' ? form.paperHeight : null,
      charsPerLine: charsPerLineFor(paperWidth),
      supportsCut: form.printerType !== 'LABEL' && form.printerType !== 'A4',
      supportsCashDrawer: form.printerType === 'RECEIPT',
      isEnabled: form.isEnabled,
    };
  };

  const handleSaveCustomPrinter = async () => {
    const payload = buildCustomPrinterPayload(customPrinterForm);
    if (!payload.displayName) {
      setServerPrintersError('Display name is required');
      return;
    }
    if ((payload.protocol === 'WINDOWS' || payload.protocol === 'ZEBRA' || payload.protocol === 'THERMAL') && !payload.windowsPrinterName) {
      setServerPrintersError('Windows printer is required');
      return;
    }
    if ((payload.protocol === 'POSNET' || payload.protocol === 'ELZAB_STX') && !payload.address) {
      setServerPrintersError('COM port or address is required');
      return;
    }
    if (payload.printerType === 'LABEL' && (!payload.paperWidth || !payload.paperHeight)) {
      setServerPrintersError('Label width and height are required');
      return;
    }

    setCustomPrinterSaving(true);
    setServerPrintersError(null);
    try {
      const response = customPrinterForm.id
        ? await window.electronAPI.printAgentPrinters.update(customPrinterForm.id, payload)
        : await window.electronAPI.printAgentPrinters.create(payload);
      setServerPrinters(normalizePrinterList(response));
      await loadLocalPrinterRows();
      await loadSharedPrinterRouting();
      setCustomPrinterModalOpen(false);
      setCustomPrinterForm(emptyCustomPrinterForm());
    } catch (err: any) {
      setServerPrintersError(err?.message || 'Failed to save custom printer');
    } finally {
      setCustomPrinterSaving(false);
    }
  };

  const handleDeleteCustomPrinter = async (printerId: string) => {
    setCustomPrinterDeletingId(printerId);
    setServerPrintersError(null);
    try {
      const response = await window.electronAPI.printAgentPrinters.delete(printerId);
      setServerPrinters(normalizePrinterList(response));
      await loadLocalPrinterRows();
      await loadSharedPrinterRouting();
    } catch (err: any) {
      setServerPrintersError(err?.message || 'Failed to delete custom printer');
    } finally {
      setCustomPrinterDeletingId(null);
    }
  };

  const handleAssignSharedPrinter = async (printerId: string) => {
    setSharedPrinterSavingId(printerId);
    setSharedPrintersError(null);
    try {
      await window.electronAPI.printAgentPrinters.upsertAssignment(SELF_CHECKOUT_RECEIPT_ROLE, printerId);
      await loadSharedPrinterRouting();
    } catch (err: any) {
      setSharedPrintersError(err?.message || 'Failed to save shared printer assignment');
    } finally {
      setSharedPrinterSavingId(null);
    }
  };

  const handleClearSharedPrinter = async () => {
    setSharedPrinterSavingId('clear');
    setSharedPrintersError(null);
    try {
      await window.electronAPI.printAgentPrinters.deleteAssignment(SELF_CHECKOUT_RECEIPT_ROLE);
      await loadSharedPrinterRouting();
    } catch (err: any) {
      setSharedPrintersError(err?.message || 'Failed to stop shared printer assignment');
    } finally {
      setSharedPrinterSavingId(null);
    }
  };

  const renderPaperControls = (printerType: PrinterTypeValue, printerConfig: PrinterConfig) => (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.paperWidth')} (mm)</label>
        <select
          value={printerConfig.paperWidth || 80}
          onChange={(e) => {
            const pw = parseInt(e.target.value);
            // Derive charsPerLine via the shared helper so the UI and formatter
            // keep the same paper-width mapping.
            updatePrinter(printerType, { paperWidth: pw, charsPerLine: charsPerLineFor(pw) });
          }}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
        >
          <option value={80}>80mm</option>
          <option value={76}>76mm</option>
          <option value={58}>58mm</option>
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.charsPerLine')}</label>
        <input
          type="number"
          value={printerConfig.charsPerLine || 48}
          onChange={(e) => updatePrinter(printerType, { charsPerLine: parseInt(e.target.value) || 48 })}
          min={20}
          max={80}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
        />
      </div>
    </div>
  );

  const handleRefreshPorts = async () => {
    try {
      await refreshPrinterDiscovery();
    } catch (err) {
      console.error('Failed to refresh ports:', err);
    }
  };

  const handleRefreshWindowsPrinters = async () => {
    try {
      await refreshPrinterDiscovery();
    } catch (err) {
      console.error('Failed to refresh Windows printers:', err);
    }
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
    if (testingPrinter) return;
    setTestingPrinter(printerType);
    setTestResult(null);
    setLiveSteps([]);
    // Subscribe to progress stream — main process emits one event per step
    const unsubscribe = window.electronAPI.onTestPrintProgress?.((step: any) => {
      setLiveSteps(prev => [...prev, step]);
    });
    try {
      const printerConfig = getPrinterConfig(printerType as PrinterTypeValue);
      // Force enabled=true so testPrinterByConfig can create the driver even before saving
      const result: any = await window.electronAPI.testPrinterByConfig({ ...printerConfig, enabled: true }, printerType);
      // New shape: { success, steps, modelName, charsetUsed, cutModeUsed } — old shape {success, error} still tolerated
      const firstFail = Array.isArray(result.steps) ? result.steps.find((s: any) => !s.ok) : null;
      setTestResult({
        printerType,
        success: !!result.success,
        error: result.error || firstFail?.error,
        steps: result.steps,
        modelName: result.modelName,
        charsetUsed: result.charsetUsed,
        cutModeUsed: result.cutModeUsed,
      });
    } catch (error: any) {
      setTestResult({ printerType, success: false, error: error.message });
    } finally {
      setTestingPrinter(null);
      if (typeof unsubscribe === 'function') unsubscribe();
      // Keep detail visible longer on failure so user can read the steps
      setTimeout(() => { setTestResult(null); setLiveSteps([]); }, 15000);
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
    if (testingPrinter) return;
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
      const status = await refreshPrinterDiscovery();

      // Auto-fill detected COM port into any POSNET-protocol printer that has no port or a wrong port
      if (status.posnetComPort) {
        const detectedPort = status.posnetComPort;

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
        if (dev.autoSetupEligible === false) continue;
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
        await refreshPrinterDiscovery();
        const updatedConfig = await window.electronAPI.getConfig();
        const incomingPrinterSignature = getPrinterPayloadSignature(buildPrinterPayloadFromConfig(updatedConfig));
        setMultiPrinterMode(deriveMultiPrinterMode(updatedConfig));
        setPrinters(updatedConfig?.printers || {});
        setSelectedPort(updatedConfig?.printerPort || '');
        setProtocol(updatedConfig?.printerProtocol || 'THERMAL');
        setBaudRate(updatedConfig?.printerBaudRate || 9600);
        setZebraPrinter(updatedConfig?.zebraPrinter || '');
        setLabelWidth(updatedConfig?.labelWidth || 50);
        setLabelHeight(updatedConfig?.labelHeight || 30);
        syncedPrinterSignatureRef.current = incomingPrinterSignature;
        await loadLocalPrinterRows();
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
        await refreshPrinterDiscovery();
      }
    } finally {
      setPosnetInstalling(false);
    }
  };

  /**
   * P6.1: Per-device refresh.
   *
   * Re-runs universal scan + targeted recovery for one specific detected device.
   * Used when a device shows up offline/missing and the user wants to verify
   * if it's back without re-running the full global "Detect Printers" sweep
   * across all hardware.
   *
   * Flow:
   *  1. Trigger universalScanDevices() — refreshes the universal device registry
   *     and runs markAllOffline() before re-detecting.
   *  2. Find the matching device in the universal registry by brand +
   *     windowsPrinterName/comPort.
   *  3. If matched device is not online, call universalRecoverDevice(id) —
   *     which scans for the device on a new port/printer name (e.g. POSNET
   *     migrated to a different COM port).
   *  4. Re-fetch posnetStatus to update the UI.
   */
  const handleRefreshDevice = async (dev: any, devKey: string) => {
    setRefreshingDevice(devKey);
    setRefreshDeviceResult(null);
    try {
      // Step 1: Fresh universal scan
      const scanResult = await window.electronAPI.universalScanDevices();
      const universalDevices: any[] = (scanResult && scanResult.devices) || [];

      // Step 2: Find matching device by brand + identifier
      const matched = universalDevices.find((d) => {
        if (d.brand !== dev.brand) return false;
        if (dev.windowsPrinterName && d.windowsPrinterName === dev.windowsPrinterName) return true;
        if (dev.comPort && d.port === dev.comPort) return true;
        if (dev.model && d.model === dev.model) return true;
        return false;
      });

      let recoveryMsg = '';
      if (matched && matched.id && matched.status !== 'online') {
        // Step 3: Targeted recovery for this device id
        const rec = await window.electronAPI.universalRecoverDevice(matched.id);
        recoveryMsg = rec.message || (rec.recovered ? 'Recovered' : 'Not found');
      }

      // Step 4: Refresh posnetStatus + ports + Windows printers
      const status = await refreshPrinterDiscovery();

      // Recompute presence from fresh scan: did our device come back?
      const stillThere = status.devices.some((d: any) =>
        d.brand === dev.brand && (
          (dev.windowsPrinterName && d.windowsPrinterName === dev.windowsPrinterName) ||
          (dev.comPort && d.comPort === dev.comPort) ||
          (dev.model && d.model === dev.model)
        )
      );

      setRefreshDeviceResult({
        key: devKey,
        success: stillThere,
        message: stillThere
          ? `${dev.brand} ${dev.model} is connected${recoveryMsg ? ` (${recoveryMsg})` : ''}`
          : `${dev.brand} ${dev.model} not detected${recoveryMsg ? ` (${recoveryMsg})` : ''}`,
      });
    } catch (err: any) {
      setRefreshDeviceResult({ key: devKey, success: false, message: err.message || 'Refresh failed' });
    } finally {
      setRefreshingDevice(null);
      setTimeout(() => setRefreshDeviceResult(null), 5000);
    }
  };

  /**
   * Diagnose a detected POSNET device on its COM port. Read-only probe —
   * shows the user where the communication chain breaks (port presence, VID,
   * port open, POSNET protocol response) and step-by-step printer-menu
   * guidance when the printer-side protocol is not POSNET.
   */
  const handleDiagnoseDevice = async (dev: DetectedPrinterDevice, devKey: string) => {
    if (!dev.comPort) return;
    setDiagnosingDevice(devKey);
    setDiagnoseResult(null);
    try {
      const receiptCfg = getPrinterConfig('RECEIPT');
      const baudRate = receiptCfg?.baudRate || 9600;
      const result = await window.electronAPI.posnetDiagnosePort(dev.comPort, baudRate);
      setDiagnoseResult({ key: devKey, result });
    } catch (err: any) {
      setDiagnoseResult({
        key: devKey,
        result: {
          port: dev.comPort,
          portPresent: false,
          portOpenable: false,
          vidMatch: false,
          posnetResponse: false,
          baudRate: 9600,
          diagnostic: { code: 'PORT_NOT_FOUND', detail: err?.message || 'Diagnose failed' },
          guidance: ['Unexpected error — check the app logs'],
          requiresManualSetup: false,
        },
      });
    } finally {
      setDiagnosingDevice(null);
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
        await refreshPrinterDiscovery();
        // Refresh printer config so Save doesn't overwrite auto-setup results
        const updatedConfig = await window.electronAPI.getConfig();
        const incomingPrinterSignature = getPrinterPayloadSignature(buildPrinterPayloadFromConfig(updatedConfig));
        setMultiPrinterMode(deriveMultiPrinterMode(updatedConfig));
        setPrinters(updatedConfig?.printers || {});
        setSelectedPort(updatedConfig?.printerPort || '');
        setProtocol(updatedConfig?.printerProtocol || 'THERMAL');
        setBaudRate(updatedConfig?.printerBaudRate || 9600);
        setZebraPrinter(updatedConfig?.zebraPrinter || '');
        setLabelWidth(updatedConfig?.labelWidth || 50);
        setLabelHeight(updatedConfig?.labelHeight || 30);
        syncedPrinterSignatureRef.current = incomingPrinterSignature;
        await loadLocalPrinterRows();
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
        await refreshPrinterDiscovery();
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

  const predefinedServerPrinters = serverPrinters.filter((printer) => printer.isPredefined);
  const customServerPrinters = serverPrinters.filter((printer) => !printer.isPredefined);
  const currentAgentId = config?.agentId || '';
  const sharedReceiptAssignment = printerAssignments.find((assignment) => assignment.role === SELF_CHECKOUT_RECEIPT_ROLE) || null;
  const sharedReceiptPrinter = sharedReceiptAssignment
    ? salonPrinters.find((printer) => printer.id === sharedReceiptAssignment.printerId) || null
    : null;
  const selectedSharedPrinterId = sharedReceiptAssignment?.printerId || '';
  const sharedReceiptPrinters = salonPrinters.filter((printer) => isSharedReceiptRouteCandidate(printer, selectedSharedPrinterId));
  const customFormAllowedProtocols = ALLOWED_PROTOCOLS_BY_TYPE[customPrinterForm.printerType as PrinterType] || [];
  const customFormUsesWindowsPrinter = customPrinterForm.protocol === 'WINDOWS'
    || customPrinterForm.protocol === 'ZEBRA'
    || customPrinterForm.protocol === 'THERMAL';
  const localOnlinePrinterCount = localPrinterRows.filter((printer) => printer.is_online === 1).length;
  const getLocalPrinterTarget = (printer: LocalPrinterMirrorRow): string => (
    printer.windows_printer_name || printer.port || printer.address || 'no target'
  );
  const isPrinterOwnedByThisPos = (printer: ServerPrinterMapping | SalonPrinterMapping): boolean => (
    !!currentAgentId && !!printer.agentId && printer.agentId === currentAgentId
  );
  const getServerPrinterOwnerLabel = (printer: ServerPrinterMapping | SalonPrinterMapping): string => {
    if (isPrinterOwnedByThisPos(printer)) {
      return name?.trim() ? `This POS (${name.trim()})` : 'This POS';
    }
    const agentName = (printer as SalonPrinterMapping).agentName?.trim();
    return agentName || (printer.agentId ? `POS ${shortId(printer.agentId)}` : 'Another POS');
  };
  const sharedReceiptOwnedByThisPos = !!sharedReceiptPrinter && isPrinterOwnedByThisPos(sharedReceiptPrinter);
  const sharedReceiptRouteReady = !!sharedReceiptPrinter
    && sharedReceiptPrinter.isEnabled !== false
    && !!sharedReceiptPrinter.agentIsOnline
    && !!sharedReceiptPrinter.isOnline;
  const currentPosHasShareableReceiptPrinter = sharedReceiptPrinters.some((printer) => isPrinterOwnedByThisPos(printer));
  const canManageSharedReceiptRoute = currentPosHasShareableReceiptPrinter || sharedReceiptOwnedByThisPos;
  const sharedReceiptOwnerLabel = sharedReceiptPrinter ? getServerPrinterOwnerLabel(sharedReceiptPrinter) : '';
  const sharedReceiptStatusTitle = sharedReceiptAssignment
    ? sharedReceiptOwnedByThisPos
      ? 'This POS is sharing receipts'
      : `This POS uses ${sharedReceiptOwnerLabel}`
    : 'Self-checkout receipts are not routed';
  const sharedReceiptStatusDescription = sharedReceiptAssignment
    ? sharedReceiptOwnedByThisPos
      ? 'Self-checkout receipts print from the printer connected to this POS.'
      : 'Route changes are managed on the POS that owns the shared printer.'
    : currentPosHasShareableReceiptPrinter
      ? 'Choose the receipt printer this POS should share with self-checkout.'
      : 'Set this up on the POS that has the receipt printer connected.';

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Settings sections" className="flex gap-2 rounded-lg border border-slate-200 bg-white p-1">
        {([
          { id: 'general' as const, label: t('settings.general'), icon: <LayoutDashboard size={15} /> },
          { id: 'pos' as const, label: t('settings.pos'), icon: <ShoppingCart size={15} /> },
          { id: 'printers' as const, label: t('settings.printers'), icon: <Printer size={15} /> },
        ]).map((tab) => {
          const active = settingsTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSettingsTab(tab.id)}
              className={`min-h-10 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {settingsTab === 'general' && (
        <>
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
        </>
      )}

      {settingsTab === 'printers' && (
        <>
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
              const brand = dev.brand || 'Unknown';
              const model = dev.model || 'Unknown';
              const isPosnet = brand === 'POSNET' || dev.vid === '1424';
              const isZebra = brand === 'Zebra' || dev.vid === '0A5F';
              const isDymo = brand === 'DYMO';
              const isBusy = settingUpDevice === `${brand}-${i}`;
              const modelLower = model.toLowerCase();

              // Smart type classification (mirrors backend classifyPrinterCategory)
              const isLabelPrinter = isZebra || isDymo ||
                ['ql-', 'td-', 'pt-', 'labelwriter', 'label'].some(p => modelLower.includes(p));
              const isThermalReceipt = !isPosnet && !isLabelPrinter && (
                ['Epson', 'Star Micronics', 'Citizen', 'Bixolon'].includes(brand) ||
                ['thermal', 'receipt', 'pos ', 'tm-t', 'tm-m', 'tsp', 'srp-', 'ct-s'].some(p => modelLower.includes(p))
              );
              const isA4Printer = !isPosnet && !isLabelPrinter && !isThermalReceipt &&
                ['HP', 'Canon', 'Samsung'].includes(brand) && dev.connectionType !== 'SERIAL';

              // Determine target type
              const fallbackTargetType: PrinterTypeValue = isPosnet ? 'FISCAL' :
                isLabelPrinter ? 'LABEL' :
                isA4Printer ? 'A4' : 'RECEIPT';
              const fallbackTargetProtocol: PrinterProtocol = isPosnet ? 'POSNET' :
                isZebra ? 'ZEBRA' :
                isA4Printer ? 'WINDOWS' : 'THERMAL';
              const targetType = (dev.targetType as PrinterTypeValue) || fallbackTargetType;
              const targetProtocol = (dev.recommendedProtocol as PrinterProtocol) || fallbackTargetProtocol;

              // Check if this device is already configured in the target slot
              const currentConfig = getPrinterConfig(targetType);
              const isAlreadyConfigured = currentConfig.enabled && (
                (targetProtocol === 'POSNET' && currentConfig.protocol === 'POSNET' && currentConfig.port === dev.comPort) ||
                (targetProtocol !== 'POSNET' && currentConfig.windowsPrinter === dev.windowsPrinterName)
              );

              return (
                <div key={`${dev.vid || brand}-${dev.comPort || dev.windowsPrinterName || dev.portName || i}`} className="bg-slate-50 rounded-lg px-3 py-2 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-slate-700">{brand} — {model}</div>
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

                  {dev.autoSetupEligible === false && (
                    <div className="text-amber-600">
                      {isPosnet
                        ? 'Manual configuration required - POSNET Thermal models can use POSNET or THEMAL on the printer. Set printer-side PC protocol to POSNET before choosing this COM port below.'
                        : 'Manual configuration required - choose the COM port and printer slot below.'}
                    </div>
                  )}

                  {/* Per-device actions */}
                  {(() => {
                    const devKey = `${brand}-${model}-${i}`;
                    const isRefreshing = refreshingDevice === devKey;
                    const refreshMsg = refreshDeviceResult?.key === devKey ? refreshDeviceResult : null;
                    return (
                  <>
                  {isAlreadyConfigured ? (
                    <div className="flex items-center justify-between pt-1">
                      <div className="text-green-600 font-medium">
                        ✓ Configured as {targetType} printer
                      </div>
                      {/* P6.1: Per-device refresh button — re-runs targeted recovery */}
                      <button
                        onClick={() => handleRefreshDevice(dev, devKey)}
                        disabled={isRefreshing}
                        title="Re-detect this device and recover if it moved to a new port"
                        className="px-2 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50 transition-colors flex items-center gap-1"
                      >
                        <svg className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        {isRefreshing ? 'Refreshing...' : 'Refresh'}
                      </button>
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
                      {(dev.driverInstalled || dev.comPort) && dev.autoSetupEligible !== false && (
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

                      {/* POSNET Thermal: Diagnose button for manual-protocol scenarios */}
                      {isPosnet && dev.autoSetupEligible === false && dev.comPort && (() => {
                        const isDiagnosing = diagnosingDevice === devKey;
                        return (
                          <button
                            onClick={() => handleDiagnoseDevice(dev, devKey)}
                            disabled={isDiagnosing}
                            title="Check where the POSNET communication chain breaks without printing"
                            className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                          >
                            <svg className={`w-3 h-3 ${isDiagnosing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-3-3v6m-9 0a9 9 0 1118 0 9 9 0 01-18 0z" />
                            </svg>
                            {isDiagnosing ? 'Diagnosing...' : 'Diagnose'}
                          </button>
                        );
                      })()}

                      {/* P6.1: Per-device refresh button (also shown for unconfigured) */}
                      <button
                        onClick={() => handleRefreshDevice(dev, devKey)}
                        disabled={isRefreshing}
                        title="Re-detect this device"
                        className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                      >
                        <svg className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        {isRefreshing ? 'Refreshing...' : 'Refresh'}
                      </button>
                    </div>
                  )}
                  {refreshMsg && (
                    <div className={`mt-1 text-[11px] ${refreshMsg.success ? 'text-green-600' : 'text-amber-600'}`}>
                      {refreshMsg.message}
                    </div>
                  )}
                  {diagnoseResult?.key === devKey && (() => {
                    const r = diagnoseResult.result;
                    const step = (ok: boolean | undefined, label: string) => (
                      <div className="flex items-start gap-1.5">
                        <span className={ok ? 'text-green-600' : 'text-amber-600'}>{ok ? '✓' : '✗'}</span>
                        <span className="text-slate-600">{label}</span>
                      </div>
                    );
                    return (
                      <div className="mt-2 p-2 bg-white rounded border border-slate-200 text-[11px] space-y-1">
                        <div className="font-medium text-slate-700 mb-1">Diagnostic result — {r.modelName || 'POSNET device'} on {r.port}</div>
                        {step(r.portPresent, `Port ${r.port} visible in Windows`)}
                        {step(r.vidMatch, `USB VID_1424 ${r.pidHex ? `PID_${r.pidHex.replace('0x', '')}` : ''} detected`)}
                        {step(r.portOpenable, 'Serial port can be opened')}
                        {step(r.posnetResponse, `POSNET v2 responds @ ${r.baudRate} baud`)}
                        {!r.posnetResponse && r.guidance.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-200">
                            <div className="font-medium text-slate-700 mb-1">
                              {r.requiresManualSetup ? 'Fix required on the printer:' : 'Try these steps:'}
                            </div>
                            <ol className="list-decimal pl-4 space-y-0.5 text-slate-600">
                              {r.guidance.map((s, idx) => <li key={idx}>{s}</li>)}
                            </ol>
                          </div>
                        )}
                        {r.posnetResponse && (
                          <div className="mt-2 pt-2 border-t border-slate-200 text-green-600 font-medium">
                            Ready — click Test Print or Auto Setup to finish.
                          </div>
                        )}
                        {r.diagnostic.detail && (
                          <div className="mt-2 pt-2 border-t border-slate-200 text-slate-500 text-[10px]">
                            <span className="font-mono">{r.diagnostic.code}</span>: {r.diagnostic.detail}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  </>
                    );
                  })()}
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
                        {printerType === 'FISCAL' && <Shield size={16} />}
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

                  {printerConfig.enabled && (() => {
                    // P5.3: Filter protocol options to only those allowed for this printer type.
                    // Source of truth lives in shared/types.ts ALLOWED_PROTOCOLS_BY_TYPE so the
                    // backend validation cannot drift apart from the dropdown.
                    const allowedProtocols = ALLOWED_PROTOCOLS_BY_TYPE[printerType as PrinterType] || [];
                    // If the saved protocol is not allowed for this slot (e.g. stale config),
                    // show it but flag it visually so the user knows to switch.
                    const currentIsAllowed = allowedProtocols.includes(printerConfig.protocol);
                    const labelTrKey = (proto: PrinterProtocol) => isLabel ? `protocol.${proto}.label` : `protocol.${proto}`;
                    const updateProtocol = (protocol: PrinterProtocol) => {
                      const targetReset: Partial<PrinterConfig> =
                        protocol === 'ELZAB_STX'
                          ? { windowsPrinter: '' }
                          : protocol === 'POSNET'
                            ? { windowsPrinter: '', address: '' }
                            : protocol === 'THERMAL'
                              ? { address: '' }
                              : { port: '', address: '' };
                      updatePrinter(printerType, { protocol, ...targetReset });
                    };
                    return (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.protocol')}</label>
                        <select
                          value={printerConfig.protocol}
                          onChange={(e) => updateProtocol(e.target.value as PrinterProtocol)}
                          className={`w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none ${
                            currentIsAllowed ? 'border-slate-300' : 'border-amber-400 bg-amber-50'
                          }`}
                        >
                          {allowedProtocols.map((proto) => (
                            <option key={proto} value={proto}>{t(labelTrKey(proto))}</option>
                          ))}
                          {!currentIsAllowed && (
                            <option value={printerConfig.protocol}>
                              {t(labelTrKey(printerConfig.protocol))} (invalid for {printerType})
                            </option>
                          )}
                        </select>
                        {!currentIsAllowed && (
                          <p className="mt-1 text-xs text-amber-700">
                            {printerConfig.protocol} is not valid for {printerType}. Allowed: {allowedProtocols.join(', ')}
                          </p>
                        )}
                      </div>

                      <PortProtocolMismatchBanner
                        port={printerConfig.port}
                        protocol={printerConfig.protocol}
                        onApplySuggested={(suggested) => updateProtocol(suggested)}
                      />

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
                      ) : printerConfig.protocol === 'ELZAB_STX' ? (
                        <>
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.comPort')} (USB CDC / RS232)</label>
                            <div className="flex gap-2">
                              <select
                                value={printerConfig.port || ''}
                                onChange={(e) => updatePrinter(printerType, { port: e.target.value, address: '', windowsPrinter: '' })}
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
                          <div className="relative flex items-center py-1">
                            <div className="flex-grow border-t border-slate-200" />
                            <span className="mx-2 text-xs text-slate-400">or IP / RNDIS</span>
                            <div className="flex-grow border-t border-slate-200" />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">IP address / host</label>
                            <input
                              type="text"
                              value={printerConfig.address || ''}
                              onChange={(e) => {
                                const address = e.target.value.trim();
                                updatePrinter(printerType, {
                                  address,
                                  ...(address ? { port: '', windowsPrinter: '' } : { windowsPrinter: '' }),
                                });
                              }}
                              placeholder="192.168.137.2"
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                            />
                            <p className="mt-1 text-xs text-slate-500">
                              Use COM after the USB CDC driver, or address for RNDIS/network setup. Fiscal commands still require the ELZAB sidecar and hardware.
                            </p>
                          </div>
                        </>
                      ) : printerConfig.protocol === 'THERMAL' ? (
                        <>
                          {/* USB / Windows Printer — for thermal USB printers */}
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.windowsPrinter')} (USB)</label>
                            <div className="flex gap-2">
                              <select
                                value={printerConfig.windowsPrinter || ''}
                                onChange={(e) => updatePrinter(printerType, { windowsPrinter: e.target.value, ...(e.target.value ? { port: '' } : {}) })}
                                className="flex-1 min-w-0 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none truncate"
                              >
                                <option value="">{t('settings.selectPrinter')}</option>
                                {getWindowsPrinterOptionsForSelect(windowsPrinters, printerConfig.windowsPrinter).map((p) => (
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
                          {/* Serial fallback — only show when no USB printer is selected */}
                          {!printerConfig.windowsPrinter && (
                            <>
                              <div className="relative flex items-center py-1">
                                <div className="flex-grow border-t border-slate-200" />
                                <span className="mx-2 text-xs text-slate-400">or serial</span>
                                <div className="flex-grow border-t border-slate-200" />
                              </div>
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
                          )}
                          {isPaperControlPrinterType(printerType) && renderPaperControls(printerType, printerConfig)}
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
                                {getWindowsPrinterOptionsForSelect(windowsPrinters, printerConfig.windowsPrinter).map((p) => (
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
                          {isPaperControlPrinterType(printerType) && printerConfig.protocol === 'WINDOWS' && renderPaperControls(printerType, printerConfig)}
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
                                    onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 10) updatePrinter(printerType, { labelWidth: 50 }); }}
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
                                    onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 10) updatePrinter(printerType, { labelHeight: 30 }); }}
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
                          disabled={testingPrinter !== null}
                          className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                            testingPrinter !== null
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
                        {/* Live progress while a test is running */}
                        {testingPrinter === printerType && liveSteps.length > 0 && (
                          <div className="mt-2 px-3 py-2 rounded-lg text-xs bg-slate-50 text-slate-700 font-mono">
                            {liveSteps.map((s, idx) => (
                              <div key={idx} className={s.ok ? 'text-emerald-700' : 'text-red-700'}>
                                {s.ok ? '✓' : '✗'} {s.step}{s.detail ? ` — ${s.detail}` : ''}{s.error ? ` — ${s.error}` : ''}
                              </div>
                            ))}
                          </div>
                        )}
                        {/* Test Result — detailed on failure */}
                        {testResult && testResult.printerType === printerType && (
                          <div className={`mt-2 px-3 py-2 rounded-lg text-xs ${
                            testResult.success
                              ? 'bg-green-50 text-green-700'
                              : 'bg-red-50 text-red-700'
                          }`}>
                            <div className="font-medium">
                              {testResult.success ? t('test.success') : `${t('test.error')}: ${testResult.error || 'Unknown error'}`}
                            </div>
                            {(testResult.modelName || testResult.charsetUsed) && (
                              <div className="mt-1 text-[11px] opacity-80">
                                {testResult.modelName && <span>Model: {testResult.modelName}</span>}
                                {testResult.charsetUsed && <span> · charset: {testResult.charsetUsed}</span>}
                                {testResult.cutModeUsed && <span> · cut: {testResult.cutModeUsed}</span>}
                              </div>
                            )}
                            {!testResult.success && testResult.steps && testResult.steps.length > 0 && (
                              <div className="mt-2 font-mono text-[11px] space-y-0.5">
                                {testResult.steps.map((s, idx) => (
                                  <div key={idx} className={s.ok ? 'text-emerald-700' : 'text-red-700'}>
                                    {s.ok ? '✓' : '✗'} {s.step}{s.detail ? ` — ${s.detail}` : ''}{s.error ? ` — ${s.error}` : ''}
                                  </div>
                                ))}
                              </div>
                            )}
                            {!testResult.success && (
                              <button
                                onClick={() => window.electronAPI.openLogFolder?.()}
                                className="mt-2 px-2 py-1 rounded bg-white/70 text-slate-800 hover:bg-white text-[11px] font-medium"
                              >
                                Open log folder
                              </button>
                            )}
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
                    );
                  })()}
                </div>
              );
            })}

            <div className="border border-slate-200 rounded-lg p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg ${
                    sharedReceiptRouteReady ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
                  }`}>
                    {sharedReceiptRouteReady ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800">Self-checkout receipt printing</h3>
                    <p className="text-sm text-slate-700 mt-1">{sharedReceiptStatusTitle}</p>
                    <p className="text-xs text-slate-500 mt-1">{sharedReceiptStatusDescription}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => loadSharedPrinterRouting()}
                    disabled={sharedPrintersLoading}
                    className="min-h-10 px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {sharedPrintersLoading ? 'Loading...' : 'Refresh'}
                  </button>
                  {selectedSharedPrinterId && sharedReceiptOwnedByThisPos && (
                    <button
                      type="button"
                      onClick={() => handleClearSharedPrinter()}
                      disabled={sharedPrinterSavingId === 'clear'}
                      className="min-h-10 px-3 py-2 border border-red-200 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {sharedPrinterSavingId === 'clear' ? 'Stopping...' : 'Stop sharing'}
                    </button>
                  )}
                </div>
              </div>

              {sharedPrintersError && (
                <div className="mt-3 px-3 py-2 rounded-lg text-xs bg-red-50 text-red-700">
                  {sharedPrintersError}
                </div>
              )}

              {sharedReceiptAssignment && sharedReceiptPrinter && (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                          <Share2 size={15} />
                          {getServerPrinterName(sharedReceiptPrinter)}
                        </span>
                        <span className={`text-[11px] px-2 py-1 rounded-full ${
                          sharedReceiptOwnedByThisPos ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {sharedReceiptOwnedByThisPos ? 'Shared from this POS' : 'Used by this POS'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-600">
                        {getServerPrinterOwnerLabel(sharedReceiptPrinter)} - {getServerPrinterTarget(sharedReceiptPrinter)}
                      </div>
                      <details className="mt-2 text-[11px] text-slate-500">
                        <summary className="cursor-pointer select-none">Technical details</summary>
                        <div className="mt-1 font-mono break-all">
                          Printer ID: {sharedReceiptAssignment.printerId}<br />
                          Agent ID: {sharedReceiptPrinter.agentId || 'unknown'}
                        </div>
                      </details>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px] md:justify-end">
                      <span className={`px-2 py-1 rounded-full ${sharedReceiptPrinter.agentIsOnline ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                        {sharedReceiptPrinter.agentIsOnline ? 'POS app online' : 'POS app offline'}
                      </span>
                      <span className={`px-2 py-1 rounded-full ${sharedReceiptPrinter.isOnline ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                        {sharedReceiptPrinter.isOnline ? 'Printer online' : 'Printer offline'}
                      </span>
                      <span className={`px-2 py-1 rounded-full ${sharedReceiptPrinter.isEnabled !== false ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                        {sharedReceiptPrinter.isEnabled !== false ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {!sharedReceiptAssignment && (
                <div className="mt-4 rounded-lg border border-dashed border-slate-200 px-3 py-3 text-sm text-slate-600">
                  No printer is selected for self-checkout receipts.
                </div>
              )}

              <div className="mt-4 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Available receipt printers
                </div>
                {sharedReceiptPrinters.length === 0 && (
                  <div className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                    {sharedPrintersLoading ? 'Loading salon receipt printers...' : 'No shareable receipt printers found'}
                  </div>
                )}
                {sharedReceiptPrinters.map((printer) => {
                  const selected = selectedSharedPrinterId === printer.id;
                  const disabled = printer.isEnabled === false;
                  const ownedByThisPos = isPrinterOwnedByThisPos(printer);
                  const canUseThisPrinter = ownedByThisPos && !disabled;
                  return (
                    <div key={printer.id} className={`border rounded-lg px-3 py-2 ${selected ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200'}`}>
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-medium text-slate-800 truncate">{getServerPrinterName(printer)}</div>
                            {selected && (
                              <span className="text-[11px] px-2 py-1 rounded-full bg-brand-100 text-brand-700">In use</span>
                            )}
                            <span className="text-[11px] px-2 py-1 rounded-full bg-slate-100 text-slate-600">
                              {ownedByThisPos ? 'This POS' : getServerPrinterOwnerLabel(printer)}
                            </span>
                          </div>
                          <div className="mt-1 grid gap-1 text-xs text-slate-500 md:grid-cols-3">
                            <span className="truncate">{printer.protocol || 'UNKNOWN'}</span>
                            <span className="truncate">{getServerPrinterTarget(printer)}</span>
                            <span className="truncate">{printer.agentIsOnline ? 'POS app online' : 'POS app offline'}</span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 md:items-end">
                          <div className="flex flex-wrap gap-1.5 text-[11px] md:justify-end">
                            <span className={`px-2 py-1 rounded-full ${printer.isOnline ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                              {printer.isOnline ? 'Printer online' : 'Printer offline'}
                            </span>
                            <span className={`px-2 py-1 rounded-full ${printer.isEnabled !== false ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                              {printer.isEnabled !== false ? 'Enabled' : 'Disabled'}
                            </span>
                          </div>
                          {selected ? (
                            ownedByThisPos ? (
                              <button
                                type="button"
                                onClick={() => handleClearSharedPrinter()}
                                disabled={sharedPrinterSavingId === 'clear'}
                                className="min-h-10 px-3 py-2 rounded-lg border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                              >
                                {sharedPrinterSavingId === 'clear' ? 'Stopping...' : 'Stop sharing'}
                              </button>
                            ) : (
                              <div className="min-h-10 px-3 py-2 rounded-lg bg-slate-100 text-sm font-medium text-slate-500">
                                Managed on owner POS
                              </div>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleAssignSharedPrinter(printer.id)}
                              disabled={!canUseThisPrinter || sharedPrinterSavingId === printer.id}
                              className={`min-h-10 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                canUseThisPrinter
                                  ? 'bg-brand-600 text-white hover:bg-brand-700'
                                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                              }`}
                            >
                              {sharedPrinterSavingId === printer.id
                                ? 'Saving...'
                                : ownedByThisPos
                                  ? 'Use for self-checkout'
                                  : 'Choose on owner POS'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!canManageSharedReceiptRoute && selectedSharedPrinterId && (
                  <div className="text-xs text-slate-500">
                    This POS can use the shared route, but it cannot change the salon-wide printer choice because the printer is owned by another POS.
                  </div>
                )}
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-sm font-medium text-slate-700">Local printer config (this POS)</h3>
                  <p className="text-xs text-slate-500 mt-0.5 break-all">Agent ID: {currentAgentId || 'not paired'}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Edit these rows only on the POS that owns the connected printer. If two POS devices show the same agent ID, re-pair one device before editing.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => loadServerPrinters()}
                    disabled={serverPrintersLoading || !config?.agentId}
                    className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={() => openCustomPrinterForm()}
                    disabled={!config?.agentId}
                    className="px-3 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    <Plus size={15} />
                    Add printer
                  </button>
                </div>
              </div>

              {serverPrintersError && (
                <div className="mt-3 px-3 py-2 rounded-lg text-xs bg-red-50 text-red-700">
                  {serverPrintersError}
                </div>
              )}

              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Predefined</div>
                  <div className="space-y-2">
                    {predefinedServerPrinters.length === 0 && (
                      <div className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                        {serverPrintersLoading ? 'Loading predefined printers...' : 'No predefined printers loaded'}
                      </div>
                    )}
                    {predefinedServerPrinters.map((printer) => (
                      <div key={printer.id} className="border border-slate-200 rounded-lg px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-700 truncate">{printer.displayName || printer.name || printer.printerType}</div>
                            <div className="text-xs text-slate-500 truncate">
                              {printer.printerType} · {printer.windowsPrinterName || printer.address || 'no target'}
                            </div>
                          </div>
                          <span className={`text-[11px] px-2 py-1 rounded-full ${printer.isEnabled ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                            {printer.isEnabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </div>
                        {printer.printerType === 'LABEL' && (
                          <div className="mt-1 text-xs text-slate-500">
                            {printer.paperWidth || '?'} x {printer.paperHeight || '?'} mm
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Custom printers</div>
                  <div className="space-y-2">
                    {customServerPrinters.length === 0 && (
                      <div className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                        {serverPrintersLoading ? 'Loading custom printers...' : 'No custom printers yet'}
                      </div>
                    )}
                    {customServerPrinters.map((printer) => (
                      <div key={printer.id} className="border border-slate-200 rounded-lg px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-700 truncate">{printer.displayName || printer.name || printer.printerType}</div>
                            <div className="text-xs text-slate-500 truncate">
                              {printer.printerType} · {printer.protocol} · {printer.windowsPrinterName || printer.address || 'no target'}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openCustomPrinterForm(printer)}
                              className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
                              title="Edit printer"
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteCustomPrinter(printer.id)}
                              disabled={customPrinterDeletingId === printer.id}
                              className="p-2 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-50"
                              title="Delete printer"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                          <span>{printer.isEnabled ? 'Enabled' : 'Disabled'}</span>
                          {printer.printerType === 'LABEL' && (
                            <span>{printer.paperWidth || '?'} x {printer.paperHeight || '?'} mm</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {customPrinterModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
                  <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
                    <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                      <h3 className="text-sm font-semibold text-slate-800">
                        {customPrinterForm.id ? 'Edit custom printer' : 'Add custom printer'}
                      </h3>
                      <button
                        type="button"
                        onClick={() => setCustomPrinterModalOpen(false)}
                        className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <div className="space-y-3 px-4 py-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">Display name</label>
                        <input
                          type="text"
                          value={customPrinterForm.displayName}
                          onChange={(e) => updateCustomPrinterForm({ displayName: e.target.value })}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                          placeholder="Xprinter 100x150"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
                          <select
                            value={customPrinterForm.printerType}
                            onChange={(e) => updateCustomPrinterForm({ printerType: e.target.value as PrinterTypeValue })}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                          >
                            {PRINTER_TYPES.map((printerType) => (
                              <option key={printerType} value={printerType}>{printerType}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Protocol</label>
                          <select
                            value={customPrinterForm.protocol}
                            onChange={(e) => updateCustomPrinterForm({ protocol: e.target.value as PrinterProtocol })}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                          >
                            {customFormAllowedProtocols.map((protocolOption) => (
                              <option key={protocolOption} value={protocolOption}>{protocolOption}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {customFormUsesWindowsPrinter ? (
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Windows printer</label>
                          <select
                            value={customPrinterForm.windowsPrinterName}
                            onChange={(e) => updateCustomPrinterForm({ windowsPrinterName: e.target.value })}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                          >
                            <option value="">Select printer</option>
                            {getWindowsPrinterOptionsForSelect(windowsPrinters, customPrinterForm.windowsPrinterName).map((printer) => (
                              <option key={printer.name} value={printer.name}>{printer.name}{printer.port ? ` [${printer.port}]` : ''}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">COM port / address</label>
                          <input
                            type="text"
                            value={customPrinterForm.address}
                            onChange={(e) => updateCustomPrinterForm({ address: e.target.value })}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                            placeholder={ports[0] || 'COM3'}
                          />
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">Paper width (mm)</label>
                          <input
                            type="number"
                            min={5}
                            max={1000}
                            value={customPrinterForm.paperWidth || ''}
                            onChange={(e) => updateCustomPrinterForm({ paperWidth: parseInt(e.target.value) || 0 })}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                          />
                        </div>
                        {customPrinterForm.printerType === 'LABEL' && (
                          <div>
                            <label className="block text-xs font-medium text-slate-600 mb-1">Paper height (mm)</label>
                            <input
                              type="number"
                              min={5}
                              max={1000}
                              value={customPrinterForm.paperHeight || ''}
                              onChange={(e) => updateCustomPrinterForm({ paperHeight: parseInt(e.target.value) || 0 })}
                              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                            />
                          </div>
                        )}
                      </div>

                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={customPrinterForm.isEnabled}
                          onChange={(e) => updateCustomPrinterForm({ isEnabled: e.target.checked })}
                          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
                        />
                        Enabled
                      </label>
                    </div>
                    <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setCustomPrinterModalOpen(false)}
                        className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveCustomPrinter}
                        disabled={customPrinterSaving}
                        className="px-3 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                      >
                        {customPrinterSaving ? 'Saving...' : 'Save printer'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
          </div>

            <details className="border border-slate-200 rounded-lg p-4">
              <summary className="cursor-pointer select-none list-none">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-slate-700">Advanced diagnostics: SQLite mirror</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {localOnlinePrinterCount} online / {localPrinterRows.length} mirrored rows
                    </p>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Debug cache only. It shows what this POS last synced locally, not the salon-wide sharing choice.
                    </p>
                  </div>
                  <span className="text-xs font-medium text-slate-500">Open advanced</span>
                </div>
              </summary>

              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadLocalPrinterRows()}
                  disabled={localPrinterRowsLoading}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {localPrinterRowsLoading ? 'Loading...' : 'Refresh SQLite'}
                </button>
                <button
                  type="button"
                  onClick={() => loadServerPrinters()}
                  disabled={serverPrintersLoading || !config?.agentId}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  Reload backend
                </button>
              </div>

              {localPrinterRowsError && (
                <div className="mt-3 px-3 py-2 rounded-lg text-xs bg-red-50 text-red-700">
                  {localPrinterRowsError}
                </div>
              )}

              <div className="mt-4 space-y-2">
                {localPrinterRows.length === 0 && (
                  <div className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                    {localPrinterRowsLoading ? 'Loading SQLite printer rows...' : 'No local printer rows in SQLite yet'}
                  </div>
                )}
                {localPrinterRows.map((printer) => (
                  <div key={printer.id} className="border border-slate-200 rounded-lg px-3 py-2">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-700 truncate">
                          {printer.display_name || printer.name || printer.printer_type || 'Printer'}
                        </div>
                        <div className="mt-1 text-[11px] font-mono text-slate-500 break-all">
                          {printer.id}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        <span className={`px-2 py-1 rounded-full ${printer.is_online === 1 ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                          {printer.is_online === 1 ? 'Online' : 'Offline'}
                        </span>
                        <span className={`px-2 py-1 rounded-full ${printer.is_enabled === 1 ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                          {printer.is_enabled === 1 ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-slate-500 md:grid-cols-4">
                      <span>{printer.printer_type || 'UNKNOWN'}</span>
                      <span>{printer.protocol}</span>
                      <span className="truncate">{getLocalPrinterTarget(printer)}</span>
                      <span className="truncate">seen: {printer.last_seen_at || '-'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </details>
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
                      {getWindowsPrinterOptionsForSelect(windowsPrinters, zebraPrinter).map((p) => (
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
                  {getWindowsPrinterOptionsForSelect(windowsPrinters, zebraPrinter).length === 0 && (
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
                disabled={testingPrinter !== null}
                className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  testingPrinter !== null
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

        <div className="mt-4 pt-4 border-t border-slate-200 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-slate-500">
            Printer changes save automatically. Leaving this tab keeps detected printers, assignments, and label dimensions.
          </p>
          <div className="flex items-center gap-2">
            {savingPrinterChanges && (
              <span className="text-xs text-slate-500">Saving printer settings...</span>
            )}
            {!savingPrinterChanges && printerSaveResult && (
              <span className={`text-xs ${printerSaveResult.success ? 'text-green-600' : 'text-red-600'}`}>
                {printerSaveResult.message}
              </span>
            )}
          </div>
        </div>
          </div>
        </>
      )}

      {settingsTab === 'pos' && (
        <>
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

            {/* Receipt / Paragon Settings */}
            <div className="border-t border-slate-200 pt-4 mt-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">
                {t('settings.receiptHeader')}
              </h3>
              <p className="text-xs text-slate-500 mb-3">
                {t('settings.receiptHeaderDesc')}
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('settings.receiptSellerName')}
                  </label>
                  <input
                    type="text"
                    value={receiptSellerName}
                    onChange={(e) => setReceiptSellerName(e.target.value)}
                    placeholder="P.T.H. BAKS Sławomir Chądzyński"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('settings.receiptSellerAddress')}
                  </label>
                  <input
                    type="text"
                    value={receiptSellerAddress}
                    onChange={(e) => setReceiptSellerAddress(e.target.value)}
                    placeholder="ul. Łączności 35, 32-020 Wieliczka"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    {t('settings.receiptSellerNip')}
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={receiptSellerNip}
                    onChange={(e) => setReceiptSellerNip(e.target.value)}
                    placeholder="522-005-23-49"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                  />
                </div>
                {(!receiptSellerName || !receiptSellerNip) && (
                  <div className="flex items-start gap-2 p-2 bg-amber-50 rounded-lg border border-amber-200">
                    <svg className="w-4 h-4 mt-0.5 text-amber-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    <p className="text-xs text-amber-700">
                      {t('settings.receiptSellerWarning')}
                    </p>
                  </div>
                )}
              </div>
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

            {customerDisplayEnabled && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('settings.customerDisplayProfile')}
                </label>
                <select
                  ref={customerDisplayProfileSelectRef}
                  value={customerDisplayProfile}
                  onChange={(e) => {
                    const nextProfile = e.target.value as LiveCustomerDisplayProfile;
                    customerDisplayProfileRef.current = nextProfile;
                    setCustomerDisplayProfile(nextProfile);
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                >
                  <option value="retail_assisted">{t('settings.customerDisplayProfile.retail_assisted')}</option>
                  <option value="salon_checkin">{t('settings.customerDisplayProfile.salon_checkin')}</option>
                  <option value="promo_only">{t('settings.customerDisplayProfile.promo_only')}</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  {t('settings.customerDisplayProfileDesc')}
                </p>
              </div>
            )}

            {/* Open Customer Display Button */}
            {customerDisplayEnabled && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    if (autoSaveTimerRef.current) {
                      clearTimeout(autoSaveTimerRef.current);
                      autoSaveTimerRef.current = null;
                    }
                    const currentCustomerDisplayProfile = (
                      customerDisplayProfileSelectRef.current?.value as LiveCustomerDisplayProfile | undefined
                    ) || customerDisplayProfileRef.current;
                    const payload = buildGeneralConfigPayload({
                      customerDisplayProfile: currentCustomerDisplayProfile,
                    });
                    await Promise.resolve(onConfigChange(payload));
                    window.electronAPI.setAutoStart(autoStart).catch(() => {});
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

            {/* Force Fullscreen Kiosk */}
            {customerDisplayEnabled && (
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-slate-600">
                    {t('settings.customerDisplayForceKiosk')}
                  </label>
                  <p className="text-xs text-slate-500 mt-1">
                    {t('settings.customerDisplayForceKioskDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCustomerDisplayForceKiosk(!customerDisplayForceKiosk)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 mt-1 ${
                    customerDisplayForceKiosk ? 'bg-brand-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      customerDisplayForceKiosk ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
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

        </>
      )}

      {settingsTab === 'general' && (
        <>
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

        </>
      )}

      {/* Auto-save indicator */}
      <p className="text-center text-xs text-slate-400">{t('settings.autoSaveHint')}</p>
    </div>
  );
}
