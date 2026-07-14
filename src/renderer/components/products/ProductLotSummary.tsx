import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, PackagePlus, RefreshCw } from 'lucide-react';
import type { ProductAdminIpcResult, ProductAdminLotListResponse } from '../../../shared/types';

interface ProductLotSummaryProps {
  variantId: string;
  canReceiveStock: boolean;
  canViewCosts: boolean;
  refreshToken?: number;
  t: (key: string) => string;
  onReceive: () => void;
}

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);
}

function formatMoney(grosze: number | null | undefined): string {
  if (grosze == null || !Number.isFinite(Number(grosze))) return '-';
  return `${(Number(grosze) / 100).toFixed(2)} PLN`;
}

function expiryState(value: string | null | undefined): 'none' | 'expired' | 'soon' | 'ok' {
  if (!value) return 'none';
  const expiry = new Date(`${value.slice(0, 10)}T23:59:59`).getTime();
  if (!Number.isFinite(expiry)) return 'none';
  const now = Date.now();
  if (expiry < now) return 'expired';
  return expiry - now <= 30 * 24 * 60 * 60 * 1000 ? 'soon' : 'ok';
}

type StockLot = ProductAdminLotListResponse['items'][number];

function lotExpiryBadge(lot: Pick<StockLot, 'expirationDate'>, t: (key: string) => string) {
  const state = expiryState(lot.expirationDate);
  if (state === 'none') return null;
  const className = state === 'expired'
    ? 'border-rose-200 bg-rose-50 text-rose-700'
    : state === 'soon'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700';
  const label = state === 'expired'
    ? tOr(t, 'products.lots.expired', 'Expired')
    : state === 'soon'
      ? tOr(t, 'products.lots.expiringSoon', 'Expiring soon')
      : tOr(t, 'products.lots.valid', 'Valid');
  return <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${className}`}>{label}</span>;
}

export default function ProductLotSummary({
  variantId,
  canReceiveStock,
  canViewCosts,
  refreshToken = 0,
  t,
  onReceive,
}: ProductLotSummaryProps) {
  const [data, setData] = useState<ProductAdminLotListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void window.electronAPI.pos.productAdmin.listLots(variantId).then((result: ProductAdminIpcResult<ProductAdminLotListResponse>) => {
      if (!active) return;
      if (!result?.ok || !result.data) {
        setData(null);
        setError(result?.error || result?.code || tOr(tRef.current, 'products.lots.loadFailed', 'Could not load stock lots'));
        return;
      }
      setData(result.data);
    }).catch((loadError: unknown) => {
      if (!active) return;
      setData(null);
      setError(loadError instanceof Error
        ? loadError.message
        : tOr(tRef.current, 'products.lots.loadFailed', 'Could not load stock lots'));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [refreshToken, retryToken, variantId]);

  const activeLots = useMemo(() => (
    [...(data?.items || [])]
      .filter((lot) => Number(lot.quantity) !== 0 || Number(lot.availableQuantity) !== 0)
      .sort((a, b) => {
        if (!a.expirationDate && !b.expirationDate) return String(a.lotNumber || '').localeCompare(String(b.lotNumber || ''));
        if (!a.expirationDate) return 1;
        if (!b.expirationDate) return -1;
        return a.expirationDate.localeCompare(b.expirationDate);
      })
  ), [data]);
  const nearestExpiry = activeLots.find((lot) => !!lot.expirationDate)?.expirationDate || null;

  return (
    <section className="mt-4 rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
            <CalendarClock size={17} className="text-brand-600" />
            {tOr(t, 'products.lots.title', 'Stock lots & expiry')}
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            {tOr(t, 'products.lots.description', 'Expiry belongs to each received batch, not to the product globally.')}
          </p>
        </div>
        {canReceiveStock ? (
          <button
            type="button"
            onClick={onReceive}
            className="inline-flex h-11 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <PackagePlus size={17} />
            {tOr(t, 'products.receive.button', 'Receive batch')}
          </button>
        ) : null}
      </div>

      <div className="p-4">
        {loading ? (
          <div role="status" className="flex min-h-20 items-center justify-center gap-2 text-sm text-slate-500">
            <RefreshCw size={17} className="animate-spin motion-reduce:animate-none" />
            {tOr(t, 'products.lots.loading', 'Loading lots...')}
          </div>
        ) : error ? (
          <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <div>{error}</div>
            <button
              type="button"
              onClick={() => setRetryToken((value) => value + 1)}
              className="mt-2 inline-flex h-11 items-center gap-2 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900 hover:bg-amber-100"
            >
              <RefreshCw size={16} />
              {tOr(t, 'common.retry', 'Retry')}
            </button>
          </div>
        ) : activeLots.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm text-slate-600">
            {tOr(t, 'products.lots.empty', 'No tracked batches yet. Receive stock to attach quantity and expiry to a lot.')}
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <span className="font-semibold">{tOr(t, 'products.lots.nearestExpiry', 'Nearest expiry')}:</span>
              <span className="tabular-nums">{formatDate(nearestExpiry)}</span>
              {nearestExpiry ? lotExpiryBadge({ expirationDate: nearestExpiry }, t) : null}
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {activeLots.map((lot) => (
                <div key={lot.id} className="rounded-md border border-slate-200 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-950">
                        {lot.lotNumber || tOr(t, 'products.lots.unnamed', 'Unnamed lot')}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {tOr(t, 'products.receive.expiry', 'Expiry date')}: {formatDate(lot.expirationDate)}
                      </div>
                    </div>
                    {lotExpiryBadge(lot, t)}
                  </div>
                  <div className={`mt-3 grid gap-2 text-xs ${canViewCosts ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    <div className="rounded-md bg-slate-50 px-2 py-2">
                      <div className="font-semibold uppercase text-slate-500">{tOr(t, 'products.lots.quantity', 'Quantity')}</div>
                      <div className="mt-1 font-semibold tabular-nums text-slate-900">{lot.quantity}</div>
                    </div>
                    <div className="rounded-md bg-slate-50 px-2 py-2">
                      <div className="font-semibold uppercase text-slate-500">{tOr(t, 'products.lots.available', 'Available')}</div>
                      <div className="mt-1 font-semibold tabular-nums text-slate-900">{lot.availableQuantity}</div>
                    </div>
                    {canViewCosts ? (
                      <div className="rounded-md bg-slate-50 px-2 py-2">
                        <div className="font-semibold uppercase text-slate-500">{tOr(t, 'products.lots.unitCost', 'Unit cost')}</div>
                        <div className="mt-1 font-semibold tabular-nums text-slate-900">{formatMoney(lot.unitCostGrosze)}</div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
