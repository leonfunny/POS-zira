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
  compositionText,
  parseCompositionText,
} from '../../../shared/label-print-order';
import {
  buildAddedVariant,
  validateAddedCell,
  type AddedCellProblem,
} from '../../../shared/order-to-product';
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
import FabricTagFields, { type FabricTagContent } from './FabricTagFields';
import rlog from '../../utils/logger';

/** One catalogue row of the style, as the label tab holds it. */
export interface StyleVariant {
  id: string;
  name: string;
  sku?: string | null;
  color_name?: string | null;
  size_name?: string | null;
  /** Grosze, as the local catalogue stores it. A new row of the style copies it. */
  retail_price?: number | null;
}

interface Props {
  language: string;
  /** Catalogue template the rows belong to; the care content is keyed by it. */
  templateId: string;
  styleName: string;
  styleCode: string;
  variants: readonly StyleVariant[];
  onPrintingChange?: (printing: boolean) => void;
  /**
   * Pull the catalogue again after a colour is added. The rows on screen come
   * from the local mirror, and a row written on the server is not one of them
   * until the next sync.
   */
  onVariantsAdded?: () => void | Promise<unknown>;
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
  tagEdit: string;
  tagEditOpen: string;
  tagEditClose: string;
  tagBrand: string;
  tagSave: string;
  tagSaving: string;
  tagSaved: string;
  tagSaveFailed: string;
  tagCompositionKept: (line: string) => string;
  addTitle: string;
  addColor: string;
  addSize: string;
  addButton: string;
  addSaving: string;
  addDone: (colorName: string, sizeName: string) => string;
  addFailed: (reason: string) => string;
  addProblem: Record<AddedCellProblem, string>;
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
      'Mẫu này chưa có nội dung tem vải trên máy — chỉ in được tem đóng gói. Bấm “Sửa nội dung tem” ở dưới để điền.',
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
    tagEdit: 'Nội dung tem vải',
    tagEditOpen: 'Sửa nội dung tem',
    tagEditClose: 'Đóng',
    tagBrand: 'Tên thương hiệu in trên tem',
    tagSave: 'Lưu nội dung tem',
    tagSaving: 'Đang lưu…',
    tagSaved: 'Đã lưu nội dung tem vải',
    tagSaveFailed: 'Không lưu được nội dung tem vải',
    tagCompositionKept: (line) => `Giữ nguyên dòng chất liệu đã lưu: ${line}`,
    addTitle: 'Thêm màu / size',
    addColor: 'Màu',
    addSize: 'Size',
    addButton: 'Thêm vào mẫu này',
    addSaving: 'Đang thêm…',
    addDone: (colorName, sizeName) =>
      `Đã thêm ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    addFailed: (reason) => `Không thêm được: ${reason}`,
    addProblem: {
      NO_COLOR_OR_SIZE: 'Gõ màu hoặc size trước đã',
      ALREADY_EXISTS: 'Mẫu này đã có màu và size đó',
    },
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
      'Ten model nie ma zapisanej treści metki — można wydrukować tylko etykietę na worek. Kliknij „Edytuj treść metki” poniżej.',
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
    tagEdit: 'Treść metki',
    tagEditOpen: 'Edytuj treść metki',
    tagEditClose: 'Zamknij',
    tagBrand: 'Marka drukowana na metce',
    tagSave: 'Zapisz treść metki',
    tagSaving: 'Zapisywanie…',
    tagSaved: 'Treść metki zapisana',
    tagSaveFailed: 'Nie udało się zapisać treści metki',
    tagCompositionKept: (line) => `Zapisany skład pozostaje bez zmian: ${line}`,
    addTitle: 'Dodaj kolor / rozmiar',
    addColor: 'Kolor',
    addSize: 'Rozmiar',
    addButton: 'Dodaj do tego modelu',
    addSaving: 'Dodawanie…',
    addDone: (colorName, sizeName) =>
      `Dodano ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    addFailed: (reason) => `Nie udało się dodać: ${reason}`,
    addProblem: {
      NO_COLOR_OR_SIZE: 'Najpierw wpisz kolor albo rozmiar',
      ALREADY_EXISTS: 'Ten model ma już taki kolor i rozmiar',
    },
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
      'This style has no care content on the machine — only bag labels can print. Use “Edit tag content” below to fill it in.',
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
    tagEdit: 'Fabric tag content',
    tagEditOpen: 'Edit tag content',
    tagEditClose: 'Close',
    tagBrand: 'Brand printed on the tag',
    tagSave: 'Save tag content',
    tagSaving: 'Saving…',
    tagSaved: 'Fabric tag content saved',
    tagSaveFailed: 'Could not save the fabric tag content',
    tagCompositionKept: (line) => `Keeping the stored composition line: ${line}`,
    addTitle: 'Add a colour or size',
    addColor: 'Colour',
    addSize: 'Size',
    addButton: 'Add to this style',
    addSaving: 'Adding…',
    addDone: (colorName, sizeName) =>
      `Added ${[colorName, sizeName].filter(Boolean).join(' / ')}`,
    addFailed: (reason) => `Could not add it: ${reason}`,
    addProblem: {
      NO_COLOR_OR_SIZE: 'Type a colour or a size first',
      ALREADY_EXISTS: 'This style already has that colour and size',
    },
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

/**
 * One idempotency key per cell per attempt.
 *
 * Held across retries of the same cell so an answer lost on the way back adds
 * the colour once, and rebuilt for a different cell so two adds never look like
 * one replay to the server.
 */
function nextAddKey(templateId: string, cell: { colorName: string; sizeName: string }): string {
  return `add-${templateId}-${cell.colorName}-${cell.sizeName}-${Date.now().toString(36)}`.slice(
    0,
    100,
  );
}

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
  onVariantsAdded,
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

  // Editing the tag in place. The draft is seeded from the saved row so a
  // correction starts from what the machine would print, not from blank.
  const [editing, setEditing] = useState(false);
  const [brandDraft, setBrandDraft] = useState('');
  const [contentDraft, setContentDraft] = useState<FabricTagContent>({
    materials: [],
    careSymbols: [],
    careText: '',
  });
  const [saving, setSaving] = useState(false);

  // Adding a colour or size to this style.
  const [colorDraft, setColorDraft] = useState('');
  const [sizeDraft, setSizeDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const addKeyRef = useRef<string | null>(null);

  /**
   * The price a new row takes. Sibling rows of one style cost the same, and the
   * workshop's styles all sit at 0, so reading it off the rows on screen is
   * both correct for a shop that sells and correct for one that does not.
   */
  const siblingPriceGrosze = useMemo(
    () => Math.max(0, Math.floor(Number(rows[0]?.retail_price) || 0)),
    [rows],
  );

  /**
   * The composition line a row was saved with, when its parts could not be
   * recovered from it. Shown as-is and kept on save: a line someone wrote by
   * hand outranks anything this could infer.
   */
  const keptComposition = useMemo(() => {
    const line = (tag?.composition ?? '').trim();
    if (!line) return '';
    if (tag?.materials?.length) return '';
    return parseCompositionText(line).length > 0 ? '' : line;
  }, [tag]);

  const seedDraft = useCallback(() => {
    setBrandDraft(tag?.brandName ?? '');
    setContentDraft({
      // Rows written before the parts were stored carry only the finished line;
      // reading it back is exact for lines this app produced and gives up
      // rather than guessing at anything else.
      materials: tag?.materials?.length
        ? tag.materials.map((material) => ({ ...material }))
        : parseCompositionText(tag?.composition ?? ''),
      careSymbols: [...(tag?.careSymbols ?? [])],
      careText: tag?.careText ?? '',
    });
  }, [tag]);

  // A style change closes the editor: a half-typed correction belongs to the
  // style it was typed against, and carrying it across would save it onto
  // another garment.
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    setColorDraft('');
    setSizeDraft('');
    addKeyRef.current = null;
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

  const addProblems = validateAddedCell(
    { colorName: colorDraft, sizeName: sizeDraft },
    rows.map((row) => ({ colorName: row.color_name, sizeName: row.size_name })),
  );
  const canAdd = addProblems.length === 0 && !adding && !running;

  const handleAddCell = async () => {
    if (!canAdd) return;
    setAdding(true);
    const cell = { colorName: colorDraft.trim(), sizeName: sizeDraft.trim() };
    const variant = buildAddedVariant(styleCode, cell, rows.map((row) => row.sku));
    try {
      const bridge = (window as any).electronAPI?.pos?.productAdmin;
      const result = await Promise.resolve().then(() =>
        bridge?.createProduct?.({
          productId: templateId,
          name: styleName,
          sku: styleCode || null,
          // The rows the style already has set the price; a new colour of a
          // style the till sells must not ring up at a different number.
          priceGrossGrosze: siblingPriceGrosze,
          vatRate: 23,
          // One key per attempt, kept across retries of the same cell: a
          // network answer lost on the way back must not add the colour twice.
          idempotencyKey: (addKeyRef.current ??= nextAddKey(templateId, cell)),
          variants: [
            {
              colorName: variant.colorName,
              sizeName: variant.sizeName,
              sku: variant.sku,
              // Same rule the sheet uses: the SKU reads as the goods and is
              // already unique per cell, so it is the barcode too.
              barcode: variant.sku,
              initialStockQty: 0,
            },
          ],
        }),
      );
      if (!result?.ok) {
        setStatus({
          type: 'error',
          message: copy.addFailed(result?.error || result?.code || '?'),
        });
        return;
      }
      addKeyRef.current = null;
      setColorDraft('');
      setSizeDraft('');
      setStatus({ type: 'success', message: copy.addDone(cell.colorName, cell.sizeName) });
      // The row exists on the server now; it reaches this list through a sync.
      await onVariantsAdded?.();
    } catch (err) {
      rlog.error('[StyleReprintPanel] Failed to add a colour or size:', err);
      setStatus({ type: 'error', message: copy.addFailed(String(err)) });
    } finally {
      setAdding(false);
    }
  };

  const openEditor = () => {
    seedDraft();
    setEditing(true);
  };

  const handleSaveTag = async () => {
    if (saving) return;
    setSaving(true);
    const line = compositionText(contentDraft.materials);
    const next: FabricTagTemplate = {
      templateId,
      brandName: brandDraft.trim() || null,
      logoDataUrl: tag?.logoDataUrl ?? null,
      // A composition typed here wins. With nothing typed, a line that could
      // not be taken apart is kept exactly as saved rather than cleared by an
      // edit that was never about the composition.
      composition: line || keptComposition || null,
      careSymbols: [...contentDraft.careSymbols],
      careText: contentDraft.careText.trim() || null,
      materials: contentDraft.materials.map((material) => ({ ...material })),
      fabric: tag?.fabric ?? null,
      layout: tag?.layout ?? 'default',
    };
    try {
      const bridge = (window as any).electronAPI?.pos?.fabricTagTemplates;
      const saved = await Promise.resolve().then(() => bridge?.save?.(next));
      if (!saved) throw new Error('fabric tag template save returned nothing');
      setTag(saved as FabricTagTemplate);
      setEditing(false);
      setStatus({ type: 'success', message: copy.tagSaved });
    } catch (err) {
      rlog.error('[StyleReprintPanel] Failed to save fabric tag content:', err);
      // The editor stays open with the typed content: a correction the operator
      // has just typed must not vanish because a write failed.
      setStatus({ type: 'error', message: copy.tagSaveFailed });
    } finally {
      setSaving(false);
    }
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

      <section className="rounded-lg border border-slate-200" data-testid="tag-editor">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="text-xs font-extrabold uppercase tracking-wide text-slate-400">
            {copy.tagEdit}
          </div>
          <button
            type="button"
            data-testid="tag-edit-toggle"
            disabled={running}
            onClick={() => (editing ? setEditing(false) : openEditor())}
            className="rounded-md border border-slate-200 px-2 py-1 text-[11px] font-extrabold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            {editing ? copy.tagEditClose : copy.tagEditOpen}
          </button>
        </div>
        {editing && (
          <div className="border-t border-slate-200 px-3 pt-3">
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">
                {copy.tagBrand}
              </span>
              <input
                className="h-10 w-full rounded-md border border-slate-300 px-2.5 text-sm"
                data-testid="tag-brand"
                value={brandDraft}
                disabled={saving}
                onChange={(e) => setBrandDraft(e.target.value)}
              />
            </label>

            <FabricTagFields
              language={language}
              value={contentDraft}
              onChange={(changes) => setContentDraft((current) => ({ ...current, ...changes }))}
              disabled={saving}
            />

            {keptComposition && contentDraft.materials.length === 0 && (
              <p
                className="mb-3 text-xs font-bold text-slate-500"
                data-testid="tag-kept-composition"
              >
                {copy.tagCompositionKept(keptComposition)}
              </p>
            )}

            <button
              type="button"
              data-testid="tag-save"
              onClick={handleSaveTag}
              disabled={saving}
              className="mb-3 h-11 w-full rounded-lg bg-slate-800 text-sm font-black text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {saving ? copy.tagSaving : copy.tagSave}
            </button>
          </div>
        )}
      </section>

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

        <div
          className="rounded-lg border border-dashed border-slate-300 p-3"
          data-testid="add-variant"
        >
          <div className="mb-2 text-xs font-extrabold uppercase tracking-wide text-slate-400">
            {copy.addTitle}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[11px] font-bold uppercase text-slate-500">
                {copy.addColor}
              </span>
              <input
                className="h-10 w-full rounded-md border border-slate-300 px-2.5 text-sm"
                data-testid="add-color"
                aria-label={copy.addColor}
                value={colorDraft}
                disabled={adding || running}
                onChange={(e) => setColorDraft(e.target.value.toUpperCase())}
              />
            </label>
            <label className="w-28">
              <span className="mb-1 block text-[11px] font-bold uppercase text-slate-500">
                {copy.addSize}
              </span>
              <input
                className="h-10 w-full rounded-md border border-slate-300 px-2.5 text-sm"
                data-testid="add-size"
                aria-label={copy.addSize}
                value={sizeDraft}
                disabled={adding || running}
                onChange={(e) => setSizeDraft(e.target.value.toUpperCase())}
              />
            </label>
            <button
              type="button"
              data-testid="add-submit"
              onClick={handleAddCell}
              disabled={!canAdd}
              title={addProblems.length > 0 ? copy.addProblem[addProblems[0]] : undefined}
              className="h-10 rounded-md border border-slate-300 px-3 text-sm font-extrabold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {adding ? copy.addSaving : copy.addButton}
            </button>
          </div>
          {addProblems.length > 0 && (colorDraft || sizeDraft) && (
            <p className="mt-1.5 text-xs font-bold text-amber-700" data-testid="add-problem">
              {copy.addProblem[addProblems[0]]}
            </p>
          )}
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
