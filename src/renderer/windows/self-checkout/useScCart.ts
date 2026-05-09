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
  /** True when added by the bag-fee toggle (UI shows it inline). */
  isBagFee?: boolean;
}

export interface ScCart {
  items: ScCartItem[];
  totalGrosze: number;
  customerNip: string | null;
}

const EMPTY: ScCart = { items: [], totalGrosze: 0, customerNip: null };
const STORAGE_KEY = 'self-checkout:cart';

function recalc(items: ScCartItem[]): ScCart {
  const totalGrosze = items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  return { items, totalGrosze, customerNip: null };
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
        setCart(parsed);
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

  const add = useCallback((item: Omit<ScCartItem, 'quantity'>) => {
    setCart((prev) => {
      const idx = prev.items.findIndex(
        (i) => i.variantId === item.variantId && !i.isBagFee,
      );
      const items = [...prev.items];
      if (idx >= 0) {
        items[idx] = { ...items[idx], quantity: items[idx].quantity + 1 };
      } else {
        items.push({ ...item, quantity: 1 });
      }
      return { ...recalc(items), customerNip: prev.customerNip };
    });
  }, []);

  const setQuantity = useCallback((variantId: string, quantity: number) => {
    setCart((prev) => {
      let items = prev.items.map((i) =>
        i.variantId === variantId ? { ...i, quantity: Math.max(0, quantity) } : i,
      );
      items = items.filter((i) => i.quantity > 0);
      return { ...recalc(items), customerNip: prev.customerNip };
    });
  }, []);

  const remove = useCallback((variantId: string) => {
    setCart((prev) => {
      const items = prev.items.filter((i) => i.variantId !== variantId);
      return { ...recalc(items), customerNip: prev.customerNip };
    });
  }, []);

  const setNip = useCallback((nip: string | null) => {
    setCart((prev) => ({ ...prev, customerNip: nip || null }));
  }, []);

  const clear = useCallback(() => {
    setCart(EMPTY);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { cart, add, setQuantity, remove, setNip, clear };
}

export function formatPLN(grosze: number): string {
  const sign = grosze < 0 ? '-' : '';
  const abs = Math.abs(grosze);
  const zl = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${zl},${cents} zł`;
}
