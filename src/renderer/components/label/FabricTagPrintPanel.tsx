import React, { useEffect, useMemo, useState } from 'react';

import type { FabricTagTemplate } from '../../../shared/types';
import { deriveSizeFromVariantName, totalTagsToPrint } from './fabric-tag-size';
import rlog from '../../utils/logger';

/**
 * Print a style's care labels, one quantity per size.
 *
 * Sizes are the style's variant rows, so the list is whatever the catalogue
 * already holds -- nothing here invents a size. The size text is editable
 * because it is derived from the variant name and the derivation can be wrong;
 * showing it keeps a bad guess visible before it reaches cloth.
 */

export interface FabricTagVariant {
  id: string;
  name: string;
}

interface Props {
  template: FabricTagTemplate;
  styleName: string;
  variants: FabricTagVariant[];
  /** False while the fabric tag printer is not configured or not connected. */
  ready: boolean;
  t: (key: string, fallback: string) => string;
  onStatus: (status: { type: 'success' | 'error' | 'printing'; message: string }) => void;
}

/** One print run should not be able to swallow a whole roll by a typo. */
const MAX_PER_SIZE = 999;

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

  // Re-seed when the style changes. Quantities deliberately reset: carrying a
  // previous style's numbers over is how the wrong garment gets 200 tags.
  useEffect(() => {
    const seeded: Record<string, string> = {};
    for (const variant of variants) {
      seeded[variant.id] = deriveSizeFromVariantName(variant.name, styleName);
    }
    setSizes(seeded);
    setQuantities({});
  }, [template.templateId, styleName, variants]);

  const total = useMemo(() => totalTagsToPrint(quantities), [quantities]);
  const missingSize = useMemo(
    () => variants.some((variant) => (quantities[variant.id] ?? 0) > 0 && !sizes[variant.id]?.trim()),
    [variants, quantities, sizes],
  );

  const handlePrint = async () => {
    if (!ready || printing || total === 0 || missingSize) return;
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
      onStatus({ type: 'error', message: err?.message || t('fabricTag.printFailed', 'Print failed') });
    } finally {
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
        <p className="text-xs text-slate-500">
          {t('fabricTag.noVariants', 'This style has no size variants to print.')}
        </p>
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
                className="w-20 px-2 py-1 border border-slate-300 rounded text-sm text-center outline-none focus:ring-2 focus:ring-brand-300"
              />
              <input
                type="number"
                value={quantities[variant.id] ?? ''}
                onChange={(e) => setQuantities((prev) => ({ ...prev, [variant.id]: clampQuantity(e.target.value) }))}
                min={0}
                max={MAX_PER_SIZE}
                placeholder="0"
                className="w-20 px-2 py-1 border border-slate-300 rounded text-sm text-right outline-none focus:ring-2 focus:ring-brand-300"
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

      <button
        onClick={handlePrint}
        disabled={!ready || printing || total === 0 || missingSize}
        className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white disabled:bg-slate-200 disabled:text-slate-400 transition-colors"
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
    </div>
  );
}
