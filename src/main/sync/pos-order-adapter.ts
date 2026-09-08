/** Windows logger wrapper over the shared, browser-safe history adapter. */
import logger from '../logger';
import { adaptServerOrder as adaptSharedServerOrder } from '../../shared/pos-order-adapter';
export { toGrosze, toVatRate, normalizeRefundLinesJson, mergeRefundLineMetadataJson, normalizePaymentTendersJson, adaptServerOrderItem } from '../../shared/pos-order-adapter';

const _warnedFields = new Set<string>();

function warnOnce(field: string, sample: any): void {
  if (_warnedFields.has(field)) return;
  _warnedFields.add(field);
  logger.warn(
    `[PosOrderAdapter] Missing field "${field}" in server response. ` +
    `Order id=${sample.id}, status=${sample.status}. Sample keys: ` +
    JSON.stringify(Object.keys(sample))
  );
}

export function adaptServerOrder(s: any): any {
  return adaptSharedServerOrder(s, warnOnce);
}
