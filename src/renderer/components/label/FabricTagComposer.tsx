import React, { useMemo, useRef, useState } from 'react';
import {
  CARE_SYMBOLS,
  FABRIC_TAG_CONFIRM_THRESHOLD,
  FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS,
  FABRIC_TAG_LIMITS,
  FABRIC_TAG_RASTER_MIME_TYPES,
  type CareSymbol,
  type FabricTagData,
  type FabricTagRasterMime,
} from '../../../shared/types';
import { careSymbolSvg } from '../../../shared/care-symbols';
import { readRasterImageDimensions } from '../../../shared/fabric-tag-image';
import rlog from '../../utils/logger';
import ConfirmActionDialog from '../pos/ConfirmActionDialog';

/**
 * Compose and print a garment care tag (mác vải).
 *
 * Lives next to the FABRIC_TAG printer settings rather than in the Label tab:
 * the Label tab prints barcodes straight off the product catalogue, while a
 * care tag is authored once per style and reprinted in runs.
 *
 * The picker renders the exact same vector art the printer rasterises, so what
 * is selected here is literally what comes out of the machine.
 */

/** Grouped the way a garment tag reads top to bottom. */
const SYMBOL_GROUPS: { key: string; symbols: CareSymbol[] }[] = [
  { key: 'wash', symbols: ['WASH_30', 'WASH_40', 'WASH_60', 'WASH_HAND', 'WASH_NO'] },
  { key: 'bleach', symbols: ['BLEACH_OK', 'BLEACH_NO'] },
  { key: 'dry', symbols: ['DRY_ANY', 'TUMBLE_LOW', 'TUMBLE_NORMAL', 'TUMBLE_NO', 'DRY_LINE', 'DRY_FLAT'] },
  { key: 'iron', symbols: ['IRON_LOW', 'IRON_MEDIUM', 'IRON_HIGH', 'IRON_NO'] },
  { key: 'professional', symbols: ['DRYCLEAN_ANY', 'DRYCLEAN_P', 'DRYCLEAN_F', 'DRYCLEAN_NO'] },
];

interface FabricTagComposerProps {
  t: (key: string) => string;
  /** Tag media size in mm, used only to scale the on-screen preview. */
  labelWidthMm: number;
  labelHeightMm: number;
  /** False while the FABRIC_TAG slot is disabled or has no printer selected. */
  ready: boolean;
}

type Status = { type: 'idle' | 'working' | 'ok' | 'error'; message: string };

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none';
const labelClass = 'block text-xs font-medium text-slate-600 mb-1';

export default function FabricTagComposer({ t, labelWidthMm, labelHeightMm, ready }: FabricTagComposerProps) {
  const [brandName, setBrandName] = useState('');
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [size, setSize] = useState('');
  const [composition, setComposition] = useState('');
  const [careSymbols, setCareSymbols] = useState<CareSymbol[]>([]);
  const [careText, setCareText] = useState('');
  const [barcode, setBarcode] = useState('');
  const [useQrCode, setUseQrCode] = useState(false);
  const [price, setPrice] = useState('');
  const [layout, setLayout] = useState<NonNullable<FabricTagData['layout']>>('default');
  const [quantity, setQuantity] = useState(1);
  const [status, setStatus] = useState<Status>({ type: 'idle', message: '' });
  const [confirmingLargeBatch, setConfirmingLargeBatch] = useState(false);
  const printInFlight = useRef(false);

  // Preview keeps the media aspect ratio so a 40x60 tag does not look square.
  const previewWidth = 160;
  const previewHeight = Math.round(previewWidth * (labelHeightMm / Math.max(1, labelWidthMm)));

  const priceGrosze = useMemo(() => {
    const parsed = Number.parseFloat(price.replace(',', '.'));
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : undefined;
  }, [price]);

  const canPrint = ready && (brandName.trim().length > 0 || !!logoDataUrl) && status.type !== 'working';

  const toggleSymbol = (symbol: CareSymbol) => {
    setCareSymbols((current) => {
      if (current.includes(symbol)) return current.filter((selected) => selected !== symbol);
      const exclusiveGroup = FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS.find(
        (group) => group.includes(symbol),
      );
      const compatible = exclusiveGroup
        ? current.filter((selected) => !exclusiveGroup.includes(selected))
        : current;
      // Keep canonical ISO reading order regardless of click order while
      // making mutually-exclusive families behave like radio groups.
      return [...compatible, symbol]
        .sort((a, b) => CARE_SYMBOLS.indexOf(a) - CARE_SYMBOLS.indexOf(b));
    });
  };

  const handleLogoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const mimeType = file.type.toLowerCase();
    if (!(FABRIC_TAG_RASTER_MIME_TYPES as readonly string[]).includes(mimeType)) {
      setStatus({ type: 'error', message: t('fabricTag.logoReadFailed') });
      return;
    }
    if (file.size > FABRIC_TAG_LIMITS.logoBytes) {
      setStatus({ type: 'error', message: t('fabricTag.logoTooLarge') });
      return;
    }
    try {
      // Inspect bounded header bytes before assigning src; this keeps a tiny
      // compressed image with a huge declared canvas away from the renderer's
      // image decoder and live preview.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { width, height } = readRasterImageDimensions(bytes, mimeType as FabricTagRasterMime);
      if (
        width < 1
        || height < 1
        || width > FABRIC_TAG_LIMITS.logoMaxDimension
        || height > FABRIC_TAG_LIMITS.logoMaxDimension
        || width * height > FABRIC_TAG_LIMITS.logoMaxPixels
      ) {
        throw new Error('Logo dimensions exceed the fabric-tag limit');
      }

      const reader = new FileReader();
      reader.onload = () => {
        setLogoDataUrl(typeof reader.result === 'string' ? reader.result : null);
        setStatus({ type: 'idle', message: '' });
      };
      reader.onerror = () => setStatus({ type: 'error', message: t('fabricTag.logoReadFailed') });
      reader.readAsDataURL(file);
    } catch (error) {
      rlog.warn('[FabricTagComposer] Rejected logo before preview:', error);
      setStatus({ type: 'error', message: t('fabricTag.logoReadFailed') });
    }
  };

  const handlePrint = async (confirmed = false) => {
    if (!canPrint || printInFlight.current) return;
    if (!confirmed && quantity > FABRIC_TAG_CONFIRM_THRESHOLD) {
      setConfirmingLargeBatch(true);
      return;
    }
    printInFlight.current = true;
    setConfirmingLargeBatch(false);
    setStatus({ type: 'working', message: t('fabricTag.printing') });

    const payload: FabricTagData = {
      brandName: brandName.trim(),
      logoDataUrl: logoDataUrl || undefined,
      size: size.trim() || undefined,
      composition: composition.trim() || undefined,
      careSymbols: careSymbols.length ? careSymbols : undefined,
      careText: careText.trim() || undefined,
      barcode: barcode.trim() || undefined,
      useQrCode: useQrCode && !!barcode.trim(),
      priceGrosze,
      layout,
      quantity,
    };

    try {
      const result = await window.electronAPI.printFabricTag(payload);
      if (result?.success) {
        setStatus({ type: 'ok', message: t('fabricTag.printed') });
      } else {
        setStatus({ type: 'error', message: result?.error || t('fabricTag.printFailed') });
      }
    } catch (err: any) {
      rlog.error('[FabricTagComposer] printFabricTag failed:', err);
      setStatus({ type: 'error', message: err?.message || t('fabricTag.printFailed') });
    } finally {
      printInFlight.current = false;
    }
  };

  const statusClass = status.type === 'error'
    ? 'text-red-600'
    : status.type === 'ok' ? 'text-emerald-600' : 'text-slate-500';

  // The preview reorders exactly the way fabric-tag-renderer does, so what is
  // on screen matches what the print head burns.
  const previewParts = {
    size: size ? <span className="text-[15px] font-bold leading-none">{size}</span> : null,
    composition: composition ? <span className="text-[8px] font-bold text-center leading-tight">{composition}</span> : null,
    symbols: careSymbols.length ? (
      <span
        className="flex flex-wrap justify-center gap-[2px]"
        dangerouslySetInnerHTML={{ __html: careSymbols.map((s) => careSymbolSvg(s, 16)).join('') }}
      />
    ) : null,
    careText: careText ? <span className="text-[7px] text-center leading-tight">{careText}</span> : null,
    price: priceGrosze !== undefined ? <span className="text-[9px] font-bold">{(priceGrosze / 100).toFixed(2)}</span> : null,
    barcode: barcode ? <span className="text-[7px] font-mono tracking-tighter">{barcode}</span> : null,
  };
  const previewKeys: (keyof typeof previewParts)[] = layout === 'care-first'
    ? ['symbols', 'composition', 'size', 'careText', 'price', 'barcode']
    : ['size', 'composition', 'symbols', 'careText', 'price', 'barcode'];
  const previewOrder = previewKeys
    .map((key) => ({ key, node: previewParts[key] }))
    .filter((part) => part.node !== null);

  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
      <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">{t('fabricTag.title')}</h4>

      <div className="flex gap-3">
        {/* Live preview of the graphic block, drawn from the same art the printer gets. */}
        <div
          className="shrink-0 border border-slate-300 rounded bg-white text-black flex flex-col items-center justify-center gap-1 px-2 py-2 overflow-hidden"
          style={{ width: previewWidth, height: previewHeight }}
        >
          {logoDataUrl
            ? <img src={logoDataUrl} alt="" className="max-w-full max-h-[30%] object-contain" />
            : <span className="text-[13px] font-bold uppercase tracking-wide text-center leading-tight">{brandName || '—'}</span>}
          {previewOrder.map((part) => <React.Fragment key={part.key}>{part.node}</React.Fragment>)}
        </div>

        <div className="flex-1 min-w-0 grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label className={labelClass}>{t('fabricTag.brand')}</label>
            <input type="text" value={brandName} onChange={(e) => setBrandName(e.target.value)} maxLength={40} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>{t('fabricTag.size')}</label>
            <input type="text" value={size} onChange={(e) => setSize(e.target.value)} maxLength={10} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>{t('fabricTag.price')}</label>
            <input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className={inputClass} />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>{t('fabricTag.composition')}</label>
            <input type="text" value={composition} onChange={(e) => setComposition(e.target.value)} maxLength={120} className={inputClass} />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>{t('fabricTag.layout')}</label>
            <select
              value={layout}
              onChange={(e) => setLayout(e.target.value as NonNullable<FabricTagData['layout']>)}
              className={inputClass}
            >
              <option value="default">{t('fabricTag.layoutDefault')}</option>
              <option value="care-first">{t('fabricTag.layoutCareFirst')}</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <label className={labelClass}>{t('fabricTag.care')}</label>
        <div className="space-y-1">
          {SYMBOL_GROUPS.map((group) => (
            <div key={group.key} className="flex flex-wrap gap-1">
              {group.symbols.map((symbol) => {
                const selected = careSymbols.includes(symbol);
                return (
                  <button
                    key={symbol}
                    type="button"
                    title={symbol}
                    onClick={() => toggleSymbol(symbol)}
                    aria-pressed={selected}
                    className={`w-9 h-9 flex items-center justify-center rounded border transition-colors cursor-pointer ${
                      selected
                        ? 'border-brand-400 bg-brand-50 text-brand-700'
                        : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-600'
                    }`}
                    dangerouslySetInnerHTML={{ __html: careSymbolSvg(symbol, 24) }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className={labelClass}>{t('fabricTag.careText')}</label>
          <input type="text" value={careText} onChange={(e) => setCareText(e.target.value)} maxLength={80} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>{t('fabricTag.barcode')}</label>
          <input type="text" value={barcode} onChange={(e) => setBarcode(e.target.value)} maxLength={48} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>{t('fabricTag.quantity')}</label>
          <input
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)))}
            min={1}
            max={999}
            className={inputClass}
          />
        </div>
        <label className="col-span-2 flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" checked={useQrCode} onChange={(e) => setUseQrCode(e.target.checked)} disabled={!barcode.trim()} />
          {t('fabricTag.useQr')}
        </label>
      </div>

      <div className="flex items-center gap-2">
        <label className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer">
          {t('fabricTag.logo')}
          <input
            type="file"
            accept={FABRIC_TAG_RASTER_MIME_TYPES.join(',')}
            onChange={handleLogoChange}
            className="hidden"
          />
        </label>
        {logoDataUrl && (
          <button
            type="button"
            onClick={() => setLogoDataUrl(null)}
            className="px-3 py-2 rounded-lg text-sm text-slate-500 hover:bg-slate-50 transition-colors cursor-pointer"
          >
            {t('fabricTag.removeLogo')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handlePrint()}
          disabled={!canPrint}
          className={`ml-auto px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            canPrint ? 'bg-brand-50 text-brand-700 hover:bg-brand-100 cursor-pointer' : 'bg-slate-100 text-slate-400 cursor-not-allowed'
          }`}
        >
          {status.type === 'working' ? t('fabricTag.printing') : t('fabricTag.print')}
        </button>
      </div>

      {status.message && <p className={`text-xs ${statusClass}`}>{status.message}</p>}
      {quantity > FABRIC_TAG_CONFIRM_THRESHOLD && (
        <p className="text-xs text-amber-600">{t('fabricTag.largeBatchWarning')}</p>
      )}
      {!ready && <p className="text-xs text-amber-700">{t('fabricTag.notReady')}</p>}

      <ConfirmActionDialog
        open={confirmingLargeBatch}
        tier="light"
        title={t('common.confirmTitle')}
        body={t('fabricTag.largeBatchConfirm').replace('{count}', String(quantity))}
        itemName={brandName.trim() || t('fabricTag.title')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        busy={status.type === 'working'}
        onConfirm={() => void handlePrint(true)}
        onCancel={() => setConfirmingLargeBatch(false)}
      />
    </div>
  );
}
