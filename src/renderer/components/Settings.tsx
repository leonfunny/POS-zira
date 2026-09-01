import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AgentConfig, PrinterProtocol, PrinterConfig, PrintersConfig, SshTunnelStatus, UpdateStatus, Tab, ALLOWED_PROTOCOLS_BY_TYPE, PrinterType, LiveCustomerDisplayProfile, PosnetDiagnoseResult, charsPerLineFor, ServerPrinterMapping, LocalPrinterMirrorRow, SalonPrinterMapping, SalonPrinterAssignment, SalonPrinterRole, ScaleConnectionMode, ScaleDiagnoseStep, FiscalDailyReportPrintResponse, LanFirstKitchenNetworkInfo, LanFirstKitchenPairingStatus, LanFirstKitchenTestRouteResponse, POS_MODES, isPosMode, type PosMode } from '../../shared/types';
import { resolveCustomerDisplayProfile } from '../../shared/customer-display-profile';
import { DEFAULT_LAN_FIRST_KITCHEN_PORT, getReadyKitchenWifiPrinters, planLanKitchenSave, resolveLanFirstKitchenTimeoutMs } from '../../shared/lan-first-kitchen-settings';
import { Language, languageNames, getTranslation, printerTypeIcons } from '../i18n/translations';
import TelegramConfig from './TelegramConfig';
import CategoryRankingSettings from './pos/CategoryRankingSettings';
import StaffManagementSettings from './pos/StaffManagementSettings';
import ConfirmActionDialog from './pos/ConfirmActionDialog';
import FabricTagComposer from './label/FabricTagComposer';
import { isFabricTagPrinterReady, supportsLabelMediaCalibration } from './label/fabric-tag-printer';
import rlog from '../utils/logger';
import QRCode from 'qrcode';
import { ShoppingCart, LayoutDashboard, FileText, Shield, Printer, Tag, Ticket, UtensilsCrossed, Shirt, Plus, Pencil, Trash2, X, CheckCircle2, AlertTriangle, Share2, Wand2, Scale, LayoutGrid, Clock, Image as ImageIcon, Video, ArrowUp, ArrowDown, Upload } from 'lucide-react';
import ModuleManager from './ModuleManager';
import TextInput from './shared/TextInput';
import { matchesSettingSection } from './settings-search';

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
  /** Plan/entitlement default for a tab — used by the Module Manager for the
   *  default toggle state and the "outside plan" badge. */
  isModuleEntitled?: (tab: Tab) => boolean;
}

type TvAdMediaItem = {
  id: string;
  filename: string;
  order: number;
  enabled: boolean;
  type?: 'video' | 'image';
  durationMs?: number;
};

// Printer types - defined locally for Vite compatibility
const PRINTER_TYPES = ['RECEIPT', 'FISCAL', 'LABEL', 'FABRIC_TAG', 'A4', 'TICKET', 'KITCHEN'] as const;
type PrinterTypeValue = typeof PRINTER_TYPES[number];
/** Slots that print on label media and expose label width/height + calibration. */
const LABEL_MEDIA_PRINTER_TYPES = ['LABEL', 'FABRIC_TAG'] as const;
const isLabelMediaType = (printerType: string): boolean =>
  LABEL_MEDIA_PRINTER_TYPES.includes(printerType as typeof LABEL_MEDIA_PRINTER_TYPES[number]);
type SettingsTab = 'general' | 'pos' | 'printers' | 'modules';
const SELF_CHECKOUT_RECEIPT_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT';
const PAPER_CONTROL_PRINTER_TYPES = ['RECEIPT', 'TICKET', 'KITCHEN'] as const;
const DEFAULT_SCALE_SHARE_PORT = 17891;
const DEFAULT_REMOTE_SCALE_TIMEOUT_MS = 2000;
const FISCAL_DAILY_REPORT_CONFIRM_BODY = 'This will close the current fiscal day on the ELZAB printer now. Continue only if you are physically beside the printer and ready to collect the report.';
type FiscalOnCashSaleMode = NonNullable<AgentConfig['fiscalOnCashSale']>;
const FISCAL_ON_CASH_SALE_OPTIONS: Array<{
  value: FiscalOnCashSaleMode;
  labelKey: string;
  fallback: string;
}> = [
  { value: 'always', labelKey: 'settings.fiscalOnCashSale.always', fallback: 'Always print' },
  { value: 'never', labelKey: 'settings.fiscalOnCashSale.never', fallback: 'Never print' },
  { value: 'ask', labelKey: 'settings.fiscalOnCashSale.ask', fallback: 'Ask each time' },
];
type FiscalDailyReportSettings = NonNullable<AgentConfig['fiscalDailyReport']>;
type NormalizedFiscalDailyReportSettings = Required<FiscalDailyReportSettings>;
const DEFAULT_FISCAL_DAILY_REPORT_SETTINGS: NormalizedFiscalDailyReportSettings = {
  enabled: false,
  master: false,
  hour: 23,
  minute: 58,
  timezone: 'Europe/Warsaw',
  retryMinutes: 5,
  maxAttempts: 3,
  unconditionally: false,
};
const FISCAL_DAILY_REPORT_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const FISCAL_DAILY_REPORT_MINUTES = Array.from({ length: 60 }, (_, minute) => minute);
const FISCAL_DAILY_REPORT_RETRY_OPTIONS = [0, 1, 2, 3, 4, 5];
const FISCAL_DAILY_REPORT_RETRY_MINUTE_OPTIONS = [1, 2, 3, 5, 10, 15, 30, 60];
const FISCAL_DAILY_REPORT_MAX_ATTEMPTS = Math.max(...FISCAL_DAILY_REPORT_RETRY_OPTIONS) + 1;
const FISCAL_DAILY_REPORT_TIMEZONE = 'Europe/Warsaw';

function deriveScaleConnection(scale?: AgentConfig['scale'] | null): ScaleConnectionMode {
  if (!scale?.enabled) return 'none';
  if (scale.connection === 'remote') return 'remote';
  if (scale.connection === 'none') return 'none';
  return 'local';
}

function createScalePairingCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function parseScalePortNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  return fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeFiscalDailyReportSettings(
  input?: FiscalDailyReportSettings | null,
): NormalizedFiscalDailyReportSettings {
  return {
    enabled: !!input?.enabled,
    master: !!input?.master,
    hour: clampInt(input?.hour, DEFAULT_FISCAL_DAILY_REPORT_SETTINGS.hour, 0, 23),
    minute: clampInt(input?.minute, DEFAULT_FISCAL_DAILY_REPORT_SETTINGS.minute, 0, 59),
    timezone: input?.timezone === FISCAL_DAILY_REPORT_TIMEZONE
      ? input.timezone
      : DEFAULT_FISCAL_DAILY_REPORT_SETTINGS.timezone,
    retryMinutes: clampInt(input?.retryMinutes, DEFAULT_FISCAL_DAILY_REPORT_SETTINGS.retryMinutes, 1, 60),
    maxAttempts: clampInt(input?.maxAttempts, DEFAULT_FISCAL_DAILY_REPORT_SETTINGS.maxAttempts, 1, FISCAL_DAILY_REPORT_MAX_ATTEMPTS),
    unconditionally: !!input?.unconditionally,
  };
}

function fiscalDailyReportTimeValue(settings: NormalizedFiscalDailyReportSettings): string {
  return `${String(settings.hour).padStart(2, '0')}:${String(settings.minute).padStart(2, '0')}`;
}

type SalonPrinterRouteDefinition = {
  role: SalonPrinterRole;
  printerType: PrinterTypeValue;
  title: string;
  description: string;
  enabled: boolean;
  blocking?: boolean;
};

const SALON_PRINTER_ROUTES: SalonPrinterRouteDefinition[] = [
  {
    role: SELF_CHECKOUT_RECEIPT_ROLE,
    printerType: 'RECEIPT',
    title: 'Self-checkout receipts',
    description: 'Order copies can be routed to a receipt printer owned by any online POS.',
    enabled: true,
  },
  {
    role: 'POS_RECEIPT',
    printerType: 'RECEIPT',
    title: 'POS order copies',
    description: 'Future route for cashier order copies. Local receipt printing remains unchanged until backend support lands.',
    enabled: false,
  },
  {
    role: 'FISCAL_RECEIPT',
    printerType: 'FISCAL',
    title: 'Fiscal receipts',
    description: 'POS fiscal receipts can route to a ready fiscal printer owned by another online POS.',
    enabled: true,
    blocking: true,
  },
  {
    role: 'KITCHEN',
    printerType: 'KITCHEN',
    title: 'Kitchen tickets',
    description: 'Kitchen self-order tickets can route to a kitchen printer owned by any online POS.',
    enabled: true,
  },
  {
    role: 'LABEL',
    printerType: 'LABEL',
    title: 'Labels',
    description: 'Future route for label printers.',
    enabled: false,
  },
  {
    role: 'A4',
    printerType: 'A4',
    title: 'A4 documents',
    description: 'Future route for office printers.',
    enabled: false,
  },
];

function isPaperControlPrinterType(printerType: PrinterTypeValue): boolean {
  return PAPER_CONTROL_PRINTER_TYPES.includes(printerType as typeof PAPER_CONTROL_PRINTER_TYPES[number]);
}

function printerTypeLabel(t: (key: string) => string, printerType?: string | null): string {
  const value = String(printerType || '').toUpperCase();
  if (!value) return 'Printer';
  const key = `printer.${value}`;
  const translated = t(key);
  return translated && translated !== key ? translated : value;
}

/**
 * What a fabric tag slot should look like before anyone touches it.
 *
 * The generic label defaults describe a 50x30 shelf label; care-label ribbon
 * is a 20mm continuous strip, and offering the shelf numbers means the first
 * print renders 320 dots into a 160-dot head. The height is a ceiling, not a
 * target -- the tag is trimmed to its content before printing.
 */
const FABRIC_TAG_DEFAULTS: Partial<PrinterConfig> = {
  labelWidth: 20,
  labelHeight: 60,
  mediaSensor: 'none',
  printSpeed: 2,
  printDensity: 12,
};

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
  // FABRIC_TAG only allows TSPL, so the WINDOWS preference falls through to it.
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

function isServerPrinterType(printer: ServerPrinterMapping, printerType: PrinterTypeValue): boolean {
  return String(printer.printerType || '').toUpperCase() === printerType;
}

function isSharedReceiptRouteCandidate(printer: SalonPrinterMapping, selectedPrinterId: string): boolean {
  return isReceiptServerPrinter(printer) && (printer.id === selectedPrinterId || hasServerPrinterTarget(printer));
}

function buildServerPrinterPayloadFromConfig(
  printerType: PrinterTypeValue,
  pc: PrinterConfig,
): Partial<ServerPrinterMapping> {
  const usesWindowsPrinter = pc.protocol === 'WINDOWS' || pc.protocol === 'ZEBRA'
    || pc.protocol === 'TSPL' || pc.protocol === 'THERMAL';
  const isLabelMedia = isLabelMediaType(printerType);
  const paperWidth = pc.paperWidth || (isLabelMedia ? pc.labelWidth || 100 : 80);
  const address = (pc.port || pc.address || '').trim();
  const windowsPrinterName = (pc.windowsPrinter || '').trim();
  const displayName = (pc.displayName || '').trim() || printerType;

  return {
    displayName,
    printerType,
    protocol: pc.protocol,
    windowsPrinterName: usesWindowsPrinter ? windowsPrinterName || null : null,
    address: usesWindowsPrinter ? null : address || null,
    baudRate: pc.baudRate || 9600,
    paperWidth,
    paperHeight: isLabelMedia ? pc.labelHeight || null : null,
    charsPerLine: pc.charsPerLine || charsPerLineFor(paperWidth),
    supportsCut: pc.supportsCut ?? (!isLabelMedia && printerType !== 'A4'),
    supportsCashDrawer: pc.supportsCashDrawer ?? printerType === 'RECEIPT',
    isEnabled: !!pc.enabled,
  };
}

function isSalonPrinterRouteReady(printer: SalonPrinterMapping): boolean {
  return printer.isEnabled !== false
    && !!printer.agentIsOnline
    && !!printer.isOnline
    && hasServerPrinterTarget(printer);
}

function getSalonPrinterRouteState(printer: SalonPrinterMapping): { label: string; className: string } {
  if (printer.isEnabled === false) return { label: 'Disabled', className: 'bg-slate-100 text-slate-500' };
  if (!hasServerPrinterTarget(printer)) return { label: 'No target', className: 'bg-amber-50 text-amber-700' };
  if (!printer.agentIsOnline) return { label: 'POS offline', className: 'bg-red-50 text-red-700' };
  if (!printer.isOnline) return { label: 'Printer offline', className: 'bg-slate-100 text-slate-500' };
  return { label: 'Ready', className: 'bg-emerald-50 text-emerald-700' };
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
      fiscalDailyReport: normalizeFiscalDailyReportSettings(config?.fiscalDailyReport),
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
    fiscalDailyReport: normalizeFiscalDailyReportSettings(config?.fiscalDailyReport),
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

export default function Settings({ config, onConfigChange, isModuleEntitled }: SettingsProps) {
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
  const [isResyncingProducts, setIsResyncingProducts] = useState(false);
  const [resyncResult, setResyncResult] = useState<'idle' | 'success' | 'error'>('idle');

  // API Key connection state
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Language
  const [language, setLanguage] = useState<Language>(config?.language || 'en');

  const t = getTranslation(language);
  const tOr = (key: string, fallback: string) => {
    const value = t(key);
    return value !== key ? value : fallback;
  };
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [settingsSearch, setSettingsSearch] = useState('');

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
  const [copiedTestError, setCopiedTestError] = useState(false);
  const [printingFiscalDailyReport, setPrintingFiscalDailyReport] = useState(false);
  const [pendingFiscalDailyReportConfirm, setPendingFiscalDailyReportConfirm] = useState(false);
  const [fiscalDailyReportResult, setFiscalDailyReportResult] = useState<FiscalDailyReportPrintResponse | null>(null);
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
  const [posMode, setPosMode] = useState<PosMode>(() => isPosMode(config?.posMode) ? config.posMode : 'retail');
  const [posLanguage, setPosLanguage] = useState<Language | ''>(config?.posLanguage || '');
  const [allowOversell, setAllowOversell] = useState(config?.allowOversell ?? false);
  const [retailSimpleGrid, setRetailSimpleGrid] = useState(config?.retailSimpleGrid ?? false);
  const [fiscalOnCashSale, setFiscalOnCashSale] = useState<FiscalOnCashSaleMode>(config?.fiscalOnCashSale || 'ask');
  const [autoDiscountEnabled, setAutoDiscountEnabled] = useState(config?.autoOrderDiscount?.enabled ?? false);
  const [autoDiscountPercent, setAutoDiscountPercent] = useState(String(config?.autoOrderDiscount?.percent || 5));
  const [autoDiscountEndDate, setAutoDiscountEndDate] = useState(config?.autoOrderDiscount?.endDate || '');
  const [scaleConnection, setScaleConnection] = useState<ScaleConnectionMode>(deriveScaleConnection(config?.scale));
  const [scalePort, setScalePort] = useState(config?.scale?.port || '');
  const [scaleShareEnabled, setScaleShareEnabled] = useState(config?.scale?.share?.enabled ?? false);
  const [scaleSharePort, setScaleSharePort] = useState(String(config?.scale?.share?.port || DEFAULT_SCALE_SHARE_PORT));
  const [scaleShareToken, setScaleShareToken] = useState(config?.scale?.share?.token || '');
  const [scaleRemoteHost, setScaleRemoteHost] = useState(config?.scale?.remote?.host || '');
  const [scaleRemotePort, setScaleRemotePort] = useState(String(config?.scale?.remote?.port || DEFAULT_SCALE_SHARE_PORT));
  const [scaleRemoteToken, setScaleRemoteToken] = useState(config?.scale?.remote?.token || '');
  const [scaleNetworkInfo, setScaleNetworkInfo] = useState<{
    ips: string[];
    suggestedHost: string;
    defaultPort: number;
    running?: boolean;
    port?: number | null;
    error?: string;
  } | null>(null);
  const [scaleTesting, setScaleTesting] = useState(false);
  const [scaleAutoDetecting, setScaleAutoDetecting] = useState(false);
  const [scaleChipset, setScaleChipset] = useState(config?.scale?.chipset || '');
  const [scaleModel, setScaleModel] = useState(config?.scale?.model || 'DIBAL GDPOS Scale');
  const [scaleDriverStatus, setScaleDriverStatus] = useState(config?.scale?.driverStatus || '');
  const [scaleDiagnoseSteps, setScaleDiagnoseSteps] = useState<ScaleDiagnoseStep[]>([]);
  const [scaleTestResult, setScaleTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [lanKitchenReceiveEnabled, setLanKitchenReceiveEnabled] = useState(config?.lanFirstReceiver?.enabled ?? false);
  const [lanKitchenReceivePort, setLanKitchenReceivePort] = useState(String(config?.lanFirstReceiver?.port || DEFAULT_LAN_FIRST_KITCHEN_PORT));
  const [lanKitchenReceiverPairingCode, setLanKitchenReceiverPairingCode] = useState('');
  const [lanKitchenSenderEnabled, setLanKitchenSenderEnabled] = useState(config?.lanFirstKitchenSender?.enabled ?? false);
  const [lanKitchenSelectedPrinterId, setLanKitchenSelectedPrinterId] = useState('');
  const [lanKitchenTargetHost, setLanKitchenTargetHost] = useState('');
  const [lanKitchenTargetPort, setLanKitchenTargetPort] = useState(String(DEFAULT_LAN_FIRST_KITCHEN_PORT));
  const [lanKitchenSenderPairingCode, setLanKitchenSenderPairingCode] = useState('');
  const [lanKitchenNetworkInfo, setLanKitchenNetworkInfo] = useState<LanFirstKitchenNetworkInfo | null>(null);
  const [lanKitchenPairingStatus, setLanKitchenPairingStatus] = useState<LanFirstKitchenPairingStatus | null>(null);
  const [lanKitchenSaving, setLanKitchenSaving] = useState(false);
  const [lanKitchenTesting, setLanKitchenTesting] = useState(false);
  const [lanKitchenResult, setLanKitchenResult] = useState<{ success: boolean; message: string } | null>(null);
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
  const [customerDisplayRetailCatalogEnabled, setCustomerDisplayRetailCatalogEnabled] = useState(config?.customerDisplayRetailCatalogEnabled ?? true);
  const [customerDisplayFoodMenuEnabled, setCustomerDisplayFoodMenuEnabled] = useState(config?.customerDisplayFoodMenuEnabled ?? false);
  const [promoFolder, setPromoFolder] = useState((config as any)?.customerDisplayPromoFolder || '');
  const [promoInterval, setPromoInterval] = useState((config as any)?.customerDisplayPromoInterval ?? 5000);
  const [idleTimeout, setIdleTimeout] = useState((config as any)?.customerDisplayIdleTimeout ?? 120000);

  // TV Ad state
  const [tvAdEnabled, setTvAdEnabled] = useState<boolean>((config as any)?.tvAdEnabled ?? false);
  const [tvAdPlaylist, setTvAdPlaylist] = useState<TvAdMediaItem[]>((config as any)?.tvAdPlaylist ?? []);
  const [tvAdMode, setTvAdMode] = useState<'sequential' | 'repeat-one'>((config as any)?.tvAdPlaybackMode ?? 'sequential');
  const [tvAdRepeatId, setTvAdRepeatId] = useState<string | null>((config as any)?.tvAdRepeatVideoId ?? null);
  const [tvAdMuted, setTvAdMuted] = useState<boolean>((config as any)?.tvAdMuted ?? true);
  const [tvAdVolume, setTvAdVolume] = useState<number>((config as any)?.tvAdVolume ?? 0);
  const [tvAdStatus, setTvAdStatus] = useState<{ running: boolean; port: number | null; ips: string[]; primaryIp?: string; connectedClients: number; remoteUrl?: string } | null>(null);
  const tvAdQrRef = useRef<HTMLCanvasElement | null>(null);

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
  const [fiscalDailyReport, setFiscalDailyReport] = useState<NormalizedFiscalDailyReportSettings>(
    () => normalizeFiscalDailyReportSettings(config?.fiscalDailyReport),
  );
  const [showFiscalDailyReportAdvanced, setShowFiscalDailyReportAdvanced] = useState(false);
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
  const [salonPrinterInventory, setSalonPrinterInventory] = useState<SalonPrinterMapping[]>([]);
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

  const refreshLanKitchenStatus = useCallback(async () => {
    const api = window.electronAPI.lanFirstKitchen;
    if (!api) return;
    try {
      const [network, pairing] = await Promise.all([
        api.getNetworkInfo(),
        api.getPairingStatus(),
      ]);
      setLanKitchenNetworkInfo(network);
      setLanKitchenPairingStatus(pairing);
    } catch {
      setLanKitchenNetworkInfo(null);
      setLanKitchenPairingStatus(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    refreshLanKitchenStatus().catch(() => {
      if (mounted) {
        setLanKitchenNetworkInfo(null);
        setLanKitchenPairingStatus(null);
      }
    });
    const timer = lanKitchenReceiveEnabled ? window.setTimeout(() => {
      if (mounted) refreshLanKitchenStatus().catch(() => {});
    }, 900) : undefined;
    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [lanKitchenReceiveEnabled, lanKitchenReceivePort, refreshLanKitchenStatus]);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      window.electronAPI.scale?.getNetworkInfo?.()
        .then((info: {
          ips: string[];
          suggestedHost: string;
          defaultPort: number;
          running?: boolean;
          port?: number | null;
          error?: string;
        }) => {
          if (mounted) setScaleNetworkInfo(info);
        })
        .catch(() => {
          if (mounted) setScaleNetworkInfo(null);
        });
    };
    load();
    const timer = scaleShareEnabled ? window.setTimeout(load, 900) : undefined;
    return () => {
      mounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [scaleShareEnabled, scaleSharePort]);

  // TV Ad status poll
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await window.electronAPI.tvAdGetStatus().catch(() => null);
      if (alive) setTvAdStatus(s as any);
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // QR opens the Android phone remote; the plain IP:port remains visible for TV pairing.
  useEffect(() => {
    const ip = tvAdStatus?.primaryIp || tvAdStatus?.ips?.[0];
    if (tvAdQrRef.current && tvAdStatus?.running && ip && tvAdStatus.port) {
      QRCode.toCanvas(tvAdQrRef.current, tvAdStatus.remoteUrl || `http://${ip}:${tvAdStatus.port}/remote`, {
        width: 96,
        margin: 1,
        color: { 'dark': '#0f172a', light: '#ffffff' },
      }).catch((err: Error) => rlog.error('[Settings] tvAd QR failed:', err));
    }
  }, [tvAdStatus?.running, tvAdStatus?.primaryIp, tvAdStatus?.ips?.[0], tvAdStatus?.port, tvAdStatus?.remoteUrl]);

  const buildGeneralConfigPayload = useCallback((overrides: Partial<AgentConfig> = {}): Partial<AgentConfig> => ({
    name,
    autoStart,
    language,
    posEnabled,
    posMode,
    posLanguage: (posLanguage || '') as AgentConfig['posLanguage'],
    allowOversell,
    retailSimpleGrid,
    fiscalOnCashSale,
    autoOrderDiscount: {
      enabled: autoDiscountEnabled,
      percent: Math.min(100, Math.max(0, Number(autoDiscountPercent) || 0)),
      endDate: autoDiscountEndDate.trim() || null,
    },
    scale: {
      enabled: scaleConnection !== 'none',
      connection: scaleConnection,
      protocol: 'DIBAL_GDPOS',
      port: scalePort,
      baudRate: 9600,
      chipset: scaleChipset,
      model: scaleModel,
      driverStatus: scaleDriverStatus,
      share: {
        enabled: scaleConnection === 'local' && scaleShareEnabled,
        port: parseScalePortNumber(scaleSharePort, DEFAULT_SCALE_SHARE_PORT),
        token: scaleShareToken.trim(),
      },
      remote: {
        host: scaleRemoteHost.trim(),
        port: parseScalePortNumber(scaleRemotePort, DEFAULT_SCALE_SHARE_PORT),
        token: scaleRemoteToken.trim(),
        timeoutMs: DEFAULT_REMOTE_SCALE_TIMEOUT_MS,
      },
    },
    receiptSellerName,
    receiptSellerAddress,
    receiptSellerNip,
    customerDisplayEnabled,
    customerDisplayProfile,
    customerDisplayMonitor,
    customerDisplayForceKiosk,
    customerDisplayRetailCatalogEnabled,
    customerDisplayFoodMenuEnabled,
    customerDisplayPromoFolder: promoFolder,
    customerDisplayPromoInterval: promoInterval,
    customerDisplayIdleTimeout: idleTimeout,
    ...overrides,
  }), [
    name, autoStart, language,
    posEnabled, posMode, posLanguage, allowOversell, retailSimpleGrid, fiscalOnCashSale,
    autoDiscountEnabled, autoDiscountPercent, autoDiscountEndDate,
    scaleConnection, scalePort, scaleChipset, scaleModel, scaleDriverStatus, scaleShareEnabled, scaleSharePort, scaleShareToken,
    scaleRemoteHost, scaleRemotePort, scaleRemoteToken,
    receiptSellerName, receiptSellerAddress, receiptSellerNip,
    customerDisplayEnabled, customerDisplayProfile, customerDisplayMonitor, customerDisplayForceKiosk,
    customerDisplayRetailCatalogEnabled, customerDisplayFoodMenuEnabled,
    promoFolder, promoInterval, idleTimeout,
  ]);

  const buildPrinterConfigPayload = useCallback((): Partial<AgentConfig> => {
    if (multiPrinterMode) {
      return {
        multiPrinterMode: true,
        printers,
        receiptPrinter: { ...defaultPrinterConfig, enabled: false },
        labelPrinter: { ...defaultPrinterConfig, enabled: false },
        fiscalDailyReport,
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
      fiscalDailyReport,
    };
  }, [
    multiPrinterMode, printers, fiscalDailyReport,
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
      const [printersResult, inventoryResult, assignmentsResult] = await Promise.allSettled([
        window.electronAPI.printAgentPrinters.salonList({
          shareableOnly: true,
          role: SELF_CHECKOUT_RECEIPT_ROLE,
        }),
        window.electronAPI.printAgentPrinters.salonList(),
        window.electronAPI.printAgentPrinters.assignmentsList(),
      ]);

      let receiptRows: SalonPrinterMapping[] = [];
      if (printersResult.status === 'fulfilled') {
        const rows = normalizeSalonPrinterList(printersResult.value);
        receiptRows = rows;
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

      if (inventoryResult.status === 'fulfilled') {
        const rows = normalizeSalonPrinterList(inventoryResult.value);
        setSalonPrinterInventory(rows);
        setWindowsPrinters(prev => mergeWindowsPrinterOptions(
          prev,
          rows
            .map((printer) => printer.windowsPrinterName)
            .filter(Boolean)
            .map((name) => ({ name: name as string, port: '' })),
        ));
      } else {
        setSalonPrinterInventory(receiptRows);
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
      setSalonPrinterInventory([]);
      setPrinterAssignments([]);
      setSharedPrintersError(err?.message || 'Failed to load shared printer settings');
    } finally {
      setSharedPrintersLoading(false);
    }
  }, []);

  const syncServerPrinterRowsFromPayload = useCallback(async (payload: Partial<AgentConfig>) => {
    const printerEntries = Object.entries(payload.printers || {}) as Array<[PrinterTypeValue, PrinterConfig]>;
    const updates = printerEntries
      .filter(([, pc]) => !!pc?.serverPrinterId)
      .map(([printerType, pc]) => window.electronAPI.printAgentPrinters.update(
        pc.serverPrinterId!,
        buildServerPrinterPayloadFromConfig(printerType, pc),
      ));

    if (updates.length === 0) return;

    const responses = await Promise.all(updates);
    const lastResponse = responses[responses.length - 1];
    if (lastResponse) {
      setServerPrinters(normalizePrinterList(lastResponse));
    }

    await loadLocalPrinterRows();
    await loadSharedPrinterRouting();
  }, [loadLocalPrinterRows, loadSharedPrinterRouting]);

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
      setPosMode(isPosMode(config.posMode) ? config.posMode : 'retail');
      setPosLanguage(config.posLanguage || '');
      setAllowOversell(config.allowOversell ?? false);
      setRetailSimpleGrid(config.retailSimpleGrid ?? false);
      setFiscalOnCashSale(config.fiscalOnCashSale || 'ask');
      setAutoDiscountEnabled(config.autoOrderDiscount?.enabled ?? false);
      setAutoDiscountPercent(String(config.autoOrderDiscount?.percent || 5));
      setAutoDiscountEndDate(config.autoOrderDiscount?.endDate || '');
      setScaleConnection(deriveScaleConnection(config.scale));
      setScalePort(config.scale?.port || '');
      setScaleChipset(config.scale?.chipset || '');
      setScaleModel(config.scale?.model || 'DIBAL GDPOS Scale');
      setScaleDriverStatus(config.scale?.driverStatus || '');
      setScaleShareEnabled(config.scale?.share?.enabled ?? false);
      setScaleSharePort(String(config.scale?.share?.port || DEFAULT_SCALE_SHARE_PORT));
      setScaleShareToken(config.scale?.share?.token || '');
      setScaleRemoteHost(config.scale?.remote?.host || '');
      setScaleRemotePort(String(config.scale?.remote?.port || DEFAULT_SCALE_SHARE_PORT));
      setScaleRemoteToken(config.scale?.remote?.token || '');
      setLanKitchenReceiveEnabled(config.lanFirstReceiver?.enabled ?? false);
      setLanKitchenReceivePort(String(config.lanFirstReceiver?.port || DEFAULT_LAN_FIRST_KITCHEN_PORT));
      setLanKitchenSenderEnabled(config.lanFirstKitchenSender?.enabled ?? false);
      setReceiptSellerName(config.receiptSellerName || '');
      setReceiptSellerAddress(config.receiptSellerAddress || '');
      setReceiptSellerNip(config.receiptSellerNip || '');
      setCustomerDisplayEnabled(config.customerDisplayEnabled ?? false);
      const nextProfile = resolveCustomerDisplayProfile(config);
      customerDisplayProfileRef.current = nextProfile;
      setCustomerDisplayProfile(nextProfile);
      setCustomerDisplayMonitor(config.customerDisplayMonitor ?? 0);
      setCustomerDisplayForceKiosk(config.customerDisplayForceKiosk ?? true);
      setCustomerDisplayRetailCatalogEnabled(config.customerDisplayRetailCatalogEnabled ?? true);
      setCustomerDisplayFoodMenuEnabled(config.customerDisplayFoodMenuEnabled ?? false);
      setPromoFolder((config as any).customerDisplayPromoFolder || '');
      setPromoInterval((config as any).customerDisplayPromoInterval ?? 5000);
      setIdleTimeout((config as any).customerDisplayIdleTimeout ?? 120000);
      // TV Ad re-sync
      setTvAdEnabled((config as any).tvAdEnabled ?? false);
      setTvAdPlaylist((config as any).tvAdPlaylist ?? []);
      setTvAdMode((config as any).tvAdPlaybackMode ?? 'sequential');
      setTvAdRepeatId((config as any).tvAdRepeatVideoId ?? null);
      setTvAdMuted((config as any).tvAdMuted ?? true);
      setTvAdVolume((config as any).tvAdVolume ?? 0);
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
        setFiscalDailyReport(normalizeFiscalDailyReportSettings(config.fiscalDailyReport));
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
      await syncServerPrinterRowsFromPayload(payload);
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
  }, [clearPrinterSaveResultLater, onConfigChange, syncServerPrinterRowsFromPayload]);

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

  const updateFiscalDailyReport = (updates: Partial<FiscalDailyReportSettings>) => {
    setFiscalDailyReport(prev => normalizeFiscalDailyReportSettings({
      ...prev,
      ...updates,
    }));
  };

  const handlePrintFiscalDailyReportNow = async () => {
    if (printingFiscalDailyReport || testingPrinter) return;
    setPendingFiscalDailyReportConfirm(true);
  };

  const handleConfirmPrintFiscalDailyReportNow = async () => {
    if (printingFiscalDailyReport || testingPrinter) return;

    setPrintingFiscalDailyReport(true);
    setFiscalDailyReportResult(null);
    try {
      const result = await window.electronAPI.printFiscalDailyReportNow();
      setFiscalDailyReportResult(result);
    } catch (error: any) {
      setFiscalDailyReportResult({
        success: false,
        error: error?.message || String(error),
      });
    } finally {
      setPrintingFiscalDailyReport(false);
      setPendingFiscalDailyReportConfirm(false);
    }
  };

  // Get printer config for a type (with default)
  const getPrinterConfig = (printerType: PrinterTypeValue): PrinterConfig => {
    const saved = printers[printerType as keyof typeof printers];
    const base: PrinterConfig = {
      ...defaultPrinterConfig,
      ...(printerType === 'FABRIC_TAG' ? FABRIC_TAG_DEFAULTS : {}),
      ...(saved || {}),
    };

    // A slot has to start on a protocol its own type accepts. Every slot
    // defaulted to THERMAL, which FABRIC_TAG rejects -- and since the select
    // lists only the allowed protocols, it displayed TSPL while the value
    // underneath stayed THERMAL. Saving then bounced with "FABRIC_TAG slot
    // cannot use THERMAL protocol" in a log nobody was reading, so the screen
    // looked right and nothing could be configured.
    const allowed = (ALLOWED_PROTOCOLS_BY_TYPE as Record<string, PrinterProtocol[] | undefined>)[printerType] || [];
    if (allowed.length > 0 && !allowed.includes(base.protocol)) {
      return { ...base, protocol: allowed[0] };
    }
    return base;
  };

  const formatTestPrintDebugText = (
    result: NonNullable<typeof testResult>,
    printerConfig?: Partial<PrinterConfig>,
  ): string => {
    const lines = [
      'Zira AI test print debug',
      `Time: ${new Date().toISOString()}`,
      `Printer type: ${result.printerType}`,
      `Success: ${result.success}`,
    ];

    if (result.error) lines.push(`Error: ${result.error}`);
    if (result.modelName) lines.push(`Model: ${result.modelName}`);
    if (result.charsetUsed) lines.push(`Charset: ${result.charsetUsed}`);
    if (result.cutModeUsed) lines.push(`Cut mode: ${result.cutModeUsed}`);

    if (printerConfig) {
      lines.push('', 'Printer config:');
      lines.push(`  enabled: ${printerConfig.enabled ?? 'unknown'}`);
      lines.push(`  protocol: ${printerConfig.protocol ?? 'unknown'}`);
      lines.push(`  port: ${printerConfig.port || 'none'}`);
      lines.push(`  windowsPrinter: ${printerConfig.windowsPrinter || 'none'}`);
      lines.push(`  address: ${printerConfig.address || 'none'}`);
      lines.push(`  baudRate: ${printerConfig.baudRate ?? 'none'}`);
      lines.push(`  paperWidth: ${printerConfig.paperWidth ?? 'none'}`);
      lines.push(`  charsPerLine: ${printerConfig.charsPerLine ?? 'none'}`);
      lines.push(`  charset: ${printerConfig.charset || 'none'}`);
      lines.push(`  cutMode: ${printerConfig.cutMode || 'none'}`);
      lines.push(`  serverPrinterId: ${printerConfig.serverPrinterId || 'none'}`);
    }

    if (result.steps?.length) {
      lines.push('', 'Steps:');
      result.steps.forEach((step, idx) => {
        lines.push(
          `  ${idx + 1}. ${step.ok ? 'OK' : 'FAIL'} ${step.step}` +
          `${step.detail ? ` | detail: ${step.detail}` : ''}` +
          `${step.error ? ` | error: ${step.error}` : ''}` +
          `${typeof step.durationMs === 'number' ? ` | ${step.durationMs}ms` : ''}`,
        );
      });
    }

    return lines.join('\n');
  };

  const handleCopyTestPrintError = async (
    result: NonNullable<typeof testResult>,
    printerConfig?: Partial<PrinterConfig>,
  ) => {
    await navigator.clipboard.writeText(formatTestPrintDebugText(result, printerConfig));
    setCopiedTestError(true);
    setTimeout(() => setCopiedTestError(false), 2000);
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
        paperWidth: printer.paperWidth || (isLabelMediaType(printerType) ? 100 : 80),
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
        const nextIsLabelMedia = isLabelMediaType(updates.printerType);
        // A garment tag is narrower and taller than a shelf label.
        next.paperWidth = updates.printerType === 'FABRIC_TAG' ? 20 : nextIsLabelMedia ? 100 : 80;
        next.paperHeight = updates.printerType === 'FABRIC_TAG' ? 60 : nextIsLabelMedia ? 150 : prev.paperHeight;
      }
      return next;
    });
  };

  const buildCustomPrinterPayload = (form: CustomPrinterForm): Partial<ServerPrinterMapping> => {
    const usesWindowsPrinter = form.protocol === 'WINDOWS' || form.protocol === 'ZEBRA'
      || form.protocol === 'TSPL' || form.protocol === 'THERMAL';
    const isLabelMedia = isLabelMediaType(form.printerType);
    const paperWidth = form.paperWidth || (isLabelMedia ? 100 : 80);
    return {
      displayName: form.displayName.trim(),
      printerType: form.printerType,
      protocol: form.protocol,
      windowsPrinterName: usesWindowsPrinter ? form.windowsPrinterName.trim() : null,
      address: usesWindowsPrinter ? null : form.address.trim(),
      baudRate: 9600,
      paperWidth,
      paperHeight: isLabelMedia ? form.paperHeight : null,
      charsPerLine: charsPerLineFor(paperWidth),
      supportsCut: !isLabelMedia && form.printerType !== 'A4',
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
    if ((payload.protocol === 'WINDOWS' || payload.protocol === 'ZEBRA' || payload.protocol === 'TSPL' || payload.protocol === 'THERMAL') && !payload.windowsPrinterName) {
      setServerPrintersError('Windows printer is required');
      return;
    }
    if ((payload.protocol === 'POSNET' || payload.protocol === 'ELZAB_STX') && !payload.address) {
      setServerPrintersError('COM port or address is required');
      return;
    }
    if (isLabelMediaType(String(payload.printerType)) && (!payload.paperWidth || !payload.paperHeight)) {
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

  const handleAssignSharedPrinter = async (printerId: string, role: SalonPrinterRole = SELF_CHECKOUT_RECEIPT_ROLE) => {
    setSharedPrinterSavingId(`${role}:${printerId}`);
    setSharedPrintersError(null);
    try {
      await window.electronAPI.printAgentPrinters.upsertAssignment(role, printerId);
      await loadSharedPrinterRouting();
    } catch (err: any) {
      setSharedPrintersError(err?.message || 'Failed to save shared printer assignment');
    } finally {
      setSharedPrinterSavingId(null);
    }
  };

  const handleClearSharedPrinter = async (role: SalonPrinterRole = SELF_CHECKOUT_RECEIPT_ROLE) => {
    setSharedPrinterSavingId(`${role}:clear`);
    setSharedPrintersError(null);
    try {
      await window.electronAPI.printAgentPrinters.deleteAssignment(role);
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

  const handleTestScale = async () => {
    if (scaleTesting) return;
    setScaleTesting(true);
    setScaleTestResult(null);
    try {
      const payload = buildGeneralConfigPayload();
      await Promise.resolve(onConfigChange(payload));
      const result = await window.electronAPI.scale.readWeight({
        port: scaleConnection === 'local' ? scalePort || undefined : undefined,
      });
      if (result.success) {
        if (scaleConnection === 'local' && result.port) {
          if (scalePort !== result.port) {
            setScalePort(result.port);
          }
          setScaleDriverStatus('OK (Verified)');
        }
        setScaleTestResult({
          success: true,
          message: `${result.weightKg.toFixed(3)} kg ${result.source === 'remote' ? `via ${result.remoteHost || 'remote scale'}` : `on ${result.port}`}`,
        });
      } else {
        setScaleTestResult({
          success: false,
          message: result.error || result.code || 'Scale did not return a weight',
        });
      }
    } catch (error: any) {
      setScaleTestResult({
        success: false,
        message: error?.message || 'Failed to read scale',
      });
    } finally {
      setScaleTesting(false);
    }
  };

  const handleAutoDetectScale = async () => {
    if (scaleAutoDetecting) return;
    setScaleAutoDetecting(true);
    setScaleTestResult(null);
    setScaleDiagnoseSteps([]);
    try {
      const result = await window.electronAPI.scale.autoDetect();
      if (result.steps && Array.isArray(result.steps)) {
        setScaleDiagnoseSteps(result.steps);
      }
      if (result.success && result.port) {
        setScaleConnection('local');
        setScalePort(result.port);
        setScaleChipset(result.chipset || '');
        setScaleModel(result.model || 'DIBAL GDPOS Scale');
        setScaleDriverStatus(result.driverStatus || 'OK');
        await Promise.resolve(onConfigChange({
          scale: {
            enabled: true,
            connection: 'local',
            port: result.port,
            protocol: 'DIBAL_GDPOS',
            baudRate: result.baudRate || 9600,
            chipset: result.chipset || '',
            model: result.model || 'DIBAL GDPOS Scale',
            driverStatus: result.driverStatus || 'OK',
            share: {
              enabled: scaleShareEnabled,
              port: parseScalePortNumber(scaleSharePort, DEFAULT_SCALE_SHARE_PORT),
              token: scaleShareToken.trim(),
            },
            remote: {
              host: scaleRemoteHost.trim(),
              port: parseScalePortNumber(scaleRemotePort, DEFAULT_SCALE_SHARE_PORT),
              token: scaleRemoteToken.trim(),
              timeoutMs: DEFAULT_REMOTE_SCALE_TIMEOUT_MS,
            },
          },
        }));
        await refreshPrinterDiscovery();
        setScaleTestResult({
          success: true,
          message: result.message || `Detected on ${result.port} (${result.chipset})`,
        });
      } else {
        setScaleTestResult({
          success: false,
          message: result.message || 'No scale detected',
        });
      }
    } catch (err: any) {
      setScaleTestResult({
        success: false,
        message: err?.message || 'Scale auto-detection failed',
      });
    } finally {
      setScaleAutoDetecting(false);
    }
  };

  // ─── TV Ad handlers ──────────────────────────────────────────────────────────
  const persistTvAd = async (overrides: Record<string, unknown> = {}) => {
    const payload = {
      tvAdEnabled, tvAdPlaybackMode: tvAdMode, tvAdRepeatVideoId: tvAdRepeatId,
      tvAdMuted, tvAdVolume, tvAdPlaylist, ...overrides,
    };
    await window.electronAPI.tvAdSave(payload as any);
  };

  const handleAddTvAdVideo = async () => {
    const rec = await window.electronAPI.tvAdPickVideo().catch(() => null);
    if (!rec) return;
    const next = [...tvAdPlaylist, { ...rec, order: tvAdPlaylist.length, enabled: true }];
    setTvAdPlaylist(next);
    await persistTvAd({ tvAdPlaylist: next });
  };

  const handleRemoveTvAdVideo = async (id: string) => {
    const next = tvAdPlaylist.filter(v => v.id !== id).map((v, i) => ({ ...v, order: i }));
    setTvAdPlaylist(next);
    await persistTvAd({ tvAdPlaylist: next });
  };

  const handleToggleTvAdVideo = async (id: string) => {
    const next = tvAdPlaylist.map(v => v.id === id ? { ...v, enabled: !v.enabled } : v);
    setTvAdPlaylist(next);
    await persistTvAd({ tvAdPlaylist: next });
  };

  const handleMoveTvAdMedia = async (id: string, direction: -1 | 1) => {
    const ordered = tvAdPlaylist.slice().sort((a, b) => a.order - b.order);
    const index = ordered.findIndex(v => v.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    const next = ordered.map((v, i) => ({ ...v, order: i }));
    setTvAdPlaylist(next);
    await persistTvAd({ tvAdPlaylist: next });
  };

  const handleTvAdImageDuration = async (id: string, seconds: number) => {
    const durationMs = Math.min(60, Math.max(2, Math.round(seconds || 7))) * 1000;
    const next = tvAdPlaylist.map(v => v.id === id ? { ...v, durationMs } : v);
    setTvAdPlaylist(next);
    await persistTvAd({ tvAdPlaylist: next });
  };
  // ─── End TV Ad handlers ──────────────────────────────────────────────────────

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
    setCopiedTestError(false);
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
      // Keep failures visible so the cashier can copy the debug details.
      setTimeout(() => {
        setTestResult(prev => prev?.success ? null : prev);
        setLiveSteps([]);
      }, 15000);
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
    setCopiedTestError(false);
    try {
      const result = await window.electronAPI.testPrint();
      setTestResult({ printerType: 'legacy', success: result.success, error: result.error });
    } catch (error: any) {
      setTestResult({ printerType: 'legacy', success: false, error: error.message });
    } finally {
      setTestingPrinter(null);
      setTimeout(() => setTestResult(prev => prev?.success ? null : prev), 5000);
    }
  };

  const refreshPrinterConfigFromStore = async () => {
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
    setFiscalDailyReport(normalizeFiscalDailyReportSettings(updatedConfig?.fiscalDailyReport));
    syncedPrinterSignatureRef.current = incomingPrinterSignature;
    await loadLocalPrinterRows();
  };

  const deviceText = (dev: DetectedPrinterDevice): string => {
    return `${dev.brand || ''} ${dev.model || ''} ${dev.windowsPrinterName || ''}`.toLowerCase();
  };

  const isFiscalDevice = (dev: DetectedPrinterDevice): boolean => {
    const text = deviceText(dev);
    return (
      (dev.brand || '').toUpperCase() === 'ELZAB' ||
      (dev.brand || '').toUpperCase() === 'POSNET' ||
      (dev.vid || '').toUpperCase() === 'C1CA' ||
      (dev.vid || '').toUpperCase() === '1424' ||
      text.includes('elzab') ||
      text.includes('zeta online') ||
      text.includes('posnet')
    );
  };

  const isLabelDevice = (dev: DetectedPrinterDevice): boolean => {
    if (dev.targetType === 'LABEL') return true;
    const text = deviceText(dev);
    const brand = (dev.brand || '').toUpperCase();
    const vid = (dev.vid || '').toUpperCase();
    return (
      brand === 'ZEBRA' ||
      brand === 'TSC' ||
      brand === 'HONEYWELL' ||
      brand === 'DYMO' ||
      vid === '0A5F' ||
      vid === '1203' ||
      vid === '0C2E' ||
      text.includes('zebra') ||
      text.includes('zdesigner') ||
      text.includes('tsc') ||
      text.includes('honeywell') ||
      text.includes('xp-423') ||
      text.includes('xp423') ||
      text.includes('labelwriter') ||
      text.includes('label')
    );
  };

  const isReceiptDevice = (dev: DetectedPrinterDevice): boolean => {
    if (isFiscalDevice(dev) || isLabelDevice(dev)) return false;
    const text = deviceText(dev);
    return (
      text.includes('xprinter') ||
      text.includes('xp-80') ||
      text.includes('xp80') ||
      text.includes('xp-58') ||
      text.includes('xp58') ||
      text.includes('receipt') ||
      text.includes('thermal') ||
      text.includes('tm-t') ||
      text.includes('tsp') ||
      text.includes('srp-') ||
      text.includes('ct-s') ||
      dev.connectionType === 'SERIAL'
    );
  };

  const pickDevice = (
    devices: DetectedPrinterDevice[],
    predicate: (dev: DetectedPrinterDevice) => boolean,
    preferred?: (dev: DetectedPrinterDevice) => boolean,
  ): DetectedPrinterDevice | undefined => {
    const candidates = devices.filter(predicate);
    if (!candidates.length) return undefined;
    return candidates.find(dev => preferred?.(dev)) || candidates[0];
  };

  const handleSmartAssignPrinters = async () => {
    if (autoSettingUp) return;
    setAutoSettingUp(true);
    setAutoSetupResult(null);
    try {
      const status = await refreshPrinterDiscovery();
      const used = new Set<DetectedPrinterDevice>();
      const assignments: Array<{ slot: PrinterTypeValue; device: DetectedPrinterDevice }> = [];
      const devices = status.devices || [];

      const fiscal = pickDevice(
        devices,
        isFiscalDevice,
        dev => (dev.brand || '').toUpperCase() === 'ELZAB' || (dev.vid || '').toUpperCase() === 'C1CA',
      );
      if (fiscal) {
        assignments.push({ slot: 'FISCAL', device: fiscal });
        used.add(fiscal);
      }

      const receipt = pickDevice(
        devices.filter(dev => !used.has(dev)),
        isReceiptDevice,
        dev => deviceText(dev).includes('xprinter') || deviceText(dev).includes('xp-80'),
      );
      if (receipt) {
        assignments.push({ slot: 'RECEIPT', device: receipt });
        used.add(receipt);
      }

      const label = pickDevice(
        devices.filter(dev => !used.has(dev)),
        isLabelDevice,
        dev => {
          const brand = (dev.brand || '').toUpperCase();
          const vid = (dev.vid || '').toUpperCase();
          return brand === 'ZEBRA' || brand === 'TSC' || brand === 'HONEYWELL' || vid === '0A5F' || vid === '1203' || vid === '0C2E';
        },
      );
      if (label) {
        assignments.push({ slot: 'LABEL', device: label });
      }

      if (!assignments.length) {
        setAutoSetupResult({
          success: false,
          message: 'No assignable fiscal, receipt, or label printer was detected.',
        });
        return;
      }

      const configured: string[] = [];
      const failed: string[] = [];
      for (const { slot, device } of assignments) {
        const slotLabel = printerTypeLabel(t, slot);
        if (device.autoSetupEligible === false) {
          failed.push(`${device.brand} ${device.model} -> ${slotLabel}: manual protocol check required`);
          continue;
        }
        const result = await window.electronAPI.autoSetupPrinter(slot, {
          ...device,
          targetType: slot,
        });
        if (result.success) {
          configured.push(`${device.brand} ${device.model} -> ${slotLabel}`);
        } else {
          failed.push(`${device.brand} ${device.model} -> ${slotLabel}: ${result.message || 'setup failed'}`);
        }
      }

      // Auto-detect and configure scale if available
      try {
        const scaleRes = await window.electronAPI.scale.autoDetect();
        if (scaleRes.success && scaleRes.port) {
          setScaleConnection('local');
          setScalePort(scaleRes.port);
          configured.push(`Scale -> ${scaleRes.port}`);
        }
      } catch {
        // best effort
      }

      await refreshPrinterDiscovery();
      await refreshPrinterConfigFromStore();

      setAutoSetupResult({
        success: failed.length === 0 && configured.length > 0,
        message: [
          configured.length ? `Assigned: ${configured.join(', ')}` : '',
          failed.length ? `Failed: ${failed.join('; ')}` : '',
        ].filter(Boolean).join('. '),
      });
    } catch (err: any) {
      setAutoSetupResult({
        success: false,
        message: err?.message || 'Smart assign failed',
      });
    } finally {
      setAutoSettingUp(false);
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
          configured.push(`${dev.brand} ${dev.model} -> ${printerTypeLabel(t, targetType)}`);
          claimedSlots.add(targetType);
        }
      }

      // Also auto-detect and configure scale if available
      try {
        const scaleRes = await window.electronAPI.scale.autoDetect();
        if (scaleRes.success && scaleRes.port) {
          setScaleConnection('local');
          setScalePort(scaleRes.port);
          configured.push(`Scale -> ${scaleRes.port}`);
        }
      } catch {
        // best effort
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
        setFiscalDailyReport(normalizeFiscalDailyReportSettings(updatedConfig?.fiscalDailyReport));
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
        setFiscalDailyReport(normalizeFiscalDailyReportSettings(updatedConfig?.fiscalDailyReport));
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
    ? salonPrinters.find((printer) => printer.id === sharedReceiptAssignment.printerId)
      || salonPrinterInventory.find((printer) => printer.id === sharedReceiptAssignment.printerId)
      || null
    : null;
  const selectedSharedPrinterId = sharedReceiptAssignment?.printerId || '';
  const sharedReceiptPrinters = salonPrinters.filter((printer) => isSharedReceiptRouteCandidate(printer, selectedSharedPrinterId));
  const salonInventoryPrinters = salonPrinterInventory.length > 0 ? salonPrinterInventory : salonPrinters;
  const readyKitchenWifiPrinters = useMemo(
    () => getReadyKitchenWifiPrinters(salonInventoryPrinters),
    [salonInventoryPrinters],
  );
  const kitchenAssignment = printerAssignments.find((assignment) => assignment.role === 'KITCHEN') || null;
  const selectedLanKitchenPrinter = readyKitchenWifiPrinters.find((printer) => printer.id === lanKitchenSelectedPrinterId)
    || (kitchenAssignment
      ? readyKitchenWifiPrinters.find((printer) => printer.id === kitchenAssignment.printerId)
      : null)
    || readyKitchenWifiPrinters[0]
    || null;
  const selectedLanKitchenTargetKey = selectedLanKitchenPrinter?.machineId
    ? `${selectedLanKitchenPrinter.machineId}:${selectedLanKitchenPrinter.id}`
    : '';
  const selectedLanKitchenTarget = (selectedLanKitchenTargetKey
    ? config?.lanFirstKitchenSender?.targets?.[selectedLanKitchenTargetKey]
    : undefined) || config?.lanFirstKitchenSender?.manualTarget;
  const fiscalDailyReportRetries = Math.min(5, Math.max(0, fiscalDailyReport.maxAttempts - 1));
  const fiscalDailyReportRetryMinuteOptions = Array.from(
    new Set([...FISCAL_DAILY_REPORT_RETRY_MINUTE_OPTIONS, fiscalDailyReport.retryMinutes]),
  ).sort((a, b) => a - b);
  const salonConfiguredPrinters = salonInventoryPrinters.filter(hasServerPrinterTarget);
  const salonReadyPrinters = salonConfiguredPrinters.filter(isSalonPrinterRouteReady);
  const enabledSalonRoutes = SALON_PRINTER_ROUTES.filter((route) => route.enabled);
  const futureSalonRoutes = SALON_PRINTER_ROUTES.filter((route) => !route.enabled);
  const customFormAllowedProtocols = ALLOWED_PROTOCOLS_BY_TYPE[customPrinterForm.printerType as PrinterType] || [];
  const customFormUsesWindowsPrinter = customPrinterForm.protocol === 'WINDOWS'
    || customPrinterForm.protocol === 'ZEBRA'
    || customPrinterForm.protocol === 'TSPL'
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
    && isSalonPrinterRouteReady(sharedReceiptPrinter);
  const currentPosHasShareableReceiptPrinter = sharedReceiptPrinters.some((printer) => isPrinterOwnedByThisPos(printer));
  const readySharedReceiptPrinters = sharedReceiptPrinters.filter(isSalonPrinterRouteReady);
  const canManageSharedReceiptRoute = readySharedReceiptPrinters.length > 0 || sharedReceiptOwnedByThisPos;
  const sharedReceiptOwnerLabel = sharedReceiptPrinter ? getServerPrinterOwnerLabel(sharedReceiptPrinter) : '';
  const sharedReceiptStatusTitle = sharedReceiptAssignment
    ? sharedReceiptOwnedByThisPos
      ? 'This POS is sharing receipts'
      : `This POS uses ${sharedReceiptOwnerLabel}`
    : 'Self-checkout receipts are not routed';
  const sharedReceiptStatusDescription = sharedReceiptAssignment
    ? sharedReceiptOwnedByThisPos
      ? 'Self-checkout receipts print from the printer connected to this POS.'
      : 'Self-checkout receipts are routed through the selected online POS.'
    : readySharedReceiptPrinters.length > 0
      ? 'Choose any online receipt printer in this salon. Hardware settings still stay on the owner POS.'
      : currentPosHasShareableReceiptPrinter
        ? 'This POS has receipt printers configured, but none are ready.'
        : 'Set this up on the POS that has the receipt printer connected.';

  const saveLanKitchenWifiDirect = async (): Promise<boolean> => {
    setLanKitchenSaving(true);
    setLanKitchenResult(null);
    try {
      const plan = planLanKitchenSave({
        receiveEnabled: lanKitchenReceiveEnabled,
        receivePort: lanKitchenReceivePort,
        senderEnabled: lanKitchenSenderEnabled,
        selectedPrinterId: lanKitchenSelectedPrinterId,
        host: lanKitchenTargetHost,
        port: lanKitchenTargetPort,
        timeoutMs: config?.lanFirstKitchenSender?.timeoutMs,
        printers: readyKitchenWifiPrinters,
        receiverPairingCode: lanKitchenReceiverPairingCode,
        senderPairingCode: lanKitchenSenderPairingCode,
        currentSender: config?.lanFirstKitchenSender,
      });

      // Persist pairing codes FIRST so a half-configured sender target can
      // never discard a code the user just typed.
      if (plan.receiverCode) {
        const result = await window.electronAPI.lanFirstKitchen.setPairingCode('receiver', plan.receiverCode);
        if (!result.success) {
          setLanKitchenResult({ success: false, message: result.error || 'Failed to save receiver pairing code' });
          return false;
        }
      }

      if (plan.senderCode) {
        const result = await window.electronAPI.lanFirstKitchen.setPairingCode('sender', plan.senderCode);
        if (!result.success) {
          setLanKitchenResult({ success: false, message: result.error || 'Failed to save sender pairing code' });
          return false;
        }
      }

      await Promise.resolve(onConfigChange({
        lanFirstReceiver: plan.receiverPatch,
        lanFirstKitchenSender: plan.senderPatch,
      }));

      if (
        lanKitchenSenderEnabled
        && lanKitchenSelectedPrinterId
        && kitchenAssignment?.printerId !== lanKitchenSelectedPrinterId
      ) {
        await window.electronAPI.printAgentPrinters.upsertAssignment('KITCHEN', lanKitchenSelectedPrinterId);
        await loadSharedPrinterRouting();
      }

      await refreshLanKitchenStatus();
      setLanKitchenResult(
        plan.warnings.length > 0
          ? { success: true, message: `Saved. ${plan.warnings.join('; ')}` }
          : { success: true, message: 'Kitchen Wi-Fi Direct settings saved' },
      );
      return true;
    } catch (err: any) {
      setLanKitchenResult({ success: false, message: err?.message || 'Failed to save Kitchen Wi-Fi Direct settings' });
      return false;
    } finally {
      setLanKitchenSaving(false);
    }
  };

  const handleSaveLanKitchenWifiDirect = async () => {
    await saveLanKitchenWifiDirect();
  };

  const handleTestLanKitchenWifiRoute = async () => {
    if (lanKitchenTesting) return;
    const senderCode = lanKitchenSenderPairingCode.trim();
    setLanKitchenTesting(true);
    try {
      const saved = await saveLanKitchenWifiDirect();
      if (!saved) return;
      const response: LanFirstKitchenTestRouteResponse = await window.electronAPI.lanFirstKitchen.testRoute({
        host: lanKitchenTargetHost.trim(),
        port: parseScalePortNumber(lanKitchenTargetPort, DEFAULT_LAN_FIRST_KITCHEN_PORT),
        pairingCode: senderCode || undefined,
        timeoutMs: resolveLanFirstKitchenTimeoutMs(config?.lanFirstKitchenSender?.timeoutMs),
        testPrint: true,
        printerId: lanKitchenSelectedPrinterId,
        targetMachineId: selectedLanKitchenPrinter?.machineId || undefined,
      });
      setLanKitchenResult({
        success: response.success,
        message: response.success
          ? response.message || 'Wi-Fi route authenticated'
          : response.error || 'Wi-Fi route test failed',
      });
    } finally {
      setLanKitchenTesting(false);
    }
  };

  useEffect(() => {
    if (!selectedLanKitchenPrinter) return;
    if (!lanKitchenSelectedPrinterId || !readyKitchenWifiPrinters.some((printer) => printer.id === lanKitchenSelectedPrinterId)) {
      setLanKitchenSelectedPrinterId(selectedLanKitchenPrinter.id);
    }
    if (selectedLanKitchenTarget?.host) {
      setLanKitchenTargetHost(selectedLanKitchenTarget.host);
      setLanKitchenTargetPort(String(selectedLanKitchenTarget.port || DEFAULT_LAN_FIRST_KITCHEN_PORT));
    }
  }, [
    lanKitchenSelectedPrinterId,
    readyKitchenWifiPrinters,
    selectedLanKitchenPrinter,
    selectedLanKitchenTarget?.host,
    selectedLanKitchenTarget?.port,
  ]);

  const generalSettingsKeywords = settingsSearchKeywords(
    t('settings.general'), 'General',
    t('settings.language'), 'Language',
    t('settings.agentName'), 'Agent name',
    t('settings.serverUrl'), 'Server URL',
    t('settings.autoStart'), 'Auto start',
    t('settings.autoStartDesc'), 'Launch with Windows',
  );
  const printerDetectionKeywords = settingsSearchKeywords(
    'Printer Detection',
    'Auto-detect and auto-recover all connected printers',
    'Smart assign',
    'Detect Printers',
    'POSNET',
    'Zebra',
    'DYMO',
    'driver',
    'COM port',
    'Windows name',
    'refresh',
    'diagnose',
  );
  const printerSettingsKeywords = settingsSearchKeywords(
    t('settings.printers'), 'Printers',
    t('settings.multiPrinter'), 'Multi-printer',
    t('settings.protocol'), 'Protocol',
    t('settings.comPort'), 'COM port',
    t('settings.baudRate'), 'Baud rate',
    t('settings.windowsPrinter'), 'Windows printer',
    t('settings.selectPort'), 'Select port',
    t('settings.selectPrinter'), 'Select printer',
    t('settings.labelWidth'), 'Label width',
    t('settings.labelHeight'), 'Label height',
    t('settings.popularSizes'), 'Popular sizes',
    'Receipt printer',
    'Fiscal printer',
    'Label printer',
    'A4 printer',
    'Ticket printer',
    'Kitchen printer',
    'Self-checkout receipt printing',
    'Kitchen Wi-Fi Direct',
    'Salon online printers',
    'Local printer config',
    'Advanced diagnostics',
    'SQLite mirror',
    'test print',
    'calibrate',
    'server mapping',
    'local printer mirror',
  );
  const posSettingsKeywords = settingsSearchKeywords(
    t('settings.pos'), 'POS',
    t('settings.posMode'), 'POS mode',
    t('settings.posLanguage'), 'POS language',
    t('settings.allowOversell'), 'Allow oversell',
    tOr('settings.retailSimpleGrid', 'Simple product grid (fair / market stall)'), 'simple grid', 'fair', 'hội chợ', 'no categories',
    tOr('settings.fiscalOnCashSale', 'Fiscal receipt on cash/BLIK sale'),
    ...FISCAL_ON_CASH_SALE_OPTIONS.map(option => tOr(option.labelKey, option.fallback)),
    tOr('settings.autoOrderDiscount', 'Automatic discount on every order'),
    'auto discount', 'promotion', 'rabat',
    'Category priority ranking',
    'Staff Management',
    'Scale',
    'Wi-Fi scale',
    'Receipt header',
    t('settings.receiptHeader'), 'Receipt header',
    t('settings.receiptSellerName'), 'Seller name',
    t('settings.receiptSellerAddress'), 'Seller address',
    t('settings.receiptSellerNip'), 'Seller NIP',
    t('settings.customerDisplay'), 'Customer display',
    t('settings.customerDisplayProfile'), 'Customer display profile',
    t('settings.customerDisplayMenuSections'), 'Menu sections',
    t('settings.customerDisplayMonitor'), 'Monitor',
    t('settings.customerDisplayForceKiosk'), 'Kiosk',
    t('settings.promoFolder'), 'Promo folder',
    t('settings.promoInterval'), 'Promo interval',
    t('settings.idleTimeout'), 'Idle timeout',
  );
  const tvAdKeywords = settingsSearchKeywords(
    t('settings.tvAd.title'), 'TV ad',
    t('settings.tvAd.addVideo'), 'Add video',
    t('settings.tvAd.playbackMode'), 'Playback mode',
    t('settings.tvAd.muted'), 'Muted',
    t('settings.tvAd.volume'), 'Volume',
    t('settings.tvAd.status'), 'Status',
    t('settings.tvAd.connectAddress'), 'Connect address',
    t('settings.tvAd.connectedTvs'), 'Connected TVs',
    'playlist',
    'image',
    'video',
    'repeat',
  );
  const pairingKeywords = settingsSearchKeywords(
    t('pairing.title'), 'Pairing',
    t('pairing.apiKey'), 'API key',
    t('pairing.machineId'), 'Machine ID',
    t('pairing.changeSalon'), 'Change salon',
    t('pairing.resyncProducts'), 'Resync products',
    t('ssh.enableRemoteSupport'), 'Remote support',
    t('remote.unattendedAccess'), 'Unattended remote access',
    t('remote.pin'), 'PIN',
  );
  const telegramKeywords = settingsSearchKeywords(
    'Telegram Remote Control',
    'Telegram',
    'bot',
    'chat',
    'notifications',
    'remote commands',
  );
  const aiToolsKeywords = settingsSearchKeywords(
    'Zira AI Tools',
    t('ai.apiKey'), 'AI API key',
    t('ai.localModeDesc'), 'Local mode',
    'OpenRouter',
    'screenshots',
    'mouse',
    'keyboard',
    'Booksy calendar',
  );
  const appUpdatesKeywords = settingsSearchKeywords(
    t('update.title'), 'App updates',
    t('update.currentVersion'), 'Current version',
    t('update.checkBtn'), 'Check updates',
    t('update.installBtn'), 'Install update',
    'download',
    'version',
  );
  const sshTunnelKeywords = settingsSearchKeywords(
    t('ssh.title'), 'SSH tunnel',
    t('ssh.clientAvailable'), 'SSH client',
    t('ssh.serverAvailable'), 'SSH server',
    t('ssh.keyGenerated'), 'SSH key',
    t('ssh.disconnect'), 'Disconnect',
    'Remote support',
  );
  const fiscalHistoryKeywords = settingsSearchKeywords(
    t('settings.fiscalHistory'), 'Fiscal history',
    t('settings.fiscalHistoryDesc'), 'Fiscal history visibility',
    t('settings.showNonFiscalOrders'), 'Show non-fiscal orders',
    t('settings.showNonFiscalOrdersDesc'), 'Non-fiscal orders',
  );
  const checkinDisplayKeywords = settingsSearchKeywords(
    'Check-in Display',
    'Stats bar',
    'Active queue panel',
    'Waiting',
    'In Service',
    'Completed',
    'customer-facing',
    'staff-only',
  );
  const modulesKeywords = settingsSearchKeywords(
    t('settings.modules'), 'Modules',
    'Module Manager',
    'POS',
    'Self checkout',
    'Billiard',
    'Orders',
    'Products',
    'Warehouse',
    'Forecast',
    'Invoicing',
    'Booksy',
    'Bookings',
    'Check-in',
    'Chat',
    'Status',
    'Security',
    'Debug',
  );
  const settingsSearchKeywordsByTab: Record<SettingsTab, string[]> = {
    general: [
      generalSettingsKeywords,
      pairingKeywords,
      telegramKeywords,
      aiToolsKeywords,
      appUpdatesKeywords,
      ...(sshStatus ? [sshTunnelKeywords] : []),
      fiscalHistoryKeywords,
      checkinDisplayKeywords,
    ],
    pos: [posSettingsKeywords, tvAdKeywords],
    printers: [printerDetectionKeywords, printerSettingsKeywords],
    modules: [modulesKeywords],
  };
  const settingsSearchHasResults = settingsSearchKeywordsByTab[settingsTab].some(keywords =>
    matchesSettingSection(settingsSearch, keywords),
  );
  const settingsSearchNoResults = tOr(
    'settings.search.noResults',
    `No settings match '${settingsSearch.trim()}'`,
  ).replace('{query}', settingsSearch.trim());
  const settingsSearchPlaceholder = tOr('settings.search.placeholder', 'Search settings');
  const settingsSearchClearLabel = tOr('settings.search.clear', 'Clear settings search');
  const showSettingsSearchEmptyState = settingsSearch.trim().length > 0 && !settingsSearchHasResults;

  return (
    <>
    <div className="space-y-4">
      <div role="tablist" aria-label="Settings sections" className="flex gap-2 rounded-lg border border-slate-200 bg-white p-1">
        {([
          { id: 'general' as const, label: t('settings.general'), icon: <LayoutDashboard size={15} /> },
          { id: 'pos' as const, label: t('settings.pos'), icon: <ShoppingCart size={15} /> },
          { id: 'printers' as const, label: t('settings.printers'), icon: <Printer size={15} /> },
          { id: 'modules' as const, label: t('settings.modules'), icon: <LayoutGrid size={15} /> },
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

      <div className="sticky top-0 z-20 rounded-lg border border-slate-200 bg-white/95 p-2 shadow-sm backdrop-blur">
        <div className="relative">
          <TextInput
            id="settings-search"
            value={settingsSearch}
            onChange={(event) => setSettingsSearch(event.target.value)}
            placeholder={settingsSearchPlaceholder}
            aria-label={settingsSearchPlaceholder}
            inputClassName="pr-10"
          />
          {settingsSearch && (
            <button
              type="button"
              onClick={() => setSettingsSearch('')}
              aria-label={settingsSearchClearLabel}
              title={settingsSearchClearLabel}
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-300"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {settingsTab === 'modules' && (
        <SettingsSection searchQuery={settingsSearch} keywords={modulesKeywords}>
          <ModuleManager
            config={config}
            onConfigChange={onConfigChange}
            isModuleEntitled={isModuleEntitled}
            t={t}
          />
        </SettingsSection>
      )}

      {settingsTab === 'general' && (
        <>
          {/* General Settings */}
          <SettingsSection searchQuery={settingsSearch} keywords={generalSettingsKeywords}>
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
          </SettingsSection>
        </>
      )}

      {settingsTab === 'printers' && (
        <>
          {/* Printer Detection */}
          <SettingsSection searchQuery={settingsSearch} keywords={printerDetectionKeywords}>
          <div className="panel p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">{tOr('settings.printerDetection', 'Printer Detection')}</h2>
            <p className="text-xs text-slate-500 mt-0.5">Auto-detect and auto-recover all connected printers</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSmartAssignPrinters}
              disabled={autoSettingUp || posnetChecking}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
              title="Assign connected fiscal, receipt/order, and label printers to the right slots"
            >
              {autoSettingUp ? (
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              {autoSettingUp ? 'Assigning...' : 'Smart assign'}
            </button>
            <button
              onClick={handleCheckPosnetDriver}
              disabled={posnetChecking || autoSettingUp}
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
              const isTsc = brand === 'TSC' || dev.vid === '1203';
              const isHoneywell = brand === 'Honeywell' || dev.vid === '0C2E';
              const isBusy = settingUpDevice === `${brand}-${i}`;
              const modelLower = model.toLowerCase();

              // Smart type classification (mirrors backend classifyPrinterCategory)
              const isLabelPrinter = dev.targetType === 'LABEL' || isZebra || isDymo || isTsc || isHoneywell ||
                ['ql-', 'td-', 'pt-', 'labelwriter', 'label', 'xp-423', 'xp423', 'mb2', 'mb3', 'mh2', 'mh3', 'ml2', 'ml3', 'da2', 'da3', 'te2', 'te3', 'pc42', 'pc43'].some(p => modelLower.includes(p));
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
                isTsc ? 'TSPL' :
                (isHoneywell || isDymo || isA4Printer) ? 'WINDOWS' : 'THERMAL';
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
                      dev.connectionType === 'SERIAL' ? 'bg-brand-100 text-brand-700' :
                      dev.connectionType === 'NETWORK' ? 'bg-cyan-100 text-cyan-700' :
                      'bg-slate-100 text-slate-500'
                    }`}>
                      {dev.connectionType}
                    </span>
                  </div>
                  <div className={dev.driverInstalled ? 'text-emerald-600' : 'text-amber-600'}>
                    {dev.driverInstalled ? '● Driver installed' : '○ Driver not installed'}
                  </div>
                  {dev.windowsPrinterName && dev.windowsPrinterName !== dev.model && (
                    <div className="text-slate-600">Windows name: <strong>{dev.windowsPrinterName}</strong></div>
                  )}
                  {dev.portName && (
                    <div className="text-slate-600">Port: <strong>{dev.portName}</strong></div>
                  )}
                  {dev.comPort && (
                    <div className="text-emerald-600">● COM port: <strong>{dev.comPort}</strong></div>
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
                      <div className="text-emerald-600 font-medium">
                        ✓ Configured as {printerTypeLabel(t, targetType)} printer
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
                            isZebra ? 'bg-brand-50 text-brand-700 hover:bg-brand-100' :
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
                              Auto Setup as {printerTypeLabel(t, targetType)}
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
                    <div className={`mt-1 text-[11px] ${refreshMsg.success ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {refreshMsg.message}
                    </div>
                  )}
                  {diagnoseResult?.key === devKey && (() => {
                    const r = diagnoseResult.result;
                    const step = (ok: boolean | undefined, label: string) => (
                      <div className="flex items-start gap-1.5">
                        <span className={ok ? 'text-emerald-600' : 'text-amber-600'}>{ok ? '✓' : '✗'}</span>
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
                          <div className="mt-2 pt-2 border-t border-slate-200 text-emerald-600 font-medium">
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
            posnetInstallResult.success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}>
            {posnetInstallResult.message}
            {posnetInstallResult.success && (posnetInstallResult as any).rebootRequired && (
              <span className="ml-1 font-medium">(Reboot may be required)</span>
            )}
          </div>
        )}

        {autoSetupResult && (
          <div className={`mb-3 px-3 py-2 rounded-lg text-xs ${
            autoSetupResult.success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}>
            {autoSetupResult.success
              ? autoSetupResult.message || `Configured on ${autoSetupResult.port || (autoSetupResult as any).windowsPrinter}`
              : autoSetupResult.message}
          </div>
        )}
          </div>
          </SettingsSection>

          {/* Printer Settings */}
          <SettingsSection searchQuery={settingsSearch} keywords={printerSettingsKeywords}>
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
              const isLabel = isLabelMediaType(printerType);
              const isFabricTag = printerType === 'FABRIC_TAG';
              const supportsCalibrationProtocol = printerConfig.protocol === 'ZEBRA' || printerConfig.protocol === 'TSPL';
              const canCalibrateMedia = supportsLabelMediaCalibration(printerConfig, printerType);
              const isFiscalElzab = printerType === 'FISCAL' &&
                printerConfig.protocol === 'ELZAB_STX';

              return (
                <div key={printerType} className="border border-slate-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 text-slate-600">
                        {printerType === 'RECEIPT' && <Printer size={16} />}
                        {printerType === 'FISCAL' && <Shield size={16} />}
                        {printerType === 'LABEL' && <Tag size={16} />}
                        {printerType === 'FABRIC_TAG' && <Shirt size={16} />}
                        {printerType === 'A4' && <FileText size={16} />}
                        {printerType === 'TICKET' && <Ticket size={16} />}
                        {printerType === 'KITCHEN' && <UtensilsCrossed size={16} />}
                      </span>
                      <div>
                        <h3 className="text-sm font-medium text-slate-700">{printerTypeLabel(t, printerType)}</h3>
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
                              {t(labelTrKey(printerConfig.protocol))} (invalid for {printerTypeLabel(t, printerType)})
                            </option>
                          )}
                        </select>
                        {!currentIsAllowed && (
                          <p className="mt-1 text-xs text-amber-700">
                            {printerConfig.protocol} is not valid for {printerTypeLabel(t, printerType)}. Allowed: {allowedProtocols.join(', ')}
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
                                    onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 10) updatePrinter(printerType, { labelWidth: isFabricTag ? 20 : 50 }); }}
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
                                    onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 10) updatePrinter(printerType, { labelHeight: isFabricTag ? 60 : 30 }); }}
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

                          {/* TSPL media tuning — resin ribbon on satin needs more heat and less speed than paper */}
                          {printerConfig.protocol === 'TSPL' && (
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.printSpeed')} (ips)</label>
                                <input
                                  type="number"
                                  value={printerConfig.printSpeed ?? 3}
                                  onChange={(e) => updatePrinter(printerType, { printSpeed: parseInt(e.target.value) || 0 })}
                                  onBlur={(e) => { const v = parseInt(e.target.value); if (!v || v < 1 || v > 12) updatePrinter(printerType, { printSpeed: 3 }); }}
                                  min={1}
                                  max={12}
                                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.printDensity')} (0-15)</label>
                                <input
                                  type="number"
                                  value={printerConfig.printDensity ?? (isFabricTag ? 12 : 10)}
                                  onChange={(e) => updatePrinter(printerType, { printDensity: parseInt(e.target.value) || 0 })}
                                  onBlur={(e) => { const v = parseInt(e.target.value); if (isNaN(v) || v < 0 || v > 15) updatePrinter(printerType, { printDensity: isFabricTag ? 12 : 10 }); }}
                                  min={0}
                                  max={15}
                                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.mediaSensor')}</label>
                                <select
                                  value={printerConfig.mediaSensor || 'gap'}
                                  onChange={(e) => updatePrinter(printerType, { mediaSensor: e.target.value as 'gap' | 'bline' | 'none' })}
                                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                                >
                                  <option value="gap">{t('settings.sensorGap')}</option>
                                  <option value="bline">{t('settings.sensorBline')}</option>
                                  <option value="none">{t('settings.sensorNone')}</option>
                                </select>
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.labelGap')} (mm)</label>
                                <input
                                  type="number"
                                  value={printerConfig.labelGapMm ?? 2}
                                  onChange={(e) => updatePrinter(printerType, { labelGapMm: parseFloat(e.target.value) || 0 })}
                                  disabled={printerConfig.mediaSensor === 'none'}
                                  min={0}
                                  max={20}
                                  step={0.5}
                                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none disabled:bg-slate-50 disabled:text-slate-400"
                                />
                              </div>
                              <div className="col-span-2">
                                <label className="block text-xs font-medium text-slate-600 mb-1">{t('settings.labelOriginInset')}</label>
                                <input
                                  type="number"
                                  value={printerConfig.labelOriginInsetMm ?? 0}
                                  onChange={(e) => updatePrinter(printerType, { labelOriginInsetMm: parseFloat(e.target.value) || 0 })}
                                  onBlur={(e) => { const v = parseFloat(e.target.value); if (isNaN(v) || v < 0) updatePrinter(printerType, { labelOriginInsetMm: 0 }); }}
                                  min={0}
                                  max={10}
                                  step={0.1}
                                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                                />
                                <p className="mt-1 text-xs text-slate-500">{t('settings.labelOriginInsetHint')}</p>
                              </div>
                            </div>
                          )}
                        </>
                      )}

                      {isFabricTag && (
                        <FabricTagComposer
                          t={t}
                          labelWidthMm={printerConfig.labelWidth || 20}
                          labelHeightMm={printerConfig.labelHeight || 60}
                          ready={isFabricTagPrinterReady(printerConfig)}
                        />
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
                              ? 'bg-emerald-50 text-emerald-700'
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
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  onClick={() => handleCopyTestPrintError(testResult, { ...printerConfig, enabled: true })}
                                  className="px-2 py-1 rounded bg-white/70 text-slate-800 hover:bg-white text-[11px] font-medium"
                                >
                                  {copiedTestError ? 'Copied' : 'Copy error'}
                                </button>
                                <button
                                  onClick={() => window.electronAPI.openLogFolder?.()}
                                  className="px-2 py-1 rounded bg-white/70 text-slate-800 hover:bg-white text-[11px] font-medium"
                                >
                                  Open log folder
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {isFiscalElzab && (
                          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                            <div className="mb-3 rounded-lg border border-white/70 bg-white/70 p-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-2">
                                  <Clock className="h-4 w-4 shrink-0 text-slate-600" />
                                  <div className="min-w-0">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                                      {tOr('settings.fiscalDailyReportTimer', 'Fiscal daily report timer')}
                                    </div>
                                    <div className="text-xs text-slate-500">
                                      {fiscalDailyReport.enabled
                                        ? `${fiscalDailyReportTimeValue(fiscalDailyReport)} ${fiscalDailyReport.timezone}`
                                        : tOr('settings.disabled', 'Disabled')}
                                    </div>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => updateFiscalDailyReport({ enabled: !fiscalDailyReport.enabled })}
                                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                                    fiscalDailyReport.enabled ? 'bg-brand-600' : 'bg-slate-300'
                                  }`}
                                >
                                  <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                      fiscalDailyReport.enabled ? 'translate-x-6' : 'translate-x-1'
                                    }`}
                                  />
                                </button>
                              </div>

                              <div className="mt-3 grid grid-cols-2 gap-3">
                                <label className="block">
                                  <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.hour24h', 'Hour (24h)')}</span>
                                  <select
                                    value={fiscalDailyReport.hour}
                                    onChange={(e) => updateFiscalDailyReport({ hour: Number(e.target.value) })}
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                                  >
                                    {FISCAL_DAILY_REPORT_HOURS.map((hour) => (
                                      <option key={hour} value={hour}>
                                        {String(hour).padStart(2, '0')}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.minute', 'Minute')}</span>
                                  <select
                                    value={fiscalDailyReport.minute}
                                    onChange={(e) => updateFiscalDailyReport({ minute: Number(e.target.value) })}
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                                  >
                                    {FISCAL_DAILY_REPORT_MINUTES.map((minute) => (
                                      <option key={minute} value={minute}>
                                        {String(minute).padStart(2, '0')}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.retries', 'Retries')}</span>
                                  <select
                                    value={fiscalDailyReportRetries}
                                    onChange={(e) => updateFiscalDailyReport({ maxAttempts: Number(e.target.value) + 1 })}
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                                  >
                                    {FISCAL_DAILY_REPORT_RETRY_OPTIONS.map((retries) => (
                                      <option key={retries} value={retries}>
                                        {retries}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="block">
                                  <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.retryEvery', 'Retry every')}</span>
                                  <select
                                    disabled={fiscalDailyReportRetries === 0}
                                    value={fiscalDailyReport.retryMinutes}
                                    onChange={(e) => updateFiscalDailyReport({ retryMinutes: Number(e.target.value) })}
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300 disabled:bg-slate-100 disabled:text-slate-400"
                                  >
                                    {fiscalDailyReportRetryMinuteOptions.map((minutes) => (
                                      <option key={minutes} value={minutes}>
                                        {minutes} min
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="col-span-2 block">
                                  <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.timezone', 'Timezone')}</span>
                                  <select
                                    disabled
                                    value={FISCAL_DAILY_REPORT_TIMEZONE}
                                    onChange={() => updateFiscalDailyReport({ timezone: FISCAL_DAILY_REPORT_TIMEZONE })}
                                    className="w-full rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-600 outline-none"
                                  >
                                    <option value={FISCAL_DAILY_REPORT_TIMEZONE}>{FISCAL_DAILY_REPORT_TIMEZONE}</option>
                                  </select>
                                </label>
                              </div>

                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                                  <span className="text-xs font-medium text-slate-700">{tOr('settings.thisPosIsMaster', 'This POS is master')}</span>
                                  <input
                                    type="checkbox"
                                    checked={fiscalDailyReport.master}
                                    onChange={(e) => updateFiscalDailyReport({ master: e.target.checked })}
                                    className="h-4 w-4 accent-brand-600"
                                  />
                                </label>
                                <button
                                  type="button"
                                  aria-expanded={showFiscalDailyReportAdvanced}
                                  onClick={() => setShowFiscalDailyReportAdvanced((open) => !open)}
                                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                                >
                                  {tOr('settings.advanced', 'Advanced')}
                                </button>
                              </div>
                              {showFiscalDailyReportAdvanced && (
                                <div className="mt-2">
                                  <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                                    <span className="text-xs font-medium text-slate-700">{tOr('settings.forceAutoReport', 'Force auto report')}</span>
                                    <input
                                      type="checkbox"
                                      checked={fiscalDailyReport.unconditionally}
                                      onChange={(e) => updateFiscalDailyReport({ unconditionally: e.target.checked })}
                                      className="h-4 w-4 accent-brand-600"
                                    />
                                  </label>
                                </div>
                              )}
                            </div>
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                                  {tOr('settings.fiscalDailyReport', 'Fiscal daily report')}
                                </div>
                                <p className="mt-1 text-xs leading-5 text-amber-800">
                                  This closes the current ELZAB fiscal period. Use only while standing beside POS1 and the fiscal printer.
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={handlePrintFiscalDailyReportNow}
                              disabled={!fiscalDailyReport.master || printingFiscalDailyReport || testingPrinter !== null}
                              className={`mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                                !fiscalDailyReport.master || printingFiscalDailyReport || testingPrinter !== null
                                  ? 'cursor-not-allowed bg-slate-100 text-slate-400'
                                  : 'bg-amber-600 text-white hover:bg-amber-700 active:bg-amber-800'
                              }`}
                            >
                              {printingFiscalDailyReport ? (
                                <>
                                  <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                  </svg>
                                  Printing fiscal daily report...
                                </>
                              ) : (
                                <>
                                  <Shield className="h-4 w-4" />
                                  {tOr('settings.printFiscalDailyReportNow', 'Print fiscal daily report now')}
                                </>
                              )}
                            </button>
                            {!fiscalDailyReport.master && (
                              <div className="mt-2 text-xs text-amber-800">
                                Enable master on this POS to allow fiscal daily report printing.
                              </div>
                            )}
                            {fiscalDailyReportResult && (
                              <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                                fiscalDailyReportResult.success && fiscalDailyReportResult.data?.confirmationUnknown
                                  ? 'bg-amber-50 text-amber-700'
                                  : fiscalDailyReportResult.success
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : 'bg-red-50 text-red-700'
                              }`}>
                                <div className="font-semibold">
                                  {fiscalDailyReportResult.success
                                    ? fiscalDailyReportResult.data?.confirmationUnknown
                                      ? 'Daily report accepted - confirm paper report'
                                      : 'Daily report created'
                                    : `Daily report failed: ${fiscalDailyReportResult.error || fiscalDailyReportResult.detail || 'Unknown error'}`}
                                </div>
                                {fiscalDailyReportResult.data && (
                                  <div className="mt-1 space-y-0.5 font-mono text-[11px]">
                                    <div>command: {fiscalDailyReportResult.data.commandUsed || '-'}</div>
                                    <div>report no: {fiscalDailyReportResult.data.beforeReportNumber ?? '?'} -&gt; {fiscalDailyReportResult.data.afterReportNumber ?? '?'}</div>
                                    <div>forced: {fiscalDailyReportResult.data.unconditionally === 1 ? 'yes' : 'no'}</div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Gap/mark calibration must never run on continuous media. */}
                        {supportsCalibrationProtocol && (
                          <>
                            <button
                              onClick={() => handleCalibrate(printerType)}
                              disabled={calibratingPrinter === printerType || !canCalibrateMedia}
                              className={`w-full min-h-11 mt-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                                calibratingPrinter === printerType || !canCalibrateMedia
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
                            {printerConfig.mediaSensor === 'none' && (
                              <p className="mt-2 text-xs text-slate-500">
                                {tOr(
                                  'calibrate.continuousDisabled',
                                  'Calibration is unavailable for continuous media without a gap or black mark.',
                                )}
                              </p>
                            )}
                            {calibrateResult && calibrateResult.printerType === printerType && (
                              <div className={`mt-2 px-3 py-2 rounded-lg text-xs ${
                                calibrateResult.success
                                  ? 'bg-emerald-50 text-emerald-700'
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
                    sharedReceiptRouteReady ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                  }`}>
                    {sharedReceiptRouteReady ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800">{tOr('settings.selfCheckoutReceiptPrinting', 'Self-checkout receipt printing')}</h3>
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
                      disabled={sharedPrinterSavingId === `${SELF_CHECKOUT_RECEIPT_ROLE}:clear`}
                      className="min-h-10 px-3 py-2 border border-red-200 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {sharedPrinterSavingId === `${SELF_CHECKOUT_RECEIPT_ROLE}:clear` ? 'Stopping...' : 'Stop sharing'}
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
                      <span className={`px-2 py-1 rounded-full ${sharedReceiptPrinter.agentIsOnline ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                        {sharedReceiptPrinter.agentIsOnline ? 'POS app online' : 'POS app offline'}
                      </span>
                      <span className={`px-2 py-1 rounded-full ${sharedReceiptPrinter.isOnline ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
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
                  {tOr('settings.availableReceiptPrinters', 'Available receipt printers')}
                </div>
                {sharedReceiptPrinters.length === 0 && (
                  <div className="text-xs text-slate-500 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                    {sharedPrintersLoading ? 'Loading salon receipt printers...' : 'No shareable receipt printers found'}
                  </div>
                )}
                {sharedReceiptPrinters.map((printer) => {
                  const selected = selectedSharedPrinterId === printer.id;
                  const ownedByThisPos = isPrinterOwnedByThisPos(printer);
                  const routeState = getSalonPrinterRouteState(printer);
                  const canUseThisPrinter = isSalonPrinterRouteReady(printer);
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
                            <span className={`px-2 py-1 rounded-full ${routeState.className}`}>
                              {routeState.label}
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
                                disabled={sharedPrinterSavingId === `${SELF_CHECKOUT_RECEIPT_ROLE}:clear`}
                                className="min-h-10 px-3 py-2 rounded-lg border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                              >
                                {sharedPrinterSavingId === `${SELF_CHECKOUT_RECEIPT_ROLE}:clear` ? 'Stopping...' : 'Stop sharing'}
                              </button>
                            ) : (
                              <div className="min-h-10 px-3 py-2 rounded-lg bg-slate-100 text-sm font-medium text-slate-500">
                                Route selected
                              </div>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleAssignSharedPrinter(printer.id)}
                              disabled={!canUseThisPrinter || sharedPrinterSavingId === `${SELF_CHECKOUT_RECEIPT_ROLE}:${printer.id}`}
                              className={`min-h-10 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                canUseThisPrinter
                                  ? 'bg-brand-600 text-white hover:bg-brand-700'
                                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                              }`}
                            >
                              {sharedPrinterSavingId === `${SELF_CHECKOUT_RECEIPT_ROLE}:${printer.id}`
                                ? 'Saving...'
                                : 'Use for self-checkout'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!canManageSharedReceiptRoute && selectedSharedPrinterId && (
                  <div className="text-xs text-slate-500">
                    The selected route is kept, but no ready receipt printer is currently available for changes.
                  </div>
                )}
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">{tOr('settings.kitchenWifiDirect', 'Kitchen Wi-Fi Direct')}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    LAN-first is used only for KITCHEN_TICKET jobs. Backend routing stays as fallback.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => refreshLanKitchenStatus()}
                    className="min-h-10 px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50"
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveLanKitchenWifiDirect}
                    disabled={lanKitchenSaving || lanKitchenTesting}
                    className="min-h-10 px-3 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {lanKitchenSaving ? 'Saving...' : 'Save Wi-Fi setup'}
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border border-slate-200 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{tOr('settings.receiveKitchenOrdersOverWifi', 'Receive kitchen orders over Wi-Fi')}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        Local IP: {lanKitchenNetworkInfo?.suggestedHost || 'detecting'} - Port {lanKitchenNetworkInfo?.port || lanKitchenReceivePort || DEFAULT_LAN_FIRST_KITCHEN_PORT}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLanKitchenReceiveEnabled((enabled) => !enabled)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                        lanKitchenReceiveEnabled ? 'bg-brand-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          lanKitchenReceiveEnabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.port', 'Port')}</span>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={lanKitchenReceivePort}
                        onChange={(e) => setLanKitchenReceivePort(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.pairingCode', 'Pairing code')}</span>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={8}
                          value={lanKitchenReceiverPairingCode}
                          onChange={(e) => setLanKitchenReceiverPairingCode(e.target.value)}
                          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                          placeholder={lanKitchenPairingStatus?.receiverHasPairingCode ? 'Saved' : '6 digits'}
                        />
                        <button
                          type="button"
                          onClick={() => setLanKitchenReceiverPairingCode(createScalePairingCode())}
                          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                          New
                        </button>
                      </div>
                    </label>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                    <span className={`rounded-full px-2 py-1 ${lanKitchenNetworkInfo?.running ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {lanKitchenNetworkInfo?.running ? 'Receiver running' : 'Receiver stopped'}
                    </span>
                    <span className={`rounded-full px-2 py-1 ${lanKitchenPairingStatus?.receiverHasPairingCode ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>
                      {lanKitchenPairingStatus?.receiverHasPairingCode ? 'Pairing code saved' : 'No pairing code'}
                    </span>
                    {lanKitchenNetworkInfo?.error && (
                      <span className="rounded-full bg-red-50 px-2 py-1 text-red-700">{lanKitchenNetworkInfo.error}</span>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{tOr('settings.useWifiFirstForKitchenTickets', 'Use Wi-Fi first for kitchen tickets')}</div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        Select a ready KITCHEN printer; Settings saves the machine/printer target internally.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLanKitchenSenderEnabled((enabled) => !enabled)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                        lanKitchenSenderEnabled ? 'bg-brand-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          lanKitchenSenderEnabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="mt-3 space-y-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.kitchenPrinter', 'Kitchen printer')}</span>
                      <select
                        value={lanKitchenSelectedPrinterId}
                        onChange={(e) => setLanKitchenSelectedPrinterId(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                      >
                        <option value="">Select ready kitchen printer</option>
                        {readyKitchenWifiPrinters.map((printer) => (
                          <option key={printer.id} value={printer.id}>
                            {getServerPrinterName(printer)} - {getServerPrinterOwnerLabel(printer)}
                          </option>
                        ))}
                      </select>
                      {readyKitchenWifiPrinters.length === 0 && (
                        <div className="mt-1 text-xs text-amber-700">No ready KITCHEN printer is available in salon printers.</div>
                      )}
                    </label>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.kitchenPosHostIp', 'Kitchen POS host/IP')}</span>
                        <input
                          type="text"
                          value={lanKitchenTargetHost}
                          onChange={(e) => setLanKitchenTargetHost(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                          placeholder="192.168.1.50"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.port', 'Port')}</span>
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          value={lanKitchenTargetPort}
                          onChange={(e) => setLanKitchenTargetPort(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                        />
                      </label>
                    </div>

                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">{tOr('settings.senderPairingCode', 'Sender pairing code')}</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={8}
                        value={lanKitchenSenderPairingCode}
                        onChange={(e) => setLanKitchenSenderPairingCode(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-300"
                        placeholder={lanKitchenPairingStatus?.senderHasPairingCode ? 'Saved' : 'Same 6 digits as receiver'}
                      />
                    </label>

                    <button
                      type="button"
                      onClick={handleTestLanKitchenWifiRoute}
                      disabled={lanKitchenTesting || lanKitchenSaving || !lanKitchenTargetHost.trim() || !lanKitchenSelectedPrinterId}
                      className="min-h-10 w-full rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                    >
                      {lanKitchenTesting ? 'Testing Wi-Fi route...' : 'Test Wi-Fi route'}
                    </button>
                  </div>
                </div>
              </div>

              {lanKitchenResult && (
                <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${lanKitchenResult.success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                  {lanKitchenResult.message}
                </div>
              )}
            </div>

            <div className="border border-slate-200 rounded-lg p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">{tOr('settings.salonOnlinePrinters', 'Salon online printers')}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Read-only salon inventory. A printer is ready only when its owner POS app is online, the device is connected, and a target is configured.
                  </p>
                </div>
                <div className="text-xs text-slate-500 md:text-right">
                  <span className="font-semibold text-slate-700">{salonReadyPrinters.length}</span> ready / {salonConfiguredPrinters.length} configured
                </div>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {enabledSalonRoutes.map((route) => {
                  const assignment = printerAssignments.find((item) => item.role === route.role) || null;
                  const selectedPrinter = assignment
                    ? salonInventoryPrinters.find((printer) => printer.id === assignment.printerId)
                      || salonPrinters.find((printer) => printer.id === assignment.printerId)
                      || null
                    : null;
                  const routeCandidates = salonInventoryPrinters
                    .filter((printer) => isServerPrinterType(printer, route.printerType));
                  const candidates = route.role === 'FISCAL_RECEIPT'
                    ? routeCandidates.filter(isSalonPrinterRouteReady)
                    : routeCandidates.filter(hasServerPrinterTarget);
                  const showRouteActions = route.role !== SELF_CHECKOUT_RECEIPT_ROLE;
                  const clearSaving = sharedPrinterSavingId === `${route.role}:clear`;

                  return (
                    <div key={route.role} className="rounded-lg border border-slate-200 px-3 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-800">{route.title}</div>
                          <div className="text-xs text-slate-500 mt-0.5">{route.description}</div>
                        </div>
                        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">
                          Live
                        </span>
                      </div>
                      {selectedPrinter && (
                        <div className="mt-3 flex flex-col gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            Selected: <span className="font-medium text-slate-800">{getServerPrinterName(selectedPrinter)}</span> - {getServerPrinterOwnerLabel(selectedPrinter)}
                          </div>
                          {showRouteActions && (
                            <button
                              type="button"
                              onClick={() => handleClearSharedPrinter(route.role)}
                              disabled={clearSaving}
                              className="min-h-8 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                            >
                              {clearSaving ? 'Clearing...' : 'Clear route'}
                            </button>
                          )}
                        </div>
                      )}
                      <div className="mt-3 space-y-2">
                        {candidates.length === 0 && (
                          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500">
                            {sharedPrintersLoading ? 'Loading printers...' : `No ${route.role === 'FISCAL_RECEIPT' ? 'ready' : 'configured'} ${route.printerType} printers found`}
                          </div>
                        )}
                        {candidates.slice(0, 4).map((printer) => {
                          const state = getSalonPrinterRouteState(printer);
                          const selected = assignment?.printerId === printer.id;
                          const canUseThisPrinter = isSalonPrinterRouteReady(printer);
                          const saving = sharedPrinterSavingId === `${route.role}:${printer.id}`;
                          return (
                            <div key={`${route.role}-${printer.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-slate-700">{getServerPrinterName(printer)}</div>
                                <div className="mt-0.5 truncate text-xs text-slate-500">
                                  {getServerPrinterOwnerLabel(printer)} - {getServerPrinterTarget(printer)}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                {selected && (
                                  <span className="rounded-full bg-brand-100 px-2 py-1 text-[11px] font-medium text-brand-700">Selected</span>
                                )}
                                <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${state.className}`}>{state.label}</span>
                                {showRouteActions && !selected && (
                                  <button
                                    type="button"
                                    onClick={() => handleAssignSharedPrinter(printer.id, route.role)}
                                    disabled={!canUseThisPrinter || saving}
                                    className={`min-h-8 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                                      canUseThisPrinter
                                        ? 'bg-brand-600 text-white hover:bg-brand-700'
                                        : 'cursor-not-allowed bg-slate-100 text-slate-400'
                                    }`}
                                  >
                                    {saving ? 'Saving...' : 'Use'}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                <div className="rounded-lg border border-slate-200 px-3 py-3">
                  <div className="text-sm font-medium text-slate-800">{tOr('settings.plannedPrinterRoutes', 'Planned printer routes')}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    These roles are visible here so the Settings model can grow without changing local hardware setup.
                  </div>
                  <div className="mt-3 space-y-2">
                    {futureSalonRoutes.map((route) => {
                      const readyCount = salonReadyPrinters.filter((printer) => isServerPrinterType(printer, route.printerType)).length;
                      return (
                        <div key={route.role} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-700">{route.title}</div>
                            <div className="mt-0.5 truncate text-xs text-slate-500">{route.description}</div>
                          </div>
                          <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${readyCount > 0 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                            {route.blocking ? 'Needs blocking API' : 'Backend needed'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-sm font-medium text-slate-700">{tOr('settings.localPrinterConfigThisPos', 'Local printer config (this POS)')}</h3>
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
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{tOr('settings.predefined', 'Predefined')}</div>
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
                          <span className={`text-[11px] px-2 py-1 rounded-full ${printer.isEnabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
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
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{tOr('settings.customPrinters', 'Custom printers')}</div>
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
                        {customPrinterForm.id ? tOr('settings.editCustomPrinter', 'Edit custom printer') : tOr('settings.addCustomPrinter', 'Add custom printer')}
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
                        <label className="block text-xs font-medium text-slate-600 mb-1">{tOr('settings.displayName', 'Display name')}</label>
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
                          <label className="block text-xs font-medium text-slate-600 mb-1">{tOr('settings.type', 'Type')}</label>
                          <select
                            value={customPrinterForm.printerType}
                            onChange={(e) => updateCustomPrinterForm({ printerType: e.target.value as PrinterTypeValue })}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                          >
                            {PRINTER_TYPES.map((printerType) => (
                              <option key={printerType} value={printerType}>{printerTypeLabel(t, printerType)}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-slate-600 mb-1">{tOr('settings.protocol', 'Protocol')}</label>
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
                          <label className="block text-xs font-medium text-slate-600 mb-1">{tOr('settings.windowsPrinter', 'Windows printer')}</label>
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
                          <label className="block text-xs font-medium text-slate-600 mb-1">{tOr('settings.comPortAddress', 'COM port / address')}</label>
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
                          <label className="block text-xs font-medium text-slate-600 mb-1">{tOr('settings.paperWidthMm', 'Paper width (mm)')}</label>
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
                            <label className="block text-xs font-medium text-slate-600 mb-1">{tOr('settings.paperHeightMm', 'Paper height (mm)')}</label>
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
                        {tOr('settings.enabled', 'Enabled')}
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
                    <h3 className="text-sm font-medium text-slate-700">{tOr('settings.advancedDiagnosticsSqliteMirror', 'Advanced diagnostics: SQLite mirror')}</h3>
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
                        <span className={`px-2 py-1 rounded-full ${printer.is_online === 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
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
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-red-50 text-red-700'
                }`}>
                  <div className="font-medium">
                    {testResult.success ? t('test.success') : `${t('test.error')}: ${testResult.error}`}
                  </div>
                  {!testResult.success && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        onClick={() => handleCopyTestPrintError(testResult, {
                          enabled: true,
                          protocol,
                          port: selectedPort,
                          baudRate,
                          windowsPrinter: zebraPrinter,
                          paperWidth: labelWidth,
                        })}
                        className="px-2 py-1 rounded bg-white/70 text-slate-800 hover:bg-white text-[11px] font-medium"
                      >
                        {copiedTestError ? 'Copied' : 'Copy error'}
                      </button>
                      <button
                        onClick={() => window.electronAPI.openLogFolder?.()}
                        className="px-2 py-1 rounded bg-white/70 text-slate-800 hover:bg-white text-[11px] font-medium"
                      >
                        Open log folder
                      </button>
                    </div>
                  )}
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
              <span className={`text-xs ${printerSaveResult.success ? 'text-emerald-600' : 'text-red-600'}`}>
                {printerSaveResult.message}
              </span>
            )}
          </div>
        </div>
          </div>
          </SettingsSection>
        </>
      )}

      {settingsTab === 'pos' && (
        <>
          {/* POS Settings */}
          <SettingsSection searchQuery={settingsSearch} keywords={posSettingsKeywords}>
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
                {/* Rendered from the shared list so every supported POS trade
                    uses the same validated values. */}
                {POS_MODES.map((mode) => (
                  <option key={mode} value={mode}>{t(`pos.mode.${mode}`)}</option>
                ))}
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

            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex min-w-0 gap-3">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-600" />
                <div className="min-w-0">
                  <label className="block text-sm font-semibold text-slate-700">
                    {t('settings.allowOversell')}
                  </label>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {t('settings.allowOversellDesc')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={allowOversell}
                onClick={() => setAllowOversell(!allowOversell)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  allowOversell ? 'bg-red-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    allowOversell ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex min-w-0 gap-3">
                <LayoutGrid size={18} className="mt-0.5 shrink-0 text-brand-600" />
                <div className="min-w-0">
                  <label className="block text-sm font-semibold text-slate-700">
                    {tOr('settings.retailSimpleGrid', 'Simple product grid (fair / market stall)')}
                  </label>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {tOr('settings.retailSimpleGridDesc', 'Retail POS shows every product on one grid from the start. Category tiles and the kg/piece filter are hidden; search and payment work as usual.')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={retailSimpleGrid}
                onClick={() => setRetailSimpleGrid(!retailSimpleGrid)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  retailSimpleGrid ? 'bg-brand-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    retailSimpleGrid ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <label className="block text-sm font-semibold text-slate-700">
                {tOr('settings.fiscalOnCashSale', 'Fiscal receipt on cash/BLIK sale')}
              </label>
              <div
                className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3"
                role="radiogroup"
                aria-label={tOr('settings.fiscalOnCashSale', 'Fiscal receipt on cash/BLIK sale')}
              >
                {FISCAL_ON_CASH_SALE_OPTIONS.map(option => {
                  const selected = fiscalOnCashSale === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setFiscalOnCashSale(option.value)}
                      className={`min-h-[44px] rounded-lg border px-3 py-2 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
                        selected
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {tOr(option.labelKey, option.fallback)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <label className="block text-sm font-semibold text-slate-700">
                    {tOr('settings.autoOrderDiscount', 'Automatic discount on every order')}
                  </label>
                  <p className="mt-1 text-xs text-slate-500">
                    {tOr('settings.autoOrderDiscount.hint', 'Applied to the whole receipt when a new cart starts. Cashier can still clear it per order.')}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoDiscountEnabled}
                  aria-label={tOr('settings.autoOrderDiscount', 'Automatic discount on every order')}
                  onClick={() => setAutoDiscountEnabled(!autoDiscountEnabled)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    autoDiscountEnabled ? 'bg-brand-600' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      autoDiscountEnabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
              {autoDiscountEnabled && (
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600">
                      {tOr('settings.autoOrderDiscount.percent', 'Discount (%)')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      inputMode="numeric"
                      value={autoDiscountPercent}
                      onChange={(e) => setAutoDiscountPercent(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600">
                      {tOr('settings.autoOrderDiscount.endDate', 'Last day (optional)')}
                    </label>
                    <input
                      type="date"
                      value={autoDiscountEndDate}
                      onChange={(e) => setAutoDiscountEndDate(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      {tOr('settings.autoOrderDiscount.endDateHint', 'Discount stops automatically after this day.')}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Category priority ranking — retail browse order + size */}
            <div className="border-t border-slate-200 pt-4 mt-4">
              <CategoryRankingSettings lang={posLanguage || undefined} />
            </div>

            {/* Staff Management */}
            <div className="border-t border-slate-200 pt-4 mt-4">
              <StaffManagementSettings />
            </div>

            {/* Scale Settings */}
            <div className="border-t border-slate-200 pt-4 mt-4">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <Scale size={16} />
                  {tOr('settings.scale', 'Scale')}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Use a local USB/COM scale, or read a scale shared by another POS over Wi-Fi.
                </p>
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                {([
                  ['none', tOr('settings.noScale', 'No scale')],
                  ['local', tOr('settings.thisPosHasScale', 'This POS has scale')],
                  ['remote', tOr('settings.wifiScaleFromPos', 'Wi-Fi scale from POS')],
                ] as Array<[ScaleConnectionMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setScaleConnection(mode);
                      setScaleTestResult(null);
                    }}
                    className={`px-3 py-2 rounded-lg border text-sm font-semibold transition-colors ${
                      scaleConnection === mode
                        ? 'border-brand-500 bg-brand-50 text-brand-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {scaleConnection === 'local' && (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-slate-600 mb-1">
                        {tOr('settings.scalePort', 'Scale port')}
                      </label>
                      <select
                        value={scalePort}
                        onChange={(e) => {
                          setScalePort(e.target.value);
                          setScaleTestResult(null);
                        }}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                      >
                        <option value="">Auto-detect USB scale</option>
                        {scalePort && !ports.includes(scalePort) && (
                          <option value={scalePort}>{scalePort}</option>
                        )}
                        {ports.map((port) => (
                          <option key={port} value={port}>{port}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-600 mb-1">
                        {tOr('settings.protocol', 'Scale Type / Protocol')}
                      </label>
                      <div className="h-[38px] flex items-center px-3 rounded-lg border border-slate-200 bg-slate-50 text-sm font-medium text-slate-700">
                        {scaleModel || 'DIBAL GDPOS (9600 8N1)'}
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-600 mb-1">
                        USB-Serial Chipset
                      </label>
                      <div className="h-[38px] flex items-center px-3 rounded-lg border border-slate-200 bg-slate-50 text-xs font-mono text-slate-700 truncate" title={scaleChipset || 'Auto (FTDI / Prolific / CH340)'}>
                        {scaleChipset || 'Auto (FTDI / Prolific / CH340)'}
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-600 mb-1">
                        Driver Status
                      </label>
                      <div className={`h-[38px] flex items-center px-3 rounded-lg border text-xs font-semibold ${
                        scaleDriverStatus.includes('OK') || scalePort
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-slate-200 bg-slate-50 text-slate-500'
                      }`}>
                        {scaleDriverStatus || (scalePort ? 'Configured' : 'Not detected')}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-700">{tOr('settings.shareThisScaleOverWifi', 'Share this scale over Wi-Fi')}</p>
                        <p className="text-xs text-slate-500">Turn this on only on the machine physically connected to the scale.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !scaleShareEnabled;
                          setScaleShareEnabled(next);
                          if (next && !scaleShareToken.trim()) setScaleShareToken(createScalePairingCode());
                          setScaleTestResult(null);
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${
                          scaleShareEnabled ? 'bg-brand-600' : 'bg-slate-300'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            scaleShareEnabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>

                    {scaleShareEnabled && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-sm font-medium text-slate-600 mb-1">
                            {tOr('settings.thisMachineIp', 'This machine IP')}
                          </label>
                          <div className="h-[38px] flex items-center px-3 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700">
                            {scaleNetworkInfo?.suggestedHost || 'Detecting...'}
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-slate-600 mb-1">
                            {tOr('settings.sharePort', 'Share port')}
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={65535}
                            value={scaleSharePort}
                            onChange={(e) => setScaleSharePort(e.target.value)}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-slate-600 mb-1">
                            {tOr('settings.pairingCode', 'Pairing code')}
                          </label>
                          <div className="flex gap-2">
                            <input
                              value={scaleShareToken}
                              onChange={(e) => setScaleShareToken(e.target.value.replace(/\s/g, ''))}
                              className="min-w-0 flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => setScaleShareToken(createScalePairingCode())}
                              className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                            >
                              New
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {scaleShareEnabled && (
                      <p className={`text-xs font-medium ${
                        scaleNetworkInfo?.running ? 'text-emerald-700' : scaleNetworkInfo?.error ? 'text-amber-700' : 'text-slate-500'
                      }`}>
                        {scaleNetworkInfo?.running
                          ? `Sharing on ${scaleNetworkInfo.suggestedHost}:${scaleNetworkInfo.port || scaleSharePort}`
                          : scaleNetworkInfo?.error || 'Save settings to start sharing the scale.'}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {scaleConnection === 'remote' && (
                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">
                      {tOr('settings.hostIpOfScalePos', 'Host/IP of scale POS')}
                    </label>
                    <input
                      value={scaleRemoteHost}
                      onChange={(e) => {
                        setScaleRemoteHost(e.target.value);
                        setScaleTestResult(null);
                      }}
                      placeholder="192.168.1.20"
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">
                      {tOr('settings.remotePort', 'Remote port')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={scaleRemotePort}
                      onChange={(e) => {
                        setScaleRemotePort(e.target.value);
                        setScaleTestResult(null);
                      }}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">
                      {tOr('settings.pairingCode', 'Pairing code')}
                    </label>
                    <input
                      value={scaleRemoteToken}
                      onChange={(e) => {
                        setScaleRemoteToken(e.target.value.replace(/\s/g, ''));
                        setScaleTestResult(null);
                      }}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                    />
                  </div>
                </div>
              )}

              {scaleConnection !== 'none' && (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {scaleConnection === 'local' && (
                      <button
                        type="button"
                        onClick={handleAutoDetectScale}
                        disabled={scaleAutoDetecting || scaleTesting}
                        className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
                          scaleAutoDetecting
                            ? 'bg-slate-100 text-slate-400 cursor-wait'
                            : 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800'
                        }`}
                      >
                        <Wand2 size={16} className={scaleAutoDetecting ? 'animate-spin' : ''} />
                        {scaleAutoDetecting ? 'Detecting scale...' : 'Auto-detect scale'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleTestScale}
                      disabled={scaleTesting || scaleAutoDetecting}
                      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        scaleTesting
                          ? 'bg-slate-100 text-slate-400 cursor-wait'
                          : 'bg-emerald-600 text-white hover:bg-emerald-700'
                      }`}
                    >
                      <Scale size={16} />
                      {scaleTesting ? 'Reading...' : scaleConnection === 'remote' ? 'Test Wi-Fi scale' : 'Test scale'}
                    </button>
                    {scaleConnection === 'local' && (
                      <button
                        type="button"
                        onClick={handleRefreshPorts}
                        className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        Refresh ports
                      </button>
                    )}
                    {scaleTestResult && (
                      <span className={`text-xs font-semibold px-2.5 py-1.5 rounded-md border ${
                        scaleTestResult.success
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-amber-50 text-amber-800 border-amber-200'
                      }`}>
                        {scaleTestResult.message}
                      </span>
                    )}
                  </div>

                  {scaleDiagnoseSteps.length > 0 && (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
                      <p className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Scale Connection Diagnostics</p>
                      {scaleDiagnoseSteps.map((step, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs">
                          {step.ok ? (
                            <CheckCircle2 size={14} className="text-emerald-600 mt-0.5 shrink-0" />
                          ) : (
                            <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />
                          )}
                          <div>
                            <span className="font-semibold text-slate-800">{step.step}: </span>
                            <span className="text-slate-600">{step.detail || step.error}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
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

            {customerDisplayEnabled && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-3">
                  <div className="text-sm font-medium text-slate-700">{t('settings.customerDisplayMenuSections')}</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{t('settings.customerDisplayMenuSectionsDesc')}</p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4 rounded-md border border-slate-200 bg-white px-3 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700">{t('settings.customerDisplayRetailCatalog')}</div>
                      <div className="text-xs leading-5 text-slate-500">{t('settings.customerDisplayRetailCatalogDesc')}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCustomerDisplayRetailCatalogEnabled(!customerDisplayRetailCatalogEnabled)}
                      className={`relative h-7 w-14 shrink-0 rounded-full transition-colors ${
                        customerDisplayRetailCatalogEnabled ? 'bg-brand-600' : 'bg-slate-300'
                      }`}
                      aria-pressed={customerDisplayRetailCatalogEnabled}
                    >
                      <span
                        className={`absolute left-1 top-1 h-5 w-5 transform rounded-full bg-white transition-transform ${
                          customerDisplayRetailCatalogEnabled ? 'translate-x-7' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-4 rounded-md border border-slate-200 bg-white px-3 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700">{t('settings.customerDisplayFoodMenu')}</div>
                      <div className="text-xs leading-5 text-slate-500">{t('settings.customerDisplayFoodMenuDesc')}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCustomerDisplayFoodMenuEnabled(!customerDisplayFoodMenuEnabled)}
                      className={`relative h-7 w-14 shrink-0 rounded-full transition-colors ${
                        customerDisplayFoodMenuEnabled ? 'bg-brand-600' : 'bg-slate-300'
                      }`}
                      aria-pressed={customerDisplayFoodMenuEnabled}
                    >
                      <span
                        className={`absolute left-1 top-1 h-5 w-5 transform rounded-full bg-white transition-transform ${
                          customerDisplayFoodMenuEnabled ? 'translate-x-7' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
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
          </SettingsSection>

      {/* TV Ad Panel */}
      <SettingsSection searchQuery={settingsSearch} keywords={tvAdKeywords}>
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-700">
            {t('settings.tvAd.title')}
          </h2>
          <button
            type="button"
            onClick={async () => { setTvAdEnabled(!tvAdEnabled); await persistTvAd({ tvAdEnabled: !tvAdEnabled }); }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              tvAdEnabled ? 'bg-brand-600' : 'bg-slate-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                tvAdEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {tvAdEnabled && (
          <div className="space-y-4">
            {/* Playlist */}
            <div>
              <button
                type="button"
                onClick={handleAddTvAdVideo}
                className="inline-flex items-center gap-2 px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 transition-colors"
              >
                <Upload className="w-4 h-4" />
                {t('settings.tvAd.addVideo')}
              </button>
              {tvAdPlaylist.length > 0 && (
                <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
                  {tvAdPlaylist.slice().sort((a, b) => a.order - b.order).map((v, index, arr) => {
                    const type = v.type || (/\.(jpe?g|png|webp)$/i.test(v.filename) ? 'image' : 'video');
                    return (
                      <div key={v.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0">
                        <input
                          type="checkbox"
                          checked={v.enabled}
                          onChange={() => void handleToggleTvAdVideo(v.id)}
                          className="w-4 h-4 accent-brand-600"
                          title={v.enabled ? 'Enabled' : 'Disabled'}
                        />
                        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${type === 'image' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}`}>
                          {type === 'image' ? <ImageIcon className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
                          {type === 'image' ? 'Image' : 'Video'}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{v.filename}</span>
                        {type === 'image' && (
                          <label className="inline-flex items-center gap-1 text-xs text-slate-500">
                            <Clock className="w-3.5 h-3.5" />
                            <input
                              type="number"
                              min={2}
                              max={60}
                              value={Math.round((v.durationMs || 7000) / 1000)}
                              onChange={(e) => void handleTvAdImageDuration(v.id, Number(e.target.value))}
                              className="w-14 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700"
                            />
                            s
                          </label>
                        )}
                        {tvAdMode === 'repeat-one' && (
                          <input
                            type="radio"
                            name="tvAdRepeat"
                            checked={tvAdRepeatId === v.id}
                            onChange={async () => { setTvAdRepeatId(v.id); await persistTvAd({ tvAdRepeatVideoId: v.id }); }}
                            className="w-4 h-4 accent-brand-600"
                            title="Repeat this item"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => void handleMoveTvAdMedia(v.id, -1)}
                          disabled={index === 0}
                          className="rounded-md border border-slate-200 p-1.5 text-slate-500 disabled:opacity-30"
                          title="Move up"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleMoveTvAdMedia(v.id, 1)}
                          disabled={index === arr.length - 1}
                          className="rounded-md border border-slate-200 p-1.5 text-slate-500 disabled:opacity-30"
                          title="Move down"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveTvAdVideo(v.id)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {t('settings.tvAd.remove')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Playback mode */}
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">
                {t('settings.tvAd.playbackMode')}
              </label>
              <select
                value={tvAdMode}
                onChange={async (e) => {
                  const m = e.target.value as 'sequential' | 'repeat-one';
                  setTvAdMode(m);
                  await persistTvAd({ tvAdPlaybackMode: m });
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
              >
                <option value="sequential">{t('settings.tvAd.sequential')}</option>
                <option value="repeat-one">{t('settings.tvAd.repeatOne')}</option>
              </select>
            </div>

            {/* Muted toggle */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="tvAdMuted"
                checked={tvAdMuted}
                onChange={async (e) => { setTvAdMuted(e.target.checked); await persistTvAd({ tvAdMuted: e.target.checked }); }}
                className="w-4 h-4 accent-brand-600"
              />
              <label htmlFor="tvAdMuted" className="text-sm text-slate-600 cursor-pointer">
                {t('settings.tvAd.muted')}
              </label>
            </div>

            {/* Volume (only when not muted) */}
            {!tvAdMuted && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('settings.tvAd.volume')}: {tvAdVolume}%
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={tvAdVolume}
                  onChange={(e) => setTvAdVolume(parseInt(e.target.value))}
                  onPointerUp={() => void persistTvAd({ tvAdVolume })}
                  onMouseUp={() => void persistTvAd({ tvAdVolume })}
                  onTouchEnd={() => void persistTvAd({ tvAdVolume })}
                  className="w-full accent-brand-600"
                />
              </div>
            )}

            {/* Server status + TV connect address */}
            {tvAdStatus?.running && (tvAdStatus.primaryIp || tvAdStatus.ips[0]) && (
              <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <canvas ref={tvAdQrRef} className="rounded bg-white" />
                <div>
                  <div className="text-xs text-slate-500">{t('settings.tvAd.connectAddress')}</div>
                  <div className="text-2xl font-bold tracking-wide text-slate-800">
                    {(tvAdStatus.primaryIp || tvAdStatus.ips[0])}:{tvAdStatus.port}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{t('settings.tvAd.connectAddressHint')}</div>
                  {tvAdStatus.remoteUrl && (
                    <div className="text-xs text-slate-500 mt-1 break-all">
                      Phone remote: {tvAdStatus.remoteUrl}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="text-xs text-slate-500">
              {t('settings.tvAd.status')}:{' '}
              {tvAdStatus?.running ? (
                <span className="text-emerald-600 font-medium">
                  {t('settings.tvAd.running')}
                  {` — ${t('settings.tvAd.connectedTvs')}: ${tvAdStatus.connectedClients}`}
                </span>
              ) : (
                <span className="text-slate-400">{t('settings.tvAd.stopped')}</span>
              )}
            </div>
          </div>
        )}
      </div>
      </SettingsSection>

        </>
      )}

      {settingsTab === 'general' && (
        <>
          {/* Pairing Card */}
          <SettingsSection searchQuery={settingsSearch} keywords={pairingKeywords}>
          <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-4">
          {t('pairing.title')}
        </h2>

        {config?.isPaired ? (
          <div className="space-y-3">
            <div className="p-3 bg-emerald-50 rounded-lg">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <div className="flex-1">
                  <p className="text-sm font-medium text-emerald-800">
                    {t('pairing.paired')}: {config.salonName}
                  </p>
                  <p className="text-xs text-emerald-600">
                    {t('pairing.id')}: {config.agentId?.substring(0, 8)}...
                  </p>
                </div>
              </div>
              {config.apiKey && (
                <div className="mt-2 pt-2 border-t border-emerald-200">
                  <p className="text-xs text-emerald-600">
                    {t('pairing.apiKey')}: {config.apiKey.length > 11
                      ? `${config.apiKey.substring(0, 7)}...${config.apiKey.substring(config.apiKey.length - 4)}`
                      : '••••••••'}
                  </p>
                </div>
              )}
              <div className="mt-2 pt-2 border-t border-emerald-200 flex items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={isResyncingProducts}
                  onClick={async () => {
                    setIsResyncingProducts(true);
                    setResyncResult('idle');
                    try {
                      await window.electronAPI.pos.sync.products();
                      setResyncResult('success');
                    } catch {
                      setResyncResult('error');
                    } finally {
                      setIsResyncingProducts(false);
                    }
                  }}
                  className="text-xs text-emerald-700 underline underline-offset-2 hover:text-emerald-900 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isResyncingProducts
                    ? t('pairing.resyncProductsBusy')
                    : t('pairing.resyncProducts')}
                </button>
                {resyncResult === 'success' && (
                  <span className="text-xs text-emerald-600">{t('pairing.resyncProductsOk')}</span>
                )}
                {resyncResult === 'error' && (
                  <span className="text-xs text-red-600">{t('pairing.resyncProductsFail')}</span>
                )}
              </div>
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
                      <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
                  <p className="text-xs text-emerald-600 mt-1">{t('pairing.copied')}</p>
                )}
              </div>
            </div>
          </div>
        )}
          </div>
          </SettingsSection>

      {/* Telegram Remote Control */}
      <SettingsSection searchQuery={settingsSearch} keywords={telegramKeywords}>
      <TelegramConfig
        config={config}
        onConfigChange={onConfigChange}
        language={language}
      />
      </SettingsSection>

      {/* AI Settings (Local Mode with Tools) */}
      <SettingsSection searchQuery={settingsSearch} keywords={aiToolsKeywords}>
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
      </SettingsSection>

      {/* App Updates */}
      <SettingsSection searchQuery={settingsSearch} keywords={appUpdatesKeywords}>
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
              updateStatus.status === 'up-to-date' ? 'bg-emerald-50 text-emerald-700' :
              updateStatus.status === 'available' ? 'bg-blue-50 text-blue-700' :
              updateStatus.status === 'downloading' ? 'bg-blue-50 text-blue-700' :
              updateStatus.status === 'downloaded' ? 'bg-emerald-50 text-emerald-700' :
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
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors cursor-pointer"
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
      </SettingsSection>

      {/* SSH Tunnel Status */}
      {sshStatus && (
        <SettingsSection searchQuery={settingsSearch} keywords={sshTunnelKeywords}>
        <div className="panel p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">
            {t('ssh.title')}
          </h2>

          {/* Status indicator */}
          <div className="flex items-center gap-2 mb-3">
            <span className={`w-2.5 h-2.5 rounded-full ${
              sshStatus.state === 'connected' ? 'bg-emerald-500' :
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
              <span className={sshStatus.sshAvailable ? 'text-emerald-600' : 'text-slate-400'}>
                {sshStatus.sshAvailable ? '\u2713' : '\u2717'}
              </span>
              {t('ssh.clientAvailable')}
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className={sshStatus.sshServerAvailable ? 'text-emerald-600' : 'text-slate-400'}>
                {sshStatus.sshServerAvailable ? '\u2713' : '\u2717'}
              </span>
              {t('ssh.serverAvailable')}
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className={sshStatus.keyGenerated ? 'text-emerald-600' : 'text-slate-400'}>
                {sshStatus.keyGenerated ? '\u2713' : '\u2717'}
              </span>
              {t('ssh.keyGenerated')}
            </div>
          </div>

          {/* Connected info */}
          {sshStatus.state === 'connected' && sshStatus.assignedPort && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 mb-3">
              <p className="text-xs text-emerald-700">
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
        </SettingsSection>
      )}

      {/* POS Fiscal Visibility */}
      <SettingsSection searchQuery={settingsSearch} keywords={fiscalHistoryKeywords}>
      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">{t('settings.fiscalHistory')}</h2>
        <p className="text-xs text-slate-400 mb-4">{t('settings.fiscalHistoryDesc')}</p>
        <label className="flex items-center justify-between gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer">
          <div>
            <div className="text-sm text-slate-700">{t('settings.showNonFiscalOrders')}</div>
            <div className="text-xs text-slate-400">{t('settings.showNonFiscalOrdersDesc')}</div>
          </div>
          {(() => {
            const enabled = config?.showNonFiscalOrders ?? false;
            return (
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => onConfigChange({ showNonFiscalOrders: !enabled })}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none ${enabled ? 'bg-brand-600' : 'bg-slate-200'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            );
          })()}
        </label>
      </div>
      </SettingsSection>

      {/* Check-in Display */}
      <SettingsSection searchQuery={settingsSearch} keywords={checkinDisplayKeywords}>
      <div className="panel p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-1">{tOr('settings.checkinDisplay', 'Check-in Display')}</h2>
        <p className="text-xs text-slate-400 mb-4">Control which elements are visible on the Check-in tab. Hide staff-only panels for customer-facing setups.</p>
        <div className="space-y-1">
          {[
            {
              key: 'checkinShowStatsBar' as const,
              label: tOr('settings.checkinStatsBar', 'Stats bar'),
              desc: tOr('settings.checkinStatsBarDesc', 'Total · Waiting · In Service · Completed counts'),
            },
            {
              key: 'checkinShowQueue' as const,
              label: tOr('settings.checkinActiveQueuePanel', 'Active queue panel'),
              desc: tOr('settings.checkinActiveQueuePanelDesc', 'Right-side list of waiting and in-service customers'),
            },
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
      </SettingsSection>

        </>
      )}

      {showSettingsSearchEmptyState && (
        <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-xs text-slate-500">
          {settingsSearchNoResults}
        </div>
      )}

      {/* Auto-save indicator */}
      <p className="text-center text-xs text-slate-400">{t('settings.autoSaveHint')}</p>
    </div>
    {pendingFiscalDailyReportConfirm && (
      <ConfirmActionDialog
        open
        tier="light"
        title={tOr('common.confirmTitle', 'Please confirm')}
        body={FISCAL_DAILY_REPORT_CONFIRM_BODY}
        confirmLabel={tOr('common.confirm', 'Confirm')}
        cancelLabel={tOr('common.cancel', 'Cancel')}
        danger
        busy={printingFiscalDailyReport}
        onConfirm={handleConfirmPrintFiscalDailyReportNow}
        onCancel={() => {
          if (!printingFiscalDailyReport) setPendingFiscalDailyReportConfirm(false);
        }}
      />
    )}
    </>
  );
}

function settingsSearchKeywords(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}

function SettingsSection({
  searchQuery,
  keywords,
  children,
}: {
  searchQuery: string;
  keywords: string;
  children: React.ReactNode;
}) {
  if (!matchesSettingSection(searchQuery, keywords)) return null;
  return <>{children}</>;
}
