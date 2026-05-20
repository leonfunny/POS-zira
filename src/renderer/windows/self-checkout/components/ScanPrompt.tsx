import React from 'react';
import {
  Minus,
  Plus,
  ScanBarcode,
  Search,
} from 'lucide-react';
import type { ScLanguage } from '../i18n';
import { getScStrings } from '../i18n';

interface ScanPromptProps {
  lang: ScLanguage;
  scanQuantity: number;
  onScanQuantityChange: (quantity: number) => void;
  onOpenSearch: () => void;
  toast?: { kind: 'ok' | 'error'; text: string } | null;
  compact?: boolean;
}

export default function ScanPrompt({
  lang,
  scanQuantity,
  onScanQuantityChange,
  onOpenSearch,
  toast,
  compact = false,
}: ScanPromptProps) {
  const t = getScStrings(lang);

  return (
    <div className={`sc-surface sc-scan-panel flex flex-col justify-center ${
      compact ? 'min-h-[170px] p-4' : 'min-h-[250px] p-5 xl:p-6'
    }`}>
      <div className={compact
        ? 'flex items-center gap-4'
        : 'flex flex-col gap-6 xl:flex-row xl:items-center xl:gap-8'}
      >
        <div className={`sc-scan-icon flex shrink-0 items-center justify-center bg-[var(--sc-primary-soft)] text-[var(--sc-primary-deep)] ${
          compact
            ? 'h-16 w-16 rounded-2xl'
            : 'h-24 w-24 rounded-[24px] xl:h-28 xl:w-28 xl:rounded-[30px]'
        }`}>
          <ScanBarcode className={compact ? 'h-10 w-10' : 'h-16 w-16 xl:h-20 xl:w-20'} />
        </div>
        <div className="min-w-0 w-full">
          <h1 className={`sc-scan-title font-black text-[var(--sc-ink)] ${
            compact ? 'text-3xl' : 'text-4xl xl:text-5xl'
          }`}>
            {t.scanPrompt}
          </h1>
          <p className={`sc-scan-hint font-semibold text-[var(--sc-muted)] ${
            compact ? 'mt-1 text-base leading-6' : 'mt-3 text-xl leading-8 xl:text-2xl xl:leading-9'
          }`}>
            {t.scanHint}
          </p>
          <div className={compact ? 'mt-3 flex flex-wrap items-center gap-3' : ''}>
            <div className={`sc-scan-quantity flex items-center border-2 border-[var(--sc-border)] bg-white ${
              compact
                ? 'w-auto gap-2 rounded-2xl p-2'
                : 'mt-5 w-full max-w-[560px] flex-wrap gap-3 rounded-3xl p-3 xl:mt-6 xl:inline-flex xl:w-auto xl:max-w-none xl:flex-nowrap xl:gap-3'
            }`}>
              <div className={compact ? 'min-w-[92px] px-2' : 'min-w-[160px] flex-1 px-3 xl:flex-none'}>
                <div className={`${compact ? 'text-sm' : 'text-base'} font-black text-[var(--sc-ink)]`}>
                  {t.scanQuantity}
                </div>
                <div className={`${compact ? 'hidden' : 'text-sm'} font-semibold text-[var(--sc-muted)]`}>
                  {t.scanQuantityHint}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onScanQuantityChange(scanQuantity - 1)}
                disabled={scanQuantity <= 1}
                className={`sc-focusable flex items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-ink)] disabled:opacity-35 ${
                  compact ? 'h-11 w-11' : 'h-14 w-14 xl:h-16 xl:w-16'
                }`}
                aria-label="-"
              >
                <Minus size={compact ? 24 : 28} />
              </button>
              <div className={`sc-tabular flex items-center justify-center rounded-2xl bg-[var(--sc-primary-soft)] px-5 font-black text-[var(--sc-primary-deep)] ${
                compact ? 'h-11 min-w-[58px] text-2xl' : 'h-14 min-w-[76px] text-3xl xl:h-16 xl:min-w-[88px] xl:text-4xl'
              }`}>
                {scanQuantity}
              </div>
              <button
                type="button"
                onClick={() => onScanQuantityChange(scanQuantity + 1)}
                disabled={scanQuantity >= 99}
                className={`sc-focusable flex items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-[var(--sc-surface-muted)] text-[var(--sc-ink)] disabled:opacity-35 ${
                  compact ? 'h-11 w-11' : 'h-14 w-14 xl:h-16 xl:w-16'
                }`}
                aria-label="+"
              >
                <Plus size={compact ? 24 : 28} />
              </button>
            </div>
            <button
              type="button"
              onClick={onOpenSearch}
              className={`sc-secondary-action sc-focusable flex items-center justify-center gap-3 font-black ${
                compact
                  ? 'min-h-[56px] px-4 text-base'
                  : 'mt-4 w-full max-w-[560px] px-5 py-4 text-xl xl:w-auto'
              }`}
            >
              <Search size={compact ? 22 : 26} />
              {t.manualSearch}
            </button>
          </div>
        </div>
      </div>

      {toast && (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={`${compact ? 'mt-3 rounded-xl px-4 py-2 text-base' : 'mt-8 rounded-2xl px-5 py-4 text-xl'} border font-black ${
            toast.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-[var(--sc-danger)]'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
