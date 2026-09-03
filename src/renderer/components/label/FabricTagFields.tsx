import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  CARE_TEXT_MAX_CHARS,
  CARE_TEXT_MAX_LINES,
  CARE_TEXT_PRESETS,
  FABRIC_MATERIALS,
  addCareTextLine,
  careTextHasPreset,
  careTextLines,
  careTextLinesFit,
  careTextPresetFits,
  compositionText,
  percentFix,
  removeCareTextLine,
  toggleCareTextPreset,
} from '../../../shared/label-print-order';
import {
  CARE_SYMBOLS,
  CARE_SYMBOL_FAMILIES,
  CareSymbol,
  CareSymbolFamilyKey,
  FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS,
} from '../../../shared/types';
import { careSymbolLabel, careSymbolSvg } from '../../../shared/care-symbols';

/**
 * What a fabric tag says about the garment, and nothing else.
 *
 * The print order sheet was the only place these could be typed, so correcting
 * a composition meant going back to the sheet that made the style. The same
 * controls now stand on their own and are rendered wherever the content can be
 * edited — the sheet, and the style's own reprint panel. One copy: a chip added
 * here appears in both places, and the two can never drift into disagreeing
 * about what a tag may say.
 */
export interface FabricTagContent {
  materials: { name: string; percent: number }[];
  careSymbols: CareSymbol[];
  careText: string;
}

interface FabricTagFieldsProps {
  /** Tab language: 'vi' | 'pl' | 'en', falling back to English for anything else. */
  language: string;
  value: FabricTagContent;
  onChange: (changes: Partial<FabricTagContent>) => void;
  /** Set while a print run is in flight; the tag content must not move under it. */
  disabled?: boolean;
}

interface FabricTagCopy {
  materials: string;
  materialsHint: string;
  care: string;
  careGroup: Record<CareSymbolFamilyKey, string>;
  careText: string;
  careTextHint: string;
  careLineAdd: string;
  careLineEmpty: string;
  careLineRemove: string;
  careLineFull: string;
  careLineNumber: (index: number) => string;
  percentSum: (sum: number) => string;
  percentFix: (name: string, percent: number) => string;
}

const COPY: Record<string, FabricTagCopy> = {
  vi: {
    materials: 'Chất liệu',
    materialsHint: 'Bấm chọn rồi gõ số phần trăm',
    care: 'Ký hiệu giặt',
    careGroup: { wash: 'Giặt', bleach: 'Tẩy', tumble: 'Sấy máy', natural: 'Phơi', iron: 'Là', dryclean: 'Giặt khô', wetclean: 'Giặt ướt' },
    careText: 'Các dòng ghi thêm',
    careTextHint: 'Gõ một dòng rồi Enter',
    careLineAdd: 'Thêm dòng',
    careLineEmpty: 'Chưa có dòng nào',
    careLineRemove: 'Bỏ dòng',
    careLineFull: 'Hết chỗ — bỏ bớt một dòng trước đã.',
    careLineNumber: (index) => `Dòng ${index}`,
    percentSum: (sum) => `Tổng phần trăm đang là ${sum}%`,
    percentFix: (name, percent) => `Đặt ${name} = ${percent}%`,
  },
  pl: {
    materials: 'Skład',
    materialsHint: 'Kliknij materiał i wpisz procent',
    care: 'Symbole prania',
    careGroup: { wash: 'Pranie', bleach: 'Wybielanie', tumble: 'Suszarka', natural: 'Suszenie', iron: 'Prasowanie', dryclean: 'Czyszczenie', wetclean: 'Pranie wodne' },
    careText: 'Dodatkowe wiersze',
    careTextHint: 'Wpisz wiersz i naciśnij Enter',
    careLineAdd: 'Dodaj wiersz',
    careLineEmpty: 'Brak dodatkowych wierszy',
    careLineRemove: 'Usuń wiersz',
    careLineFull: 'Brak miejsca — najpierw usuń wiersz.',
    careLineNumber: (index) => `Wiersz ${index}`,
    percentSum: (sum) => `Suma procentów: ${sum}%`,
    percentFix: (name, percent) => `Ustaw ${name} = ${percent}%`,
  },
  en: {
    materials: 'Composition',
    materialsHint: 'Tap a material and type the percentage',
    care: 'Care symbols',
    careGroup: { wash: 'Washing', bleach: 'Bleaching', tumble: 'Tumble drying', natural: 'Natural drying', iron: 'Ironing', dryclean: 'Dry cleaning', wetclean: 'Wet cleaning' },
    careText: 'Extra lines',
    careTextHint: 'Type a line and press Enter',
    careLineAdd: 'Add line',
    careLineEmpty: 'No extra lines yet',
    careLineRemove: 'Remove line',
    careLineFull: 'No room left — remove a line first.',
    careLineNumber: (index) => `Line ${index}`,
    percentSum: (sum) => `Percentages add up to ${sum}%`,
    percentFix: (name, percent) => `Set ${name} to ${percent}%`,
  },
};

const INPUT = 'h-10 w-full rounded-md border border-slate-300 px-2.5 text-sm';

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

export default function FabricTagFields({
  language,
  value,
  onChange,
  disabled = false,
}: FabricTagFieldsProps) {
  const copy = COPY[language] ?? COPY.en;
  const [careLineDraft, setCareLineDraft] = useState('');

  const composition = compositionText(value.materials);
  const percentSum = value.materials.reduce((sum, m) => sum + (Number(m.percent) || 0), 0);
  // One press that lands the composition on exactly 100, when one press can.
  const gapFix = percentFix(value.materials);

  const lines = careTextLines(value.careText);
  const trimmedDraft = careLineDraft.trim();
  /** Rows still free, once the tag's overall length is taken into account. */
  const lineRoomLeft = careTextLinesFit([...lines, 'X']) ? CARE_TEXT_MAX_LINES - lines.length : 0;
  const canAddCareLine =
    !!trimmedDraft && !lines.includes(trimmedDraft) && careTextLinesFit([...lines, trimmedDraft]);

  const commitCareLine = () => {
    if (!canAddCareLine) return;
    onChange({ careText: addCareTextLine(value.careText, trimmedDraft) });
    setCareLineDraft('');
  };

  const toggleMaterial = (name: string) => {
    const existing = value.materials.find((m) => m.name === name);
    onChange({
      materials: existing
        ? value.materials.filter((m) => m.name !== name)
        : [...value.materials, { name, percent: 0 }],
    });
  };

  const setMaterialPercent = (name: string, raw: string) => {
    const percent = Math.max(0, Math.min(100, Math.floor(Number(raw) || 0)));
    onChange({
      materials: value.materials.map((m) => (m.name === name ? { ...m, percent } : m)),
    });
  };

  const toggleCareSymbol = (symbol: CareSymbol) => {
    if (value.careSymbols.includes(symbol)) {
      onChange({ careSymbols: value.careSymbols.filter((s) => s !== symbol) });
      return;
    }
    // Wash, bleach, tumble, iron and dry-clean each behave like a radio group:
    // a tag saying both "wash at 30" and "do not wash" is nonsense, and main
    // would refuse it at print time anyway.
    const exclusive = FABRIC_TAG_EXCLUSIVE_CARE_SYMBOL_GROUPS.find((group) =>
      group.includes(symbol),
    );
    const compatible = exclusive
      ? value.careSymbols.filter((selected) => !exclusive.includes(selected))
      : value.careSymbols;
    onChange({
      careSymbols: [...compatible, symbol].sort(
        (a, b) => CARE_SYMBOLS.indexOf(a) - CARE_SYMBOLS.indexOf(b),
      ),
    });
  };

  return (
    <>
      <section className="mb-4 rounded-md border border-slate-200 p-3">
        <h3 className="mb-1 text-sm font-bold text-slate-700">{copy.materials}</h3>
        <p className="mb-2 text-xs text-slate-500">{copy.materialsHint}</p>
        <div className="flex flex-wrap gap-2">
          {FABRIC_MATERIALS.map((name) => {
            const selected = value.materials.find((m) => m.name === name);
            return (
              <div key={name} className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleMaterial(name)}
                  aria-pressed={!!selected}
                  className={`min-h-9 rounded-md border px-2 text-xs font-bold disabled:opacity-40 ${
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
                    disabled={disabled}
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
        {percentSum !== 100 && value.materials.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-xs font-bold text-amber-700">{copy.percentSum(percentSum)}</p>
            {gapFix && (
              <button
                type="button"
                data-testid="fix-percent"
                disabled={disabled}
                onClick={() => onChange({ materials: gapFix.materials })}
                className="min-h-8 rounded-md border border-amber-400 px-2 text-xs font-bold text-amber-800 hover:bg-amber-50 disabled:opacity-40"
              >
                {copy.percentFix(gapFix.name, gapFix.percent)}
              </button>
            )}
          </div>
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
                    disabled={disabled}
                    // Hover text and the accessible name say what the symbol
                    // means; `data-symbol` keeps a stable hook for tests and for
                    // anyone reading the DOM.
                    title={careSymbolLabel(symbol, language)}
                    aria-label={careSymbolLabel(symbol, language)}
                    data-symbol={symbol}
                    onClick={() => toggleCareSymbol(symbol)}
                    aria-pressed={value.careSymbols.includes(symbol)}
                    className={`flex h-11 w-11 items-center justify-center rounded border disabled:opacity-40 ${
                      value.careSymbols.includes(symbol)
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
        {value.careSymbols.length > 0 && (
          <div
            className="mt-2 flex flex-wrap items-center gap-1 text-slate-700"
            data-testid="care-preview"
            aria-label="care preview"
            dangerouslySetInnerHTML={{
              __html: value.careSymbols.map((s) => careSymbolSvg(s, 20)).join(''),
            }}
          />
        )}
        <div className="mt-3">
          <Field label={copy.careText}>
            <div className="flex gap-1.5">
              <input
                className={INPUT}
                value={careLineDraft}
                disabled={disabled}
                aria-label={copy.careText}
                onChange={(e) => setCareLineDraft(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitCareLine();
                  }
                }}
                placeholder={copy.careTextHint}
                maxLength={CARE_TEXT_MAX_CHARS}
              />
              <button
                type="button"
                data-testid="add-care-line"
                onClick={commitCareLine}
                disabled={disabled || !canAddCareLine}
                className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border border-slate-300 px-3 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={14} aria-hidden="true" />
                {copy.careLineAdd}
              </button>
            </div>
          </Field>

          {/* Every line the tag will print, one row each, in printing order —
              so a sentence picked from a chip and a note typed by hand are
              visibly two lines here as well as on the ribbon. */}
          {lines.length > 0 ? (
            <ol className="mt-1.5 space-y-1" data-testid="care-lines">
              {lines.map((line, index) => (
                <li
                  key={`${index}-${line}`}
                  data-care-line={index}
                  className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1"
                >
                  <span className="shrink-0 text-[11px] font-bold uppercase text-slate-400">
                    {copy.careLineNumber(index + 1)}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-xs font-bold text-slate-800">
                    {line}
                  </span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`${copy.careLineRemove} ${index + 1}`}
                    onClick={() => onChange({ careText: removeCareTextLine(value.careText, index) })}
                    className="shrink-0 rounded p-1 text-slate-400 hover:bg-white hover:text-red-600 disabled:opacity-40"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1.5 text-xs text-slate-400" data-testid="care-lines-empty">
              {copy.careLineEmpty}
            </p>
          )}

          {lineRoomLeft === 0 && (
            <p className="mt-1 text-xs font-bold text-amber-700" data-testid="care-lines-full">
              {copy.careLineFull}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {CARE_TEXT_PRESETS.map((preset) => {
              const chosen = careTextHasPreset(value.careText, preset);
              const fits = careTextPresetFits(value.careText, preset);
              return (
                <button
                  key={preset}
                  type="button"
                  disabled={disabled || !fits}
                  data-care-text-preset={preset}
                  aria-pressed={chosen}
                  onClick={() => onChange({ careText: toggleCareTextPreset(value.careText, preset) })}
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
    </>
  );
}
