// Self-checkout local cart. Deliberately separate from `usePosStore`:
// the kiosk can't share state with the cashier-driven main POS (which
// is bound to the open shift and the cashier's identity). Each kiosk
// sale is built up here and persisted to localStorage so an Electron
// crash mid-shop doesn't lose the cart.
import { useCallback, useEffect, useState } from 'react';

export interface ScCartItem {
  variantId: string;
  productId?: string;
  name: string;
  sku: string;
  ean?: string;
  price: number; // in grosze
  quantity: number;
  vatRate?: number;
  imageUrl?: string;
  /** Stock snapshot at add time. Used to block the +/scan path from over-ordering
   *  beyond what the catalog reported. `undefined` means stock is not tracked
   *  for this variant and quantity is unconstrained. */
  stockAtAdd?: number;
  /** Display-only translations carried alongside canonical `name`.
   *  Cart row renders via `resolveName`; receipts always use canonical `name`. */
  name_translations?: string | null;
}

export interface ScCart {
  items: ScCartItem[];
  totalGrosze: number;
}

const EMPTY: ScCart = { items: [], totalGrosze: 0 };
const STORAGE_KEY = 'self-checkout:cart';

function isLegacyBagFeeItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Partial<ScCartItem>;
  return candidate.variantId === '__bag-fee__';
}

function recalc(items: ScCartItem[]): ScCart {
  const totalGrosze = items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  return { items, totalGrosze };
}

export function useScCart() {
  const [cart, setCart] = useState<ScCart>(EMPTY);

  // Restore once on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ScCart;
      if (Array.isArray(parsed?.items) && parsed.items.length > 0) {
        const items = parsed.items.filter((item) => !isLegacyBagFeeItem(item));
        if (items.length > 0) setCart(recalc(items));
      }
    } catch {
      /* ignore corrupt cache */
    }
  }, []);

  // Persist on every change.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch {
      /* ignore quota issues */
    }
  }, [cart]);

  const add = useCallback((item: Omit<ScCartItem, 'quantity'>, quantity = 1) => {
    const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
    setCart((prev) => {
      const idx = prev.items.findIndex((i) => i.variantId === item.variantId);
      const items = [...prev.items];
      if (idx >= 0) {
        items[idx] = {
          ...items[idx],
          quantity: items[idx].quantity + safeQuantity,
          stockAtAdd: item.stockAtAdd ?? items[idx].stockAtAdd,
        };
      } else {
        items.push({
          ...item,
          quantity: safeQuantity,
        });
      }
      return recalc(items);
    });
  }, []);

  const setQuantity = useCallback((variantId: string, quantity: number) => {
    setCart((prev) => {
      let items = prev.items.map((i) =>
        i.variantId === variantId
          ? {
              ...i,
              quantity: Math.max(0, quantity),
            }
          : i,
      );
      items = items.filter((i) => i.quantity > 0);
      return recalc(items);
    });
  }, []);

  const remove = useCallback((variantId: string) => {
    setCart((prev) => {
      const items = prev.items.filter((i) => i.variantId !== variantId);
      return recalc(items);
    });
  }, []);

  const clear = useCallback(() => {
    setCart(EMPTY);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { cart, add, setQuantity, remove, clear };
}

export function formatPLN(grosze: number): string {
  const sign = grosze < 0 ? '-' : '';
  const abs = Math.abs(grosze);
  const zl = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${zl},${cents} zł`;
}
