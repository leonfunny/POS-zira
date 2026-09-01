import React, { useEffect, useMemo, useRef, useState } from 'react';

import { FABRIC_TAG_CONFIRM_THRESHOLD, FABRIC_TAG_LIMITS, type FabricTagTemplate } from '../../../shared/types';
import { totalTagsToPrint } from './fabric-tag-size';
import rlog from '../../utils/logger';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';

/**
 * Print a style's care labels, one quantity per size.
 *
 * Rows must come from an explicit size source. Catalogue siblings are not
 * accepted as a proxy because the current garment catalogue groups colours.
 */

export interface FabricTagVariant {
  id: string;
  name: string;
}

interface Props {
  template: FabricTagTemplate;
  styleName: string;
  variants: FabricTagVariant[];
  /** False while the fabric tag printer slot is disabled or incomplete. */
  ready: boolean;
  t: (key: string, fallback: string) => string;
  onStatus: (status: { type: 'success' | 'error' | 'printing'; message: string }) => void;
}

/** One print run should not be able to swallow a whole roll by a typo. */
const MAX_PER_SIZE = FABRIC_TAG_LIMITS.quantity;
export const MAX_FABRIC_TAGS_PER_RUN = FABRIC_TAG_LIMITS.quantity;
export { FABRIC_TAG_CONFIRM_THRESHOLD };

function clampQuantity(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_PER_SIZE);
}

export default function FabricTagPrintPanel({
  template, styleName, variants, ready, t, onStatus,
}: Props) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const [printing, setPrinting] = useState(false);
  const [confirmingLargeBatch, setConfirmingLargeBatch] = useState(false);
  // React state is applied on the next render. A physical print action needs a
  // synchronous latch too, otherwise two clicks in one event turn can enqueue
  // the same run twice before `printing` becomes true.
  const printRunInFlight = useRef(false);

  // Re-seed when the style changes. Quantities deliberately reset: carrying a
  // previous style's numbers over is how the wrong garment gets 200 tags.
  useEffect(() => {
    setSizes(Object.fromEntries(variants.map((variant) => [variant.id, ''])));
    setQuantities({});
    setConfirmingLargeBatch(false);
  }, [template.templateId, styleName, variants]);

  const total = useMemo(() => totalTagsToPrint(quantities), [quantities]);
  const batchTooLarge = total > MAX_FABRIC_TAGS_PER_RUN;
  const missingSize = useMemo(
    () => variants.some((variant) => (quantities[variant.id] ?? 0) > 0 && !sizes[variant.id]?.trim()),
    [variants, quantities, sizes],
  );

  const handlePrint = async (confirmed = false) => {
    if (!ready || printing || printRunInFlight.current || total === 0 || missingSize || batchTooLarge) return;
    if (!confirmed && total > FABRIC_TAG_CONFIRM_THRESHOLD) {
      setConfirmingLargeBatch(true);
      return;
    }
    printRunInFlight.current = true;
    setConfirmingLargeBatch(false);
    setPrinting(true);
    onStatus({ type: 'printing', message: t('fabricTag.printingRun', 'Printing fabric tags...') });

    let printed = 0;
    try {
      for (const variant of variants) {
        const quantity = clampQuantity(quantities[variant.id]);
        if (quantity === 0) continue;

        const result = await window.electronAPI.printFabricTag({
          brandName: template.brandName || '',
          logoDataUrl: template.logoDataUrl || undefined,
          size: sizes[variant.id]?.trim() || undefined,
          composition: template.composition || undefined,
          careSymbols: template.careSymbols?.length ? template.careSymbols : undefined,
          careText: template.careText || undefined,
          layout: template.layout,
          quantity,
        } as any);

        if (!result?.success) {
          // Stop at the first failure rather than working through the rest:
          // the usual cause is the printer, and the remaining sizes would fail
          // the same way while burning ribbon.
          onStatus({
            type: 'error',
            message: `${result?.error || t('fabricTag.printFailed', 'Print failed')} (${printed}/${total})`,
          });
          return;
        }
        printed += quantity;
      }
      onStatus({
        type: 'success',
        message: `${t('fabricTag.printedRun', 'Printed')}: ${printed} × ${styleName}`,
      });
    } catch (err: any) {
      rlog.error('[FabricTagPrintPanel] print run failed:', err);
      onStatus({
        type: 'error',
        message: `${err?.message || t('fabricTag.printFailed', 'Print failed')} (${printed}/${total})`,
      });
    } finally {
      printRunInFlight.current = false;
      setPrinting(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          {t('fabricTag.printRunTitle', 'Fabric care labels')}
        </h3>
        <span className="text-xs text-slate-500 truncate">{template.composition || ''}</span>
      </div>

      {variants.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3">
          <p className="text-sm font-semibold text-slate-700">
            {t('fabricTag.noSizesConfigured', 'Sizes are not configured for this care-label template yet.')}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {t('fabricTag.awaitingApprovedData', 'Add sizes after the approved production sheet is reviewed.')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {variants.map((variant) => (
            <div key={variant.id} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-sm text-slate-700">{variant.name}</span>
              <input
                type="text"
                value={sizes[variant.id] ?? ''}
                onChange={(e) => setSizes((prev) => ({ ...prev, [variant.id]: e.target.value }))}
                placeholder={t('fabricTag.sizePlaceholder', 'Size')}
                maxLength={10}
                className="h-11 w-20 px-2 border border-slate-300 rounded text-sm text-center outline-none focus:ring-2 focus:ring-brand-300"
              />
              <input
                type="number"
                value={quantities[variant.id] ?? ''}
                onChange={(e) => setQuantities((prev) => ({ ...prev, [variant.id]: clampQuantity(e.target.value) }))}
                min={0}
                max={MAX_PER_SIZE}
                placeholder="0"
                className="h-11 w-20 px-2 border border-slate-300 rounded text-sm text-right outline-none focus:ring-2 focus:ring-brand-300"
              />
            </div>
          ))}
        </div>
      )}

      {missingSize && (
        <p className="text-xs text-amber-600">
          {t('fabricTag.sizeRequired', 'Fill in the size for every row you are printing.')}
        </p>
      )}

      {total > FABRIC_TAG_CONFIRM_THRESHOLD && !batchTooLarge && (
        <p className="text-xs text-amber-600">
          {t('fabricTag.largeBatchWarning', 'This large print run requires confirmation.')}
        </p>
      )}

      {batchTooLarge && (
        <p className="text-xs text-red-600">
          {t('fabricTag.batchTooLarge', 'A single print run cannot exceed {count} labels.')
            .replace('{count}', String(MAX_FABRIC_TAGS_PER_RUN))}
        </p>
      )}

      <button
        onClick={() => void handlePrint()}
        disabled={!ready || printing || total === 0 || missingSize || batchTooLarge}
        className="w-full min-h-11 px-3 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white disabled:bg-slate-200 disabled:text-slate-400 transition-colors"
      >
        {printing
          ? t('fabricTag.printingRun', 'Printing fabric tags...')
          : `${t('fabricTag.printRun', 'Print fabric labels')}${total > 0 ? ` (${total})` : ''}`}
      </button>

      {!ready && (
        <p className="text-xs text-amber-600">
          {t('fabricTag.printerNotReady', 'Configure the fabric tag printer in Settings first.')}
        </p>
      )}

      <ConfirmActionDialog
        open={confirmingLargeBatch}
        tier="light"
        title={t('common.confirmTitle', 'Please confirm')}
        body={t('fabricTag.largeBatchConfirm', 'You are about to print {count} fabric labels. Continue?')
          .replace('{count}', String(total))}
        itemName={styleName}
        confirmLabel={t('common.confirm', 'Confirm')}
        cancelLabel={t('common.cancel', 'Cancel')}
        busy={printing}
        onConfirm={() => void handlePrint(true)}
        onCancel={() => setConfirmingLargeBatch(false)}
      />
    </div>
  );
}
