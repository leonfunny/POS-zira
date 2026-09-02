import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Plus, Save, Trash2, X } from 'lucide-react';
import {
  CARE_TEXT_PRESETS,
  FABRIC_MATERIALS,
  LabelPrintOrder,
  MAX_SIZE_LABEL_CHARS,
  OrderProblem,
  buildPrintPlan,
  compositionText,
  createEmptyOrder,
  careTextHasPreset,
  careTextPresetFits,
  orderTotals,
  toggleCareTextPreset,
  validateOrder,
} from '../../../shared/label-print-order';
import {
  CARE_SYMBOLS,
  CARE_SYMBOL_FAMILIES,
  CareSymbol,
  CareSymbolFamilyKey,
  FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS,
} from '../../../shared/types';
import { careSymbolLabel, careSymbolSvg } from '../../../shared/care-symbols';
import { PrintProgress, runPrintPlan } from './print-order-runner';
import {
  SavedPrintOrder,
  clearDraft,
  deleteSavedOrder,
  describeOrder,
  listSavedOrders,
  loadDraft,
  loadDraftId,
  saveDraft,
  saveDraftId,
  saveOrder,
} from './print-order-storage';

/** Sizes staff reach for most; the field stays free text for anything else. */
const SIZE_SUGGESTIONS = ['S', 'M', 'L', 'XL', '2XL', 'S/M', 'L/XL', '44/46'];

interface Copy {
  title: string;
  subtitle: string;
  customer: string;
  styleName: string;
  styleCode: string;
  materials: string;
  materialsHint: string;
  care: string;
  careGroup: Record<CareSymbolFamilyKey, string>;
  careText: string;
  careTextHint: string;
  sizes: string;
  addSize: string;
  color: string;
  code: string;
  codeHint: string;
  rowTotal: string;
  addRow: string;
  total: string;
  whatToPrint: string;
  printFabric: string;
  printSticker: string;
  includeSize: string;
  print: string;
  printing: string;
  save: string;
  saved: string;
  savedOrders: string;
  noSavedOrders: string;
  open: string;
  remove: string;
  newOrder: string;
  stopAfter: string;
  stopHint: string;
  noResume: string;
  missingCode: string;
  percentSum: (sum: number) => string;
  progress: (done: number, total: number, copies: number, all: number) => string;
  finished: (copies: number) => string;
  stopped: (done: number, total: number) => string;
  problem: Record<OrderProblem, string>;
}

const COPY: Record<string, Copy> = {
  vi: {
    title: 'Đơn in',
    subtitle: 'Nhập theo tờ A4 của khách rồi in một lần',
    customer: 'Khách',
    styleName: 'Tên hàng',
    styleCode: 'Mã hàng',
    materials: 'Chất liệu',
    materialsHint: 'Bấm chọn rồi gõ số phần trăm',
    care: 'Ký hiệu giặt',
    careGroup: { wash: 'Giặt', bleach: 'Tẩy', tumble: 'Sấy máy', natural: 'Phơi', iron: 'Là', dryclean: 'Giặt khô', wetclean: 'Giặt ướt' },
    careText: 'Dòng ghi thêm',
    careTextHint: 'Ví dụ: NATURALNY LEN',
    sizes: 'Size',
    addSize: 'Thêm size',
    color: 'Màu',
    code: 'Mã tem',
    codeHint: 'Để trống thì màu này không in tem dán',
    rowTotal: 'Tổng',
    addRow: 'Thêm màu',
    total: 'Tổng cộng',
    whatToPrint: 'In gì',
    printFabric: 'Mác vải',
    printSticker: 'Tem dán bao bì',
    includeSize: 'Tem dán ghi cả size',
    print: 'In',
    printing: 'Đang in…',
    save: 'Lưu đơn',
    saved: 'Đã lưu',
    savedOrders: 'Đơn đã lưu',
    noSavedOrders: 'Chưa có đơn nào được lưu',
    open: 'Mở',
    remove: 'Xoá',
    newOrder: 'Đơn mới',
    stopAfter: 'Dừng in',
    stopHint: 'Bấm Dừng thì lô đang gửi vẫn in nốt rồi mới ngừng.',
    noResume: 'Máy kẹt hay tắt app giữa chừng thì phải đếm tem thật trước khi in lại.',
    missingCode: 'Thiếu mã tem — màu này chỉ in mác vải',
    percentSum: (sum) => `Tổng phần trăm đang là ${sum}%`,
    progress: (done, total, copies, all) => `Đã in ${done}/${total} lô · ${copies}/${all} tem`,
    finished: (copies) => `Đã in xong ${copies} tem`,
    stopped: (done, total) => `Đã dừng sau ${done}/${total} lô`,
    problem: {
      EMPTY_ORDER: 'Chưa có số lượng nào',
      NOTHING_SELECTED: 'Chưa chọn in loại nhãn nào',
      DUPLICATE_SIZE: 'Có hai cột size trùng tên',
      EMPTY_SIZE: 'Có cột size chưa đặt tên',
      BAD_CODE: 'Mã tem có ký tự máy in không đọc được',
      ORDER_TOO_LARGE: 'Số lượng quá lớn — kiểm tra lại',
    },
  },
  pl: {
    title: 'Zlecenie druku',
    subtitle: 'Przepisz kartę A4 klienta i wydrukuj za jednym razem',
    customer: 'Klient',
    styleName: 'Nazwa modelu',
    styleCode: 'Kod modelu',
    materials: 'Skład',
    materialsHint: 'Kliknij materiał i wpisz procent',
    care: 'Symbole prania',
    careGroup: { wash: 'Pranie', bleach: 'Wybielanie', tumble: 'Suszarka', natural: 'Suszenie', iron: 'Prasowanie', dryclean: 'Czyszczenie', wetclean: 'Pranie wodne' },
    careText: 'Dodatkowy wiersz',
    careTextHint: 'Np. NATURALNY LEN',
    sizes: 'Rozmiary',
    addSize: 'Dodaj rozmiar',
    color: 'Kolor',
    code: 'Kod etykiety',
    codeHint: 'Puste = bez naklejki dla tego koloru',
    rowTotal: 'Razem',
    addRow: 'Dodaj kolor',
    total: 'Razem',
    whatToPrint: 'Co drukować',
    printFabric: 'Metki',
    printSticker: 'Naklejki na opakowanie',
    includeSize: 'Rozmiar na naklejce',
    print: 'Drukuj',
    printing: 'Drukowanie…',
    save: 'Zapisz',
    saved: 'Zapisano',
    savedOrders: 'Zapisane zlecenia',
    noSavedOrders: 'Brak zapisanych zleceń',
    open: 'Otwórz',
    remove: 'Usuń',
    newOrder: 'Nowe zlecenie',
    stopAfter: 'Zatrzymaj druk',
    stopHint: 'Po naciśnięciu Zatrzymaj bieżąca partia dokończy się i dopiero potem druk stanie.',
    noResume: 'Po zacięciu lub zamknięciu aplikacji policz metki, zanim wydrukujesz ponownie.',
    missingCode: 'Brak kodu — ten kolor dostanie tylko metki',
    percentSum: (sum) => `Suma procentów: ${sum}%`,
    progress: (done, total, copies, all) => `${done}/${total} partii · ${copies}/${all} sztuk`,
    finished: (copies) => `Wydrukowano ${copies} szt.`,
    stopped: (done, total) => `Zatrzymano po ${done}/${total} partii`,
    problem: {
      EMPTY_ORDER: 'Brak ilości',
      NOTHING_SELECTED: 'Nie wybrano rodzaju etykiety',
      DUPLICATE_SIZE: 'Dwie kolumny mają ten sam rozmiar',
      EMPTY_SIZE: 'Kolumna rozmiaru bez nazwy',
      BAD_CODE: 'Kod zawiera znaki, których drukarka nie odczyta',
      ORDER_TOO_LARGE: 'Zbyt duża ilość — sprawdź',
    },
  },
  en: {
    title: 'Print order',
    subtitle: "Type in the customer's A4 sheet, then print once",
    customer: 'Customer',
    styleName: 'Style name',
    styleCode: 'Style code',
    materials: 'Composition',
    materialsHint: 'Tap a material and type the percentage',
    care: 'Care symbols',
    careGroup: { wash: 'Washing', bleach: 'Bleaching', tumble: 'Tumble drying', natural: 'Natural drying', iron: 'Ironing', dryclean: 'Dry cleaning', wetclean: 'Wet cleaning' },
    careText: 'Extra line',
    careTextHint: 'e.g. NATURALNY LEN',
    sizes: 'Sizes',
    addSize: 'Add size',
    color: 'Colour',
    code: 'Sticker code',
    codeHint: 'Blank means no packaging sticker for this colour',
    rowTotal: 'Total',
    addRow: 'Add colour',
    total: 'Grand total',
    whatToPrint: 'What to print',
    printFabric: 'Fabric tags',
    printSticker: 'Packaging stickers',
    includeSize: 'Put the size on the sticker',
    print: 'Print',
    printing: 'Printing…',
    save: 'Save order',
    saved: 'Saved',
    savedOrders: 'Saved orders',
    noSavedOrders: 'No saved orders yet',
    open: 'Open',
    remove: 'Delete',
    newOrder: 'New order',
    stopAfter: 'Stop printing',
    stopHint: 'Stop takes effect after the batch already sent finishes.',
    noResume: 'After a jam or an app restart, count the printed labels before reprinting.',
    missingCode: 'No sticker code — this colour gets fabric tags only',
    percentSum: (sum) => `Percentages add up to ${sum}%`,
    progress: (done, total, copies, all) => `${done}/${total} batches · ${copies}/${all} labels`,
    finished: (copies) => `Printed ${copies} labels`,
    stopped: (done, total) => `Stopped after ${done}/${total} batches`,
    problem: {
      EMPTY_ORDER: 'No quantities entered',
      NOTHING_SELECTED: 'No label kind selected',
      DUPLICATE_SIZE: 'Two size columns share a name',
      EMPTY_SIZE: 'A size column has no name',
      BAD_CODE: 'A sticker code has characters the printer cannot encode',
      ORDER_TOO_LARGE: 'Quantity is implausibly large — check the sheet',
    },
  },
};

interface Props {
  language: string;
  active: boolean;
  onPrintingChange?: (printing: boolean) => void;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export default function PrintOrderPanel({ language, active, onPrintingChange }: Props) {
  const copy = COPY[language] || COPY.vi;

  const [order, setOrder] = useState<LabelPrintOrder>(() => loadDraft());
  const [savedOrders, setSavedOrders] = useState<SavedPrintOrder[]>(() => listSavedOrders());
  // Which saved order is on screen. Restored from storage so that editing an
  // order the next morning updates it instead of filing a twin beside it.
  const [orderId, setOrderId] = useState<string>(() => loadDraftId() ?? nextId('order'));
  const [progress, setProgress] = useState<PrintProgress | null>(null);
  const [result, setResult] = useState<{ type: string; message: string } | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const printInFlight = useRef(false);
  const stopRequested = useRef(false);

  useEffect(() => {
    saveDraft(order);
    // Any change to the sheet un-says "Saved". Hung off the order itself rather
    // than off each handler: typing in the grid, picking a symbol or adding a
    // size all went through setOrder directly, so the button kept claiming the
    // edit was filed when it was not. Saving does not touch `order`, so this
    // does not fight the notice it just set.
    setSavedNotice(false);
  }, [order]);

  useEffect(() => {
    saveDraftId(orderId);
  }, [orderId]);

  useEffect(
    () => () => {
      // Unmounting mid-run must not leave the loop feeding a printer nobody is
      // watching; it ends at the next step boundary.
      stopRequested.current = true;
    },
    [],
  );

  const totals = useMemo(() => orderTotals(order), [order]);
  const problems = useMemo(() => validateOrder(order), [order]);
  const plan = useMemo(() => buildPrintPlan(order), [order]);
  const composition = compositionText(order.materials);
  const percentSum = order.materials.reduce((sum, m) => sum + (Number(m.percent) || 0), 0);

  const patch = useCallback((changes: Partial<LabelPrintOrder>) => {
    setOrder((current) => ({ ...current, ...changes }));
    setResult(null);
  }, []);

  const setCell = (rowId: string, sizeId: string, value: string) => {
    const quantity = value === '' ? 0 : Math.max(0, Math.floor(Number(value) || 0));
    setOrder((current) => ({
      ...current,
      rows: current.rows.map((row) =>
        row.id === rowId ? { ...row, quantities: { ...row.quantities, [sizeId]: quantity } } : row,
      ),
    }));
  };

  const toggleMaterial = (name: string) => {
    setOrder((current) => {
      const existing = current.materials.find((m) => m.name === name);
      return {
        ...current,
        materials: existing
          ? current.materials.filter((m) => m.name !== name)
          : [...current.materials, { name, percent: 0 }],
      };
    });
  };

  const setMaterialPercent = (name: string, value: string) => {
    const percent = Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
    setOrder((current) => ({
      ...current,
      materials: current.materials.map((m) => (m.name === name ? { ...m, percent } : m)),
    }));
  };

  const toggleCareSymbol = (symbol: CareSymbol) => {
    setOrder((current) => {
      if (current.careSymbols.includes(symbol)) {
        return { ...current, careSymbols: current.careSymbols.filter((s) => s !== symbol) };
      }
      // Wash, bleach, tumble, iron and dry-clean each behave like a radio group:
      // a tag saying both "wash at 30" and "do not wash" is nonsense, and main
      // would refuse it at print time anyway.
      const exclusive = FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS.find((group) =>
        group.includes(symbol),
      );
      const compatible = exclusive
        ? current.careSymbols.filter((selected) => !exclusive.includes(selected))
        : current.careSymbols;
      return {
        ...current,
        careSymbols: [...compatible, symbol].sort(
          (a, b) => CARE_SYMBOLS.indexOf(a) - CARE_SYMBOLS.indexOf(b),
        ),
      };
    });
  };

  const addSize = (label: string) => {
    const trimmed = label.trim().slice(0, MAX_SIZE_LABEL_CHARS);
    if (!trimmed) return;
    setOrder((current) =>
      current.sizes.some((s) => s.label === trimmed)
        ? current
        : { ...current, sizes: [...current.sizes, { id: nextId('size'), label: trimmed }] },
    );
  };

  const removeSize = (sizeId: string) =>
    patch({ sizes: order.sizes.filter((size) => size.id !== sizeId) });

  const addRow = () =>
    patch({
      rows: [...order.rows, { id: nextId('row'), colorName: '', code: '', quantities: {} }],
    });

  const removeRow = (rowId: string) => patch({ rows: order.rows.filter((r) => r.id !== rowId) });

  const handlePrint = async () => {
    if (printInFlight.current || problems.length > 0 || plan.length === 0) return;
    const api = (window as any).electronAPI;
    if (!api?.printPackagingSticker || !api?.printFabricTag) {
      setResult({ type: 'error', message: 'Print bridge unavailable' });
      return;
    }

    printInFlight.current = true;
    stopRequested.current = false;
    onPrintingChange?.(true);
    setResult(null);

    try {
      const outcome = await runPrintPlan(
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
          onProgress: setProgress,
          shouldStop: () => stopRequested.current,
        },
      );

      setResult({
        type: outcome.type,
        message:
          outcome.type === 'success'
            ? copy.finished(outcome.printedCopies)
            : outcome.type === 'stopped'
              ? copy.stopped(outcome.completedSteps, plan.length)
              : outcome.message || 'Print failed',
      });
    } finally {
      printInFlight.current = false;
      onPrintingChange?.(false);
    }
  };

  const handleSave = () => {
    setSavedOrders(saveOrder(orderId, order));
    setSavedNotice(true);
  };

  // Switching sheets from the saved list at the bottom leaves the reader
  // looking at the list, not at the order that just replaced everything above.
  const scrollToTop = () => scrollRef.current?.scrollTo({ top: 0 });

  const handleOpen = (saved: SavedPrintOrder) => {
    setOrder(saved.order);
    setOrderId(saved.id);
    setProgress(null);
    setResult(null);
    setSavedNotice(false);
    scrollToTop();
  };

  const handleNew = () => {
    clearDraft();
    setOrder(createEmptyOrder());
    setOrderId(nextId('order'));
    setProgress(null);
    setResult(null);
    setSavedNotice(false);
    scrollToTop();
  };

  const isPrinting = progress?.type === 'printing';
  const canPrint = problems.length === 0 && plan.length > 0 && !isPrinting;

  return (
    <div
      ref={scrollRef}
      className="h-full min-h-0 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4"
      data-testid="print-order-panel"
      aria-hidden={!active}
    >
      <header className="mb-4">
        <h2 className="text-lg font-extrabold text-slate-900">{copy.title}</h2>
        <p className="text-sm text-slate-500">{copy.subtitle}</p>
      </header>

      <section className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label={copy.customer}>
          <input
            className={INPUT}
            value={order.customerName}
            onChange={(e) => patch({ customerName: e.target.value })}
            placeholder="MoonCollection"
          />
        </Field>
        <Field label={copy.styleName}>
          <input
            className={INPUT}
            value={order.styleName}
            onChange={(e) => patch({ styleName: e.target.value })}
            placeholder="KURTKA"
          />
        </Field>
        <Field label={copy.styleCode}>
          <input
            className={INPUT}
            value={order.styleCode}
            onChange={(e) => patch({ styleCode: e.target.value })}
            placeholder="114"
          />
        </Field>
      </section>

      <section className="mb-4 rounded-md border border-slate-200 p-3">
        <h3 className="mb-1 text-sm font-bold text-slate-700">{copy.materials}</h3>
        <p className="mb-2 text-xs text-slate-500">{copy.materialsHint}</p>
        <div className="flex flex-wrap gap-2">
          {FABRIC_MATERIALS.map((name) => {
            const selected = order.materials.find((m) => m.name === name);
            return (
              <div key={name} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggleMaterial(name)}
                  aria-pressed={!!selected}
                  className={`min-h-9 rounded-md border px-2 text-xs font-bold ${
                    selected
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {name}
                </button>
                {selected && (
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="h-9 w-16 rounded-md border border-slate-300 px-2 text-sm"
                    value={selected.percent || ''}
                    onChange={(e) => setMaterialPercent(name, e.target.value)}
                    aria-label={`${name} %`}
                  />
                )}
              </div>
            );
          })}
        </div>
        {composition && (
          <p className="mt-2 text-sm font-bold text-slate-800" data-testid="composition-preview">
            {composition}
          </p>
        )}
        {percentSum > 0 && percentSum !== 100 && (
          <p className="mt-1 text-xs font-bold text-amber-700">{copy.percentSum(percentSum)}</p>
        )}
      </section>

      <section className="mb-4 rounded-md border border-slate-200 p-3">
        <h3 className="mb-2 text-sm font-bold text-slate-700">{copy.care}</h3>
        <div className="space-y-2">
          {CARE_SYMBOL_FAMILIES.map((group) => (
            <div key={group.key}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {copy.careGroup[group.key]}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {group.symbols.map((symbol) => (
                  <button
                    key={symbol}
                    type="button"
                    // Hover text and the accessible name say what the symbol
                    // means; `data-symbol` keeps a stable hook for tests and for
                    // anyone reading the DOM.
                    title={careSymbolLabel(symbol, language)}
                    aria-label={careSymbolLabel(symbol, language)}
                    data-symbol={symbol}
                    onClick={() => toggleCareSymbol(symbol)}
                    aria-pressed={order.careSymbols.includes(symbol)}
                    className={`flex h-11 w-11 items-center justify-center rounded border ${
                      order.careSymbols.includes(symbol)
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                        : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-600'
                    }`}
                    // The picker draws the same vector art the tag prints, so what
                    // staff choose is literally what comes out of the machine.
                    dangerouslySetInnerHTML={{ __html: careSymbolSvg(symbol, 26) }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        {order.careSymbols.length > 0 && (
          <div
            className="mt-2 flex flex-wrap items-center gap-1 text-slate-700"
            data-testid="care-preview"
            aria-label="care preview"
            dangerouslySetInnerHTML={{
              __html: order.careSymbols.map((s) => careSymbolSvg(s, 20)).join(''),
            }}
          />
        )}
        <div className="mt-3">
          <Field label={copy.careText}>
            <input
              className={INPUT}
              value={order.careText}
              onChange={(e) => patch({ careText: e.target.value })}
              placeholder={copy.careTextHint}
            />
          </Field>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {CARE_TEXT_PRESETS.map((preset) => {
              const chosen = careTextHasPreset(order.careText, preset);
              const fits = careTextPresetFits(order.careText, preset);
              return (
                <button
                  key={preset}
                  type="button"
                  disabled={!fits}
                  data-care-text-preset={preset}
                  aria-pressed={chosen}
                  onClick={() => patch({ careText: toggleCareTextPreset(order.careText, preset) })}
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                    chosen
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                      : fits
                        ? 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                        : 'cursor-not-allowed border-slate-100 bg-slate-50 text-slate-300'
                  }`}
                >
                  {preset}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mb-4 rounded-md border border-slate-200 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold text-slate-700">{copy.sizes}</h3>
          {SIZE_SUGGESTIONS.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => addSize(label)}
              className="min-h-8 rounded border border-slate-200 px-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              + {label}
            </button>
          ))}
          <SizeAdder onAdd={addSize} placeholder={copy.addSize} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b border-slate-200 p-2 text-left font-bold">{copy.color}</th>
                <th className="border-b border-slate-200 p-2 text-left font-bold">{copy.code}</th>
                {order.sizes.map((size) => (
                  <th key={size.id} className="border-b border-slate-200 p-2 font-bold">
                    <span className="inline-flex items-center gap-1">
                      {size.label}
                      <button
                        type="button"
                        onClick={() => removeSize(size.id)}
                        aria-label={`${copy.remove} ${size.label}`}
                        className="text-slate-400 hover:text-red-600"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  </th>
                ))}
                <th className="border-b border-slate-200 p-2 font-bold">{copy.rowTotal}</th>
                <th className="border-b border-slate-200 p-2" />
              </tr>
            </thead>
            <tbody>
              {order.rows.map((row) => (
                <tr key={row.id}>
                  <td className="border-b border-slate-100 p-1">
                    <input
                      className={INPUT}
                      value={row.colorName}
                      onChange={(e) =>
                        patch({
                          rows: order.rows.map((r) =>
                            r.id === row.id ? { ...r, colorName: e.target.value } : r,
                          ),
                        })
                      }
                      placeholder="CZEKOLADA"
                      aria-label={copy.color}
                    />
                  </td>
                  <td className="border-b border-slate-100 p-1">
                    <input
                      className={INPUT}
                      value={row.code}
                      onChange={(e) =>
                        patch({
                          rows: order.rows.map((r) =>
                            r.id === row.id ? { ...r, code: e.target.value } : r,
                          ),
                        })
                      }
                      placeholder="SP006290"
                      aria-label={copy.code}
                    />
                    {order.printStickers && !row.code.trim() && (
                      <p className="mt-0.5 text-[11px] font-bold text-amber-700">
                        {copy.missingCode}
                      </p>
                    )}
                  </td>
                  {order.sizes.map((size) => (
                    <td key={size.id} className="border-b border-slate-100 p-1">
                      <input
                        type="number"
                        min={0}
                        className="h-10 w-20 rounded-md border border-slate-300 px-2 text-center text-sm"
                        value={row.quantities[size.id] || ''}
                        onChange={(e) => setCell(row.id, size.id, e.target.value)}
                        aria-label={`${row.colorName || copy.color} ${size.label}`}
                      />
                    </td>
                  ))}
                  <td className="border-b border-slate-100 p-2 text-center font-extrabold">
                    {totals.rowTotals[row.id] || 0}
                  </td>
                  <td className="border-b border-slate-100 p-2">
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      aria-label={`${copy.remove} ${row.colorName || row.id}`}
                      className="text-slate-400 hover:text-red-600"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="p-2 font-bold" colSpan={2}>
                  {copy.total}
                </td>
                {order.sizes.map((size) => (
                  <td key={size.id} className="p-2 text-center font-bold">
                    {totals.sizeTotals[size.id] || 0}
                  </td>
                ))}
                <td className="p-2 text-center text-base font-extrabold" data-testid="grand-total">
                  {totals.grandTotal}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <button
          type="button"
          onClick={addRow}
          className="mt-2 inline-flex min-h-10 items-center gap-1 rounded-md border border-slate-300 px-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          <Plus size={16} aria-hidden="true" />
          {copy.addRow}
        </button>
      </section>

      <section className="mb-4 rounded-md border border-slate-200 p-3">
        <h3 className="mb-2 text-sm font-bold text-slate-700">{copy.whatToPrint}</h3>
        <div className="flex flex-wrap gap-4">
          <Check
            label={copy.printFabric}
            checked={order.printFabricTags}
            onChange={(v) => patch({ printFabricTags: v })}
          />
          <Check
            label={copy.printSticker}
            checked={order.printStickers}
            onChange={(v) => patch({ printStickers: v })}
          />
          <Check
            label={copy.includeSize}
            checked={order.stickerIncludesSize}
            onChange={(v) => patch({ stickerIncludesSize: v })}
            disabled={!order.printStickers}
          />
        </div>
      </section>

      {problems.length > 0 && (
        <ul className="mb-3 space-y-1" data-testid="order-problems">
          {problems.map((problem) => (
            <li key={problem} className="text-sm font-bold text-red-700">
              {copy.problem[problem]}
            </li>
          ))}
        </ul>
      )}

      <p className="mb-2 text-xs text-slate-500">{copy.noResume}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handlePrint}
          disabled={!canPrint}
          className="inline-flex min-h-11 items-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play size={18} aria-hidden="true" />
          {isPrinting ? copy.printing : copy.print}
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-slate-300 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          <Save size={18} aria-hidden="true" />
          {savedNotice ? copy.saved : copy.save}
        </button>
        <button
          type="button"
          onClick={handleNew}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          {copy.newOrder}
        </button>
        {isPrinting && (
          <button
            type="button"
            data-testid="stop-print"
            onClick={() => {
              stopRequested.current = true;
            }}
            className="inline-flex min-h-11 items-center rounded-md border border-red-300 px-4 text-sm font-bold text-red-700 hover:bg-red-50"
          >
            {copy.stopAfter}
          </button>
        )}
      </div>

      {progress && (
        <p className="mt-2 text-sm font-bold text-slate-700" data-testid="print-progress">
          {copy.progress(
            progress.completedSteps,
            progress.totalSteps,
            progress.printedCopies,
            progress.totalCopies,
          )}
        </p>
      )}

      {isPrinting && (
        <p className="text-xs text-slate-500" data-testid="stop-hint">
          {copy.stopHint}
        </p>
      )}

      {result && (
        <p
          className={`mt-1 text-sm font-bold ${
            result.type === 'error' ? 'text-red-700' : 'text-emerald-700'
          }`}
          data-testid="print-result"
        >
          {result.message}
        </p>
      )}

      <section className="mt-6 border-t border-slate-200 pt-3">
        <h3 className="mb-2 text-sm font-bold text-slate-700">{copy.savedOrders}</h3>
        {savedOrders.length === 0 ? (
          <p className="text-sm text-slate-500">{copy.noSavedOrders}</p>
        ) : (
          <ul className="space-y-1">
            {savedOrders.map((saved) => (
              <li
                key={saved.id}
                data-saved-order={saved.id}
                data-open={saved.id === orderId ? 'true' : undefined}
                className={`flex items-center gap-2 rounded px-1 text-sm ${
                  saved.id === orderId ? 'bg-emerald-50 font-bold text-emerald-900' : ''
                }`}
              >
                <span className="flex-1 truncate">{describeOrder(saved.order)}</span>
                <button
                  type="button"
                  onClick={() => handleOpen(saved)}
                  className="min-h-9 rounded border border-slate-300 px-2 text-xs font-bold hover:bg-slate-50"
                >
                  {copy.open}
                </button>
                <button
                  type="button"
                  onClick={() => setSavedOrders(deleteSavedOrder(saved.id))}
                  className="min-h-9 rounded border border-slate-200 px-2 text-xs font-bold text-slate-500 hover:bg-red-50 hover:text-red-700"
                >
                  {copy.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const INPUT =
  'h-10 w-full rounded-md border border-slate-300 px-2 text-sm focus:border-emerald-500 focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`inline-flex items-center gap-2 text-sm font-bold ${disabled ? 'opacity-50' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 rounded border-slate-300"
      />
      {label}
    </label>
  );
}

function SizeAdder({ onAdd, placeholder }: { onAdd: (label: string) => void; placeholder: string }) {
  const [value, setValue] = useState('');
  const commit = () => {
    onAdd(value);
    setValue('');
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input
        className="h-9 w-24 rounded-md border border-slate-300 px-2 text-sm"
        value={value}
        maxLength={MAX_SIZE_LABEL_CHARS}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <button
        type="button"
        onClick={commit}
        className="min-h-9 rounded border border-slate-300 px-2 text-xs font-bold hover:bg-slate-50"
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    </span>
  );
}
