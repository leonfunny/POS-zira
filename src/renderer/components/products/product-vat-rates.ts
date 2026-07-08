import { useEffect, useState } from 'react';

const FALLBACK_PRODUCT_VAT_RATES = [23, 8, 5, 0];

interface VatRateConfigRow {
  rate?: unknown;
  is_active?: unknown;
  display_order?: unknown;
}

export function resolveProductVatRates(
  rows: VatRateConfigRow[],
  currentRate?: number,
): number[] {
  const configured = rows
    .filter((row) => row.is_active === 1 || row.is_active === true)
    .map((row) => ({ rate: Number(row.rate), order: Number(row.display_order) || 0 }))
    .filter((row) => Number.isFinite(row.rate) && row.rate >= 0)
    .sort((a, b) => a.order - b.order)
    .map((row) => row.rate);
  const rates = [...new Set(configured.length > 0 ? configured : FALLBACK_PRODUCT_VAT_RATES)];
  if (Number.isFinite(currentRate) && Number(currentRate) >= 0 && !rates.includes(Number(currentRate))) {
    rates.push(Number(currentRate));
  }
  return rates;
}

export function useProductVatRates(currentRate?: number): number[] {
  const [rates, setRates] = useState(() => resolveProductVatRates([], currentRate));

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.invoice.vatRates.get()
      .then((result: { success: boolean; data?: VatRateConfigRow[] }) => {
        if (!cancelled) setRates(resolveProductVatRates(result?.success ? result.data || [] : [], currentRate));
      })
      .catch(() => {
        if (!cancelled) setRates(resolveProductVatRates([], currentRate));
      });
    return () => {
      cancelled = true;
    };
  }, [currentRate]);

  return rates;
}
