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
  /** True when added by the local bag-quantity control (UI shows it inline). */
  isBagFee?: boolean;
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
const MAX_BAG_QUANTITY = 9;

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
        setCart(recalc(parsed.items));
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
      const idx = prev.items.findIndex((i) =>
        item.isBagFee
          ? i.variantId === item.variantId && i.isBagFee
          : i.variantId === item.variantId && !i.isBagFee,
      );
      const items = [...prev.items];
      if (idx >= 0) {
        items[idx] = item.isBagFee
          ? { ...items[idx], ...item, quantity: Math.min(MAX_BAG_QUANTITY, safeQuantity) }
          : { ...items[idx], quantity: items[idx].quantity + safeQuantity };
      } else {
        items.push({
          ...item,
          quantity: item.isBagFee ? Math.min(MAX_BAG_QUANTITY, safeQuantity) : safeQuantity,
        });
      }
      return recalc(items);
    });
  }, []);

  const setBagQuantity = useCallback((quantity: number, price: number) => {
    const safeQuantity = Math.min(
      MAX_BAG_QUANTITY,
      Math.max(0, Math.floor(Number(quantity) || 0)),
    );
    setCart((prev) => {
      const items = prev.items.filter((i) => !i.isBagFee);
      if (safeQuantity > 0 && price > 0) {
        items.push({
          variantId: '__bag-fee__',
          name: 'Torba foliowa',
          sku: 'BAG',
          price,
          quantity: safeQuantity,
          isBagFee: true,
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
              quantity: i.isBagFee
                ? Math.min(MAX_BAG_QUANTITY, Math.max(0, quantity))
                : Math.max(0, quantity),
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

  return { cart, add, setQuantity, remove, setBagQuantity, clear };
}

export function formatPLN(grosze: number): string {
  const sign = grosze < 0 ? '-' : '';
  const abs = Math.abs(grosze);
  const zl = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${zl},${cents} zł`;
}
