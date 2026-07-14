import { useCallback, useEffect, useState } from 'react';
import type { CartItem, PosAction } from './usePosStore';
import type { NumpadMode } from '../components/pos/POSNumpad';
import { normalizeSellBy } from '../../shared/pos-sale';

export type NumpadTarget =
  | { kind: 'payment' }
  | { kind: 'cartItem'; itemId: string; itemName: string; field: 'qty' | 'price'; sellBy?: string | null }
  | { kind: 'discount' };

const MAX_BUFFER_LEN = 9;

export function appendDigit(buf: string, digit: string): string {
  if (buf.length >= MAX_BUFFER_LEN) return buf;
  if (buf === '0') return digit;
  return buf + digit;
}

export function appendDecimal(buf: string, mode: NumpadMode): string {
  if (mode === 'qty') return buf;
  if (buf.includes('.')) return buf;
  if (buf.length === 0) return '0.';
  if (buf.length >= MAX_BUFFER_LEN) return buf;
  return buf + '.';
}

export function appendDoubleZero(buf: string, mode: NumpadMode): string {
  if (mode === 'qty') return buf;
  if (buf.length === 0) return '0';
  if (buf.length >= MAX_BUFFER_LEN - 1) return buf;
  const dotIdx = buf.indexOf('.');
  if (dotIdx >= 0 && buf.length - dotIdx - 1 >= 2) return buf;
  return buf + '00';
}

export function backspace(buf: string): string {
  return buf.slice(0, -1);
}

export function parseBufferGrosze(buf: string): number {
  if (!buf) return 0;
  const f = parseFloat(buf);
  if (!Number.isFinite(f)) return 0;
  return Math.round(f * 100);
}

export function parseBufferInt(buf: string): number {
  if (!buf) return 0;
  const n = parseInt(buf, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseBufferQuantity(buf: string): number {
  if (!buf) return 0;
  const n = parseFloat(buf);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function modeForTarget(target: NumpadTarget): NumpadMode {
  if (target.kind === 'payment') return 'cash';
  if (target.kind === 'discount') return 'discount';
  if (target.kind === 'cartItem' && target.field === 'qty' && normalizeSellBy(target.sellBy) === 'WEIGHT') return 'weight';
  if (target.kind === 'cartItem' && target.field === 'qty') return 'qty';
  return 'price';
}

export interface POSNumpadController {
  buffer: string;
  mode: NumpadMode;
  target: NumpadTarget;
  isPercent: boolean;

  selectCartItem: (item: CartItem, field: 'qty' | 'price') => void;
  selectDiscount: () => void;
  selectPayment: () => void;

  pressDigit: (d: string) => void;
  pressDecimal: () => void;
  pressDoubleZero: () => void;
  pressBackspace: () => void;
  pressClear: () => void;
  pressTogglePercent: () => void;
  pressPreset: (grosze: number) => void;
  pressExact: (totalGrosze: number) => void;
  pressDone: () => void;
}

interface ControllerOptions {
  dispatch: (action: PosAction) => void;
  onPaymentBufferChange?: (grosze: number) => void;
  onPaymentConfirm?: (grosze: number) => void;
}

export function usePOSNumpadController({
  dispatch,
  onPaymentBufferChange,
  onPaymentConfirm,
}: ControllerOptions): POSNumpadController {
  const [buffer, setBuffer] = useState('');
  const [target, setTarget] = useState<NumpadTarget>({ kind: 'payment' });
  const [isPercent, setIsPercent] = useState(false);

  const mode = modeForTarget(target);

  useEffect(() => {
    if (target.kind === 'payment') {
      onPaymentBufferChange?.(parseBufferGrosze(buffer));
    }
  }, [buffer, target, onPaymentBufferChange]);

  const commit = useCallback((
    currentTarget: NumpadTarget,
    currentBuffer: string,
    currentPercent: boolean,
    confirmPayment = false,
  ) => {
    if (!currentBuffer) return;

    if (currentTarget.kind === 'cartItem') {
      if (currentTarget.field === 'qty') {
        const qty = parseBufferQuantity(currentBuffer);
        if (normalizeSellBy(currentTarget.sellBy) === 'PIECE' && !Number.isInteger(qty)) return;
        if (qty > 0) dispatch({ type: 'cart/updateQuantity', payload: { id: currentTarget.itemId, quantity: qty } });
      } else {
        const price = parseBufferGrosze(currentBuffer);
        if (price >= 0) dispatch({ type: 'cart/setItemPrice', payload: { id: currentTarget.itemId, price } });
      }
    } else if (currentTarget.kind === 'discount') {
      const value = currentPercent ? parseFloat(currentBuffer) : parseBufferGrosze(currentBuffer);
      if (Number.isFinite(value) && value > 0) {
        dispatch({
          type: 'cart/applyDiscount',
          payload: { amount: currentPercent ? value : Math.round(value), discountType: currentPercent ? 'percentage' : 'fixed' },
        });
      }
    } else if (currentTarget.kind === 'payment' && confirmPayment) {
      onPaymentConfirm?.(parseBufferGrosze(currentBuffer));
    }
  }, [dispatch, onPaymentConfirm]);

  const selectCartItem = useCallback((item: CartItem, field: 'qty' | 'price') => {
    if (target.kind === 'cartItem' && target.itemId === item.id && target.field === field) {
      return;
    }
    commit(target, buffer, isPercent);
    setTarget({ kind: 'cartItem', itemId: item.id, itemName: item.name, field, sellBy: item.sellBy ?? null });
    setBuffer('');
  }, [target, buffer, isPercent, commit]);

  const selectDiscount = useCallback(() => {
    setTarget((prev) => {
      commit(prev, buffer, isPercent);
      return { kind: 'discount' };
    });
    setBuffer('');
  }, [buffer, isPercent, commit]);

  const selectPayment = useCallback(() => {
    setTarget((prev) => {
      commit(prev, buffer, isPercent);
      return { kind: 'payment' };
    });
    setBuffer('');
    setIsPercent(false);
  }, [buffer, isPercent, commit]);

  const pressDigit = useCallback((d: string) => {
    setBuffer((b) => appendDigit(b, d));
  }, []);

  const pressDecimal = useCallback(() => {
    setBuffer((b) => appendDecimal(b, mode));
  }, [mode]);

  const pressDoubleZero = useCallback(() => {
    setBuffer((b) => appendDoubleZero(b, mode));
  }, [mode]);

  const pressBackspace = useCallback(() => {
    setBuffer((b) => backspace(b));
  }, []);

  const pressClear = useCallback(() => {
    setBuffer('');
  }, []);

  const pressTogglePercent = useCallback(() => {
    if (target.kind !== 'discount') return;
    setIsPercent((p) => !p);
    setBuffer('');
  }, [target.kind]);

  const pressPreset = useCallback((grosze: number) => {
    setBuffer((grosze / 100).toFixed(2));
  }, []);

  const pressExact = useCallback((totalGrosze: number) => {
    setBuffer((totalGrosze / 100).toFixed(2));
  }, []);

  const pressDone = useCallback(() => {
    commit(target, buffer, isPercent, true);
    setBuffer('');
    if (target.kind !== 'payment') {
      setTarget({ kind: 'payment' });
      setIsPercent(false);
    }
  }, [target, buffer, isPercent, commit]);

  return {
    buffer,
    mode,
    target,
    isPercent,
    selectCartItem,
    selectDiscount,
    selectPayment,
    pressDigit,
    pressDecimal,
    pressDoubleZero,
    pressBackspace,
    pressClear,
    pressTogglePercent,
    pressPreset,
    pressExact,
    pressDone,
  };
}
