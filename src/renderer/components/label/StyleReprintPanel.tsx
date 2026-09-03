/**
 * Reprinting the labels of one style that is already in the catalogue.
 *
 * The print order sheet makes a style; this prints it again — a bag label that
 * tore, a bundle re-tagged, ten more of the size that sold. The operator picks
 * the style on the left, types a number next to the colours and sizes that need
 * printing, and the run goes out through the same plan builder and runner the
 * order sheet uses. Nothing here formats a label itself: a second renderer that
 * agrees today drifts by next month, and the drift ships on a garment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Printer, RefreshCw, Square } from 'lucide-react';
import {
  LabelPrintOrder,
  SIZE_SUGGESTIONS,
  buildPrintPlan,
} from '../../../shared/label-print-order';
import {
  SelectionInput,
  SelectionProblem,
  buildSelectionOrder,
  selectionProblems,
  selectionQuantity,
  selectionTotals,
} from '../../../shared/product-print-selection';
import type { FabricTagTemplate } from '../../../shared/types';
import { PrintProgress, runPrintPlan } from './print-order-runner';
import rlog from '../../utils/logger';

/** One catalogue row of the style, as the label tab holds it. */
export interface StyleVariant {
  id: string;
  name: string;
  sku?: string | null;
  color_name?: string | null;
  size_name?: string | null;
}

interface Props {
  language: string;
  /** Catalogue template the rows belong to; the care content is keyed by it. */
  templateId: string;
  styleName: string;
  styleCode: string;
  variants: readonly StyleVariant[];
  onPrintingChange?: (printing: boolean) => void;
}

interface Copy {
  variants: string;
  color: string;
  size: string;
  quantity: string;
  lanes: string;
  stickers: string;
  fabricTags: string;
  noTagContent: string;
  totals: (stickers: number, fabricTags: number) => string;
  print: (labels: number) => string;
  confirm: (labels: number) => string;
  printing: string;
  stop: string;
  stopping: string;
  done: (labels: number) => string;
  stopped: (done: number, total: number) => string;
  failed: (reason: string) => string;
  clear: string;
  problem: Record<SelectionProblem, string>;
}

const COPY: Record<string, Copy> = {
  vi: {
    variants: 'Màu và size đã có',
    color: 'Màu',
    size: 'Size',
    quantity: 'Số lượng',
    lanes: 'In gì',
    stickers: 'Tem đóng gói',
    fabricTags: 'Tem vải',
    noTagContent:
      'Mẫu này chưa có nội dung tem vải trên máy — chỉ in được tem đóng gói. Tạo lại từ tab Đơn in thì sẽ có.',
    totals: (stickers, fabricTags) => `${stickers} tem đóng gói · ${fabricTags} tem vải`,
    print: (labels) => (labels > 0 ? `In ${labels} tem` : 'In'),
    confirm: (labels) => `Bấm lần nữa để in ${labels} tem`,
    printing: 'Đang in…',
    stop: 'Dừng',
    stopping: 'Đang dừng…',
    done: (labels) => `Đã in ${labels} tem`,
    stopped: (done, total) => `Đã dừng — in ${done}/${total} tem`,
    failed: (reason) => `Máy in báo lỗi: ${reason}`,
    clear: 'Xoá số đã gõ',
    problem: {
      NOTHING_SELECTED: 'Chưa gõ số lượng cho dòng nào',
      NO_LANE: 'Chưa chọn in tem đóng gói hay tem vải',
      TOO_MANY: 'Quá nhiều tem cho một lần in',
    },
  },
  pl: {
    variants: 'Dostępne kolory i rozmiary',
    color: 'Kolor',
    size: 'Rozmiar',
    quantity: 'Ilość',
    lanes: 'Co drukować',
    stickers: 'Etykiety na worek',
    fabricTags: 'Metki',
    noTagContent:
      'Ten model nie ma zapisanej treści metki — można wydrukować tylko etykietę na worek. Zlecenie druku zapisze treść.',
    totals: (stickers, fabricTags) => `${stickers} etykiet · ${fabricTags} metek`,
    print: (labels) => (labels > 0 ? `Drukuj ${labels} szt.` : 'Drukuj'),
    confirm: (labels) => `Naciśnij ponownie, aby wydrukować ${labels} szt.`,
    printing: 'Drukowanie…',
    stop: 'Stop',
    stopping: 'Zatrzymywanie…',
    done: (labels) => `Wydrukowano ${labels} szt.`,
    stopped: (done, total) => `Zatrzymano — ${done}/${total} szt.`,
    failed: (reason) => `Błąd drukarki: ${reason}`,
    clear: 'Wyczyść ilości',
    problem: {
      NOTHING_SELECTED: 'Żaden wiersz nie ma ilości',
      NO_LANE: 'Nie wybrano etykiet ani metek',
      TOO_MANY: 'Za dużo sztuk na jeden druk',
    },
  },
  en: {
    variants: 'Colours and sizes on file',
    color: 'Colour',
    size: 'Size',
    quantity: 'Quantity',
    lanes: 'What to print',
    stickers: 'Bag labels',
    fabricTags: 'Fabric tags',
    noTagContent:
      'This style has no care content on the machine — only bag labels can print. Filing it from the print order saves the content.',
    totals: (stickers, fabricTags) => `${stickers} bag labels · ${fabricTags} fabric tags`,
    print: (labels) => (labels > 0 ? `Print ${labels} labels` : 'Print'),
    confirm: (labels) => `Press again to print ${labels} labels`,
    printing: 'Printing…',
    stop: 'Stop',
    stopping: 'Stopping…',
    done: (labels) => `Printed ${labels} labels`,
    stopped: (done, total) => `Stopped — ${done}/${total} printed`,
    failed: (reason) => `Printer error: ${reason}`,
    clear: 'Clear quantities',
    problem: {
      NOTHING_SELECTED: 'No row has a quantity',
      NO_LANE: 'Neither bag labels nor fabric tags are selected',
      TOO_MANY: 'Too many labels for one run',
    },
  },
};

/**
 * Past this many labels the button asks a second time.
 *
 * The quantities are typed by hand beside a printer that obeys them, and a
 * reprint is normally a handful. A run in the hundreds is the order sheet's
 * job; here it is more likely a stray keystroke.
 */
const CONFIRM_THRESHOLD = 50;

const INPUT =
  'h-10 w-20 rounded-md border border-slate-200 text-center text-base font-extrabold outline-none focus:ring-2 focus:ring-emerald-200';

/** Sizes in the order the shop says them, not the order the alphabet does. */
function sizeRank(label: string): number {
  const index = SIZE_SUGGESTIONS.indexOf(label.trim().toUpperCase() as never);
  return index === -1 ? SIZE_SUGGESTIONS.length : index;
}

export function sortStyleVariants(variants: readonly StyleVariant[]): StyleVariant[] {
  return [...variants].sort((a, b) => {
    const colorA = (a.color_name || '').trim();
    const colorB = (b.color_name || '').trim();
    if (colorA !== colorB) return colorA.localeCompare(colorB, 'pl');
    const sizeA = (a.size_name || '').trim();
    const sizeB = (b.size_name || '').trim();
    const rank = sizeRank(sizeA) - sizeRank(sizeB);
    if (rank !== 0) return rank;
    return sizeA.localeCompare(sizeB, 'pl');
  });
}

type Status =
  | { type: 'idle' }
  | { type: 'printing'; message: string }
  | { type: 'success'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string };

export default function StyleReprintPanel({
  language,
  templateId,
  styleName,
  styleCode,
  variants,
  onPrintingChange,
}: Props) {
  const copy = COPY[language] || COPY.vi;
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [printStickers, setPrintStickers] = useState(true);
  const [printFabricTags, setPrintFabricTags] = useState(true);
  const [tag, setTag] = useState<FabricTagTemplate | null>(null);
  const [tagLoaded, setTagLoaded] = useState(false);
  const [status, setStatus] = useState<Status>({ type: 'idle' });
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  const rows = useMemo(() => sortStyleVariants(variants), [variants]);

  // A style change must not carry the previous one's numbers: the boxes are the
  // only record of what is about to come out of the printer.
  useEffect(() => {
    setQuantities({});
    setStatus({ type: 'idle' });
    setConfirming(false);
  }, [templateId]);

  useEffect(() => {
    let cancelled = false;
    setTag(null);
    setTagLoaded(false);
    const bridge = (window as any).electronAPI?.pos?.fabricTagTemplates;
    if (!bridge?.get || !templateId) {
      setTagLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    // Wrapped rather than chained directly: an older preload — or a harness
    // standing in for one — returns undefined here, and calling `.then` on that
    // throws inside a mount effect, which takes the whole tab down instead of
    // costing one fabric tag.
    Promise.resolve()
      .then(() => bridge.get(templateId))
      .then((row: FabricTagTemplate | null | undefined) => {
        if (cancelled) return;
        setTag(row ?? null);
        setTagLoaded(true);
      })
      .catch((err: unknown) => {
        rlog.error('[StyleReprintPanel] Failed to read fabric tag content:', err);
        if (cancelled) return;
        setTag(null);
        setTagLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const hasTagContent = !!tag;
  // Without saved care content there is nothing to put on a fabric tag, so the
  // lane is switched off rather than printing a blank one.
  const fabricLaneOn = printFabricTags && hasTagContent;

  const selection: SelectionInput = useMemo(
    () => ({
      styleName,
      styleCode,
      customerName: tag?.brandName ?? '',
      careSymbols: tag?.careSymbols ?? [],
      careText: tag?.careText ?? '',
      composition: tag?.composition ?? '',
      // The catalogue row spells these `color_name`/`size_name`; the selection
      // speaks the order sheet's language. Handing the rows over untranslated
      // prints a bag label with no colour on it.
      variants: rows.map((variant) => ({
        id: variant.id,
        colorName: variant.color_name ?? null,
        sizeName: variant.size_name ?? null,
      })),
      quantities,
      printStickers,
      printFabricTags: fabricLaneOn,
    }),
    [fabricLaneOn, printStickers, quantities, rows, styleCode, styleName, tag],
  );

  const totals = selectionTotals(selection);
  const problems = selectionProblems(selection);
  const canPrint = problems.length === 0 && !running;

  useEffect(() => {
    // A number typed after the confirm prompt changes what would print, so the
    // second press must mean the new total, not the one already asked about.
    setConfirming(false);
  }, [totals.total]);

  const setQuantity = (variantId: string, raw: string) => {
    const next = selectionQuantity(raw);
    setQuantities((current) => {
      if (next <= 0) {
        if (!(variantId in current)) return current;
        const { [variantId]: _dropped, ...rest } = current;
        return rest;
      }
      return { ...current, [variantId]: next };
    });
  };

  const report = useCallback(
    (printing: boolean) => {
      onPrintingChange?.(printing);
    },
    [onPrintingChange],
  );

  const run = async (order: LabelPrintOrder) => {
    const api = (window as any).electronAPI;
    if (!api?.printPackagingSticker || !api?.printFabricTag) {
      setStatus({ type: 'error', message: copy.failed('printer bridge missing') });
      return;
    }
    const plan = buildPrintPlan(order, { composition: tag?.composition ?? '' });
    stopRef.current = false;
    setStopping(false);
    setRunning(true);
    report(true);
    try {
      const result = await runPrintPlan(
        plan,
        {
          customerName: order.customerName,
          styleName: order.styleName,
          styleCode: order.styleCode,
        },
        {
          printSticker: (request) => api.printPackagingSticker(request),
          printFabricTag: (request) => api.printFabricTag(request),
        },
        {
          onProgress: (progress: PrintProgress) => {
            if (progress.type !== 'printing') return;
            setStatus({
              type: 'printing',
              message: `${copy.printing} ${progress.printedCopies}/${progress.totalCopies}`,
            });
          },
          shouldStop: () => stopRef.current,
        },
      );
      if (result.type === 'success') {
        setStatus({ type: 'success', message: copy.done(result.printedCopies) });
        // The numbers are cleared only on a clean finish: after a stop or a jam
        // the operator needs to see what was asked for to work out what is left.
        setQuantities({});
        return;
      }
      if (result.type === 'stopped') {
        setStatus({
          type: 'warning',
          message: copy.stopped(result.printedCopies, totals.total),
        });
        return;
      }
      setStatus({ type: 'error', message: copy.failed(result.message || '?') });
    } catch (err) {
      setStatus({
        type: 'error',
        message: copy.failed(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setRunning(false);
      setStopping(false);
      stopRef.current = false;
      report(false);
    }
  };

  const handlePrint = () => {
    if (!canPrint) return;
    if (totals.total > CONFIRM_THRESHOLD && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void run(buildSelectionOrder(selection));
  };

  const handleStop = () => {
    if (!running) return;
    stopRef.current = true;
    setStopping(true);
  };

  const statusText =
    status.type === 'idle'
      ? problems.length > 0
        ? copy.problem[problems[0]]
        : copy.totals(totals.stickers, totals.fabricTags)
      : status.message;

  return (
    <div className="space-y-3" data-testid="style-reprint">
      <div
        className={`inline-flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm font-bold ${
          status.type === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : status.type === 'printing'
              ? 'border-sky-200 bg-sky-50 text-sky-800'
              : status.type === 'warning' || status.type === 'error'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-slate-200 bg-slate-50 text-slate-700'
        }`}
        data-testid="reprint-status"
      >
        {status.type === 'success' ? (
          <CheckCircle2 size={17} />
        ) : status.type === 'printing' ? (
          <RefreshCw size={17} className="animate-spin" />
        ) : status.type === 'warning' || status.type === 'error' ? (
          <AlertTriangle size={17} />
        ) : (
          <Printer size={17} />
        )}
        <span>{statusText}</span>
      </div>

      {tagLoaded && !hasTagContent && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800"
          data-testid="reprint-no-tag"
        >
          {copy.noTagContent}
        </div>
      )}

      <section className="space-y-2">
        <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">
          {copy.lanes}
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700">
            <input
              type="checkbox"
              checked={printStickers}
              onChange={(e) => setPrintStickers(e.target.checked)}
              data-testid="lane-stickers"
            />
            {copy.stickers}
          </label>
          <label
            className={`inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-bold ${
              hasTagContent ? 'text-slate-700' : 'text-slate-400'
            }`}
          >
            <input
              type="checkbox"
              checked={fabricLaneOn}
              disabled={!hasTagContent}
              onChange={(e) => setPrintFabricTags(e.target.checked)}
              data-testid="lane-fabric"
            />
            {copy.fabricTags}
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">
            {copy.variants}
          </div>
          {totals.total > 0 && !running && (
            <button
              type="button"
              onClick={() => setQuantities({})}
              className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50"
            >
              {copy.clear}
            </button>
          )}
        </div>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">{copy.color}</th>
                <th className="px-3 py-2 text-left">{copy.size}</th>
                <th className="px-3 py-2 text-right">{copy.quantity}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((variant) => (
                <tr key={variant.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-bold text-slate-800">
                    {(variant.color_name || '').trim() || '—'}
                  </td>
                  <td className="px-3 py-2 font-bold text-slate-600">
                    {(variant.size_name || '').trim() || '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      className={INPUT}
                      inputMode="numeric"
                      aria-label={`${(variant.color_name || '').trim()} ${(variant.size_name || '').trim()}`.trim() || variant.name}
                      value={quantities[variant.id] ?? ''}
                      onChange={(e) => setQuantity(variant.id, e.target.value)}
                      disabled={running}
                      placeholder="0"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handlePrint}
          disabled={!canPrint}
          data-testid="reprint-print"
          title={problems.length > 0 ? copy.problem[problems[0]] : undefined}
          className={`h-14 flex-1 rounded-lg text-base font-black inline-flex items-center justify-center gap-2 ${
            !canPrint
              ? 'cursor-not-allowed bg-slate-200 text-slate-500'
              : confirming
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : 'bg-slate-950 text-white hover:bg-black'
          }`}
        >
          {running ? <RefreshCw size={20} className="animate-spin" /> : <Printer size={20} />}
          {running
            ? copy.printing
            : confirming
              ? copy.confirm(totals.total)
              : copy.print(totals.total)}
        </button>
        {running && (
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            data-testid="reprint-stop"
            className="h-14 rounded-lg border border-slate-300 bg-white px-4 text-base font-black text-slate-700 hover:bg-slate-50 disabled:opacity-60 inline-flex items-center gap-2"
          >
            <Square size={18} />
            {stopping ? copy.stopping : copy.stop}
          </button>
        )}
      </div>
    </div>
  );
}
