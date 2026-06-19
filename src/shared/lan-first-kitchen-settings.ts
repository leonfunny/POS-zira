import type { LanFirstKitchenSenderConfig, SalonPrinterMapping } from './types';

export const DEFAULT_LAN_FIRST_KITCHEN_PORT = 17892;
export const DEFAULT_LAN_FIRST_KITCHEN_TIMEOUT_MS = 2000;

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

function parseTimeout(value: unknown, fallback = DEFAULT_LAN_FIRST_KITCHEN_TIMEOUT_MS): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 500 && parsed <= 30000) return parsed;
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
  const printer = input.printers.find((item) => item.id === input.selectedPrinterId);
  if (!printer) return { ok: false, error: 'Select a kitchen printer' };

  const machineId = String(printer.machineId || '').trim();
  if (!machineId) return { ok: false, error: 'Selected kitchen printer is missing machineId' };

  const host = String(input.host || '').trim();
  if (!host) return { ok: false, error: 'Enter the kitchen POS host or IP' };

  const timeoutMs = parseTimeout(input.timeoutMs ?? input.current?.timeoutMs);
  const targetKey = `${machineId}:${printer.id}`;
  const target = {
    host,
    port: parsePort(input.port),
    timeoutMs,
  };

  return {
    ok: true,
    targetKey,
    config: {
      enabled: input.enabled,
      timeoutMs,
      targets: {
        ...(input.current?.targets || {}),
        [targetKey]: target,
      },
    },
  };
}
