import React, { useCallback, useEffect, useRef } from 'react';
import {
  Hand,
  Image as ImageIcon,
  Loader2,
  PackageSearch,
  Search,
  X,
} from 'lucide-react';
import TouchKeyboard from '../../../components/shared/TouchKeyboard';
import { resolveName } from '../../../../shared/catalog-names';
import { getProductAvailability } from '../catalog-model';
import type { ScLanguage } from '../i18n';
import { getScStrings } from '../i18n';
import type { SearchProduct } from '../types';
import { formatPLN } from '../useScCart';

interface SearchDialogProps {
  lang: ScLanguage;
  inputRef: React.RefObject<HTMLInputElement>;
  query: string;
  searching: boolean;
  touched: boolean;
  error: string | null;
  results: SearchProduct[];
  allowOversell?: boolean;
  onQueryChange: (query: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onAddProduct: (product: SearchProduct) => void;
  onCallStaff: () => void;
}

export default function SearchDialog({
  lang,
  inputRef,
  query,
  searching,
  touched,
  error,
  results,
  allowOversell = false,
  onQueryChange,
  onSubmit,
  onClose,
  onAddProduct,
  onCallStaff,
}: SearchDialogProps) {
  const t = getScStrings(lang);
  const draftQueryRef = useRef(query);

  useEffect(() => {
    draftQueryRef.current = query;
  }, [query]);

  const focusInputSoon = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [inputRef]);

  const setDraftQuery = useCallback((nextQuery: string) => {
    draftQueryRef.current = nextQuery;
    onQueryChange(nextQuery);
    focusInputSoon();
  }, [focusInputSoon, onQueryChange]);

  const handleInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setDraftQuery(event.target.value);
  }, [setDraftQuery]);

  const handleKeyboardKey = useCallback((key: string) => {
    setDraftQuery(`${draftQueryRef.current}${key}`);
  }, [setDraftQuery]);

  const handleKeyboardBackspace = useCallback(() => {
    setDraftQuery(draftQueryRef.current.slice(0, -1));
  }, [setDraftQuery]);

  const handleKeyboardDone = useCallback(() => {
    if (draftQueryRef.current.trim()) onSubmit();
    focusInputSoon();
  }, [focusInputSoon, onSubmit]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.searchProducts}
        className="sc-surface flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden bg-white"
      >
        <div className="flex items-center justify-between border-b border-[var(--sc-border)] px-5 py-4">
          <div className="flex items-center gap-3">
            <Search size={28} className="text-[var(--sc-primary-deep)]" />
            <h2 className="text-2xl font-black text-[var(--sc-ink)]">
              {t.searchProducts}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="sc-focusable flex h-12 w-12 items-center justify-center rounded-2xl border-2 border-[var(--sc-border)] bg-white text-[var(--sc-ink)]"
            aria-label={t.close}
          >
            <X size={26} />
          </button>
        </div>

        <form
          className="border-b border-[var(--sc-border)] p-5"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-3">
            <input
              ref={inputRef}
              value={query}
              onChange={handleInputChange}
              placeholder={t.searchPlaceholder}
              className="sc-focusable h-16 min-w-0 rounded-2xl border-2 border-[var(--sc-border)] bg-white px-5 text-2xl font-bold text-[var(--sc-ink)] outline-none"
              autoComplete="off"
              inputMode="none"
            />
            <button
              type="submit"
              disabled={searching || !query.trim()}
              className="sc-action sc-focusable flex h-16 items-center justify-center gap-2 px-5 text-xl disabled:cursor-not-allowed disabled:opacity-45"
            >
              {searching ? <Loader2 className="animate-spin" size={24} /> : <Search size={24} />}
              {t.manualSearch}
            </button>
          </div>
        </form>

        <div className="min-h-[140px] flex-1 overflow-y-auto p-5">
          <div className="mb-3 text-base font-black uppercase tracking-wide text-[var(--sc-muted)]">
            {t.searchResults}
          </div>
          {error ? (
            <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-5 text-xl font-black text-[var(--sc-danger)]">
              {error}
            </div>
          ) : touched && !searching && results.length === 0 ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-muted)] px-8 text-center">
              <PackageSearch size={54} className="mb-4 text-[var(--sc-border)]" />
              <div className="text-xl font-black text-[var(--sc-ink)]">
                {t.searchNoResults}
              </div>
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="sc-secondary-action sc-focusable px-5 text-base"
                >
                  {t.scanAgain}
                </button>
                <button
                  type="button"
                  onClick={onCallStaff}
                  className="sc-secondary-action sc-focusable flex items-center gap-2 px-5 text-base text-amber-800"
                >
                  <Hand size={20} />
                  {t.callStaff}
                </button>
              </div>
            </div>
          ) : (
            <ul className="space-y-3">
              {results.map((product) => {
                const imageUrl = product.thumbnail_url || product.image_url || '';
                const availability = getProductAvailability(product, { allowOversell });
                const oversoldStock = allowOversell && typeof availability.stock === 'number' && availability.stock <= 0 && availability.reason !== 'no_price';
                const disabledLabel =
                  availability.reason === 'out_of_stock' ? t.soldOut :
                  availability.reason === 'no_price' ? t.noPrice :
                  null;
                const oversoldLabel = oversoldStock
                  ? t.oversoldStock.replace('{stock}', String(availability.stock))
                  : null;
                return (
                  <li
                    key={product.id}
                    className="grid grid-cols-[72px_minmax(0,1fr)_128px] items-center gap-4 rounded-2xl border border-[var(--sc-border)] bg-white p-3"
                  >
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt=""
                        className="h-[72px] w-[72px] rounded-xl object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="flex h-[72px] w-[72px] items-center justify-center rounded-xl bg-[var(--sc-surface-muted)] text-[var(--sc-muted)]">
                        <ImageIcon size={28} />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-xl font-black text-[var(--sc-ink)]">
                        {resolveName(product, lang)}
                      </div>
                      <div className="mt-1 truncate text-sm font-bold text-[var(--sc-muted)]">
                        {[product.barcode, product.sku].filter(Boolean).join(' · ')}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="sc-tabular text-lg font-black text-[var(--sc-primary-deep)]">
                          {formatPLN(availability.priceGrosze)}
                        </span>
                        {disabledLabel && (
                          <span className="rounded-full bg-red-50 px-2 py-1 text-xs font-black uppercase tracking-wide text-[var(--sc-danger)]">
                            {disabledLabel}
                          </span>
                        )}
                        {oversoldLabel && (
                          <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-xs font-black uppercase tracking-wide text-[var(--sc-danger)]">
                            {oversoldLabel}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onAddProduct(product)}
                      disabled={!availability.canAdd}
                      className="sc-action sc-action-success sc-focusable h-14 px-4 text-lg disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {t.addProduct}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div data-self-checkout-touch-keyboard="true">
          <TouchKeyboard
            visible
            mode="full"
            onKey={handleKeyboardKey}
            onBackspace={handleKeyboardBackspace}
            onDone={handleKeyboardDone}
          />
        </div>
      </div>
    </div>
  );
}
