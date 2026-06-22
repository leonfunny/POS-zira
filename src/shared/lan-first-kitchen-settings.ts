import type { LanFirstKitchenSenderConfig, SalonPrinterMapping } from './types';

export const DEFAULT_LAN_FIRST_KITCHEN_PORT = 17892;
export const DEFAULT_LAN_FIRST_KITCHEN_TIMEOUT_MS = 6000;
export const MANUAL_TARGET_KEY = 'manual';

function hasPrinterTarget(printer: Pick<SalonPrinterMapping, 'windowsPrinterName' | 'address'>): boolean {
  return !!(printer.windowsPrinterName?.trim() || printer.address?.trim());
}

export function getReadyKitchenWifiPrinters(printers: SalonPrinterMapping[]): SalonPrinterMapping[] {
  return printers.filter((printer) =>
    String(printer.printerType || '').toUpperCase() === 'KITCHEN'
    && printer.isEnabled !== false
    && !!printer.agentIsOnline
    && !!printer.isOnline
    && !!printer.machineId?.trim()
    && hasPrinterTarget(printer),
  );
}

function parsePort(value: string | number | undefined, fallback = DEFAULT_LAN_FIRST_KITCHEN_PORT): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  return fallback;
}

export function resolveLanFirstKitchenTimeoutMs(value: unknown, fallback = DEFAULT_LAN_FIRST_KITCHEN_TIMEOUT_MS): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= fallback && parsed <= 30000) return parsed;
  return fallback;
}

export type BuildLanFirstKitchenSenderConfigResult =
  | {
      ok: true;
      targetKey: string;
      config: LanFirstKitchenSenderConfig;
    }
  | {
      ok: false;
      error: string;
    };

export function buildLanFirstKitchenSenderConfig(input: {
  current?: LanFirstKitchenSenderConfig | null;
  enabled: boolean;
  selectedPrinterId: string;
  host: string;
  port: string | number;
  timeoutMs?: number;
  printers: SalonPrinterMapping[];
}): BuildLanFirstKitchenSenderConfigResult {
  const host = String(input.host || '').trim();
  const timeoutMs = resolveLanFirstKitchenTimeoutMs(input.timeoutMs ?? input.current?.timeoutMs);
  const port = parsePort(input.port);
  const printer = input.printers.find((item) => item.id === input.selectedPrinterId);

  if (printer) {
    const machineId = String(printer.machineId || '').trim();
    if (!machineId) return { ok: false, error: 'Selected kitchen printer is missing machineId' };
    if (!host) return { ok: false, error: 'Enter the kitchen POS host or IP' };

    const targetKey = `${machineId}:${printer.id}`;
    const config: LanFirstKitchenSenderConfig = {
      enabled: input.enabled,
      timeoutMs,
      targets: {
        ...(input.current?.targets || {}),
        [targetKey]: { host, port, timeoutMs },
      },
    };
    if (input.current?.manualTarget) config.manualTarget = input.current.manualTarget;
    return { ok: true, targetKey, config };
  }

  // Manual host/IP path - no backend-registered kitchen printer required.
  if (!host) return { ok: false, error: 'Select a kitchen printer or enter a host/IP' };
  return {
    ok: true,
    targetKey: MANUAL_TARGET_KEY,
    config: {
      enabled: input.enabled,
      timeoutMs,
      targets: { ...(input.current?.targets || {}) },
      manualTarget: { host, port },
    },
  };
}

export interface LanKitchenSavePlanInput {
  receiveEnabled: boolean;
  receivePort: string | number;
  senderEnabled: boolean;
  selectedPrinterId: string;
  host: string;
  port: string | number;
  timeoutMs?: number;
  printers: SalonPrinterMapping[];
  receiverPairingCode: string;
  senderPairingCode: string;
  currentSender?: LanFirstKitchenSenderConfig | null;
}

export interface LanKitchenSavePlan {
  receiverPatch: { enabled: boolean; port: number; auth: { allowUnauthenticated: false } };
  senderPatch: LanFirstKitchenSenderConfig;
  receiverCode: string | null;
  senderCode: string | null;
  warnings: string[];
}

// Pure planner for the Settings "Save Wi-Fi setup" action. Pairing codes and
// the receiver config are ALWAYS produced so the renderer can persist them
// independently; a sender target that cannot be built only adds a warning and
// never discards the codes or the receiver setup.
export function planLanKitchenSave(input: LanKitchenSavePlanInput): LanKitchenSavePlan {
  const warnings: string[] = [];
  const receiverPatch = {
    enabled: input.receiveEnabled,
    port: parsePort(input.receivePort),
    auth: { allowUnauthenticated: false as const },
  };

  let senderPatch: LanFirstKitchenSenderConfig = {
    ...(input.currentSender || {}),
    enabled: input.senderEnabled,
    timeoutMs: resolveLanFirstKitchenTimeoutMs(input.timeoutMs ?? input.currentSender?.timeoutMs),
  };

  if (input.senderEnabled) {
    const built = buildLanFirstKitchenSenderConfig({
      current: input.currentSender,
      enabled: true,
      selectedPrinterId: input.selectedPrinterId,
      host: input.host,
      port: input.port,
      timeoutMs: input.timeoutMs ?? input.currentSender?.timeoutMs,
      printers: input.printers,
    });
    if (built.ok) {
      senderPatch = built.config;
    } else {
      warnings.push(built.error);
    }
  }

  return {
    receiverPatch,
    senderPatch,
    receiverCode: input.receiverPairingCode.trim() || null,
    senderCode: input.senderPairingCode.trim() || null,
    warnings,
  };
}
