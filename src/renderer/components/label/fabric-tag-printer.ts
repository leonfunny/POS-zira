import {
  ALLOWED_PROTOCOLS_BY_TYPE,
  PrinterType,
  type PrinterConfig,
} from '../../../shared/types';

/**
 * A saved FABRIC_TAG slot is usable only when it is enabled, points at an
 * actual Windows queue, and uses a protocol accepted by that slot.
 */
export function isFabricTagPrinterReady(config: PrinterConfig | null | undefined): boolean {
  return !!config?.enabled
    && !!config.windowsPrinter?.trim()
    && ALLOWED_PROTOCOLS_BY_TYPE[PrinterType.FABRIC_TAG].includes(config.protocol);
}

export function supportsLabelMediaCalibration(
  config: PrinterConfig | null | undefined,
  printerType?: PrinterType,
): boolean {
  const mediaSensor = config?.mediaSensor ?? (printerType === PrinterType.FABRIC_TAG ? 'none' : 'gap');
  return (config?.protocol === 'ZEBRA' || config?.protocol === 'TSPL')
    && mediaSensor !== 'none';
}
