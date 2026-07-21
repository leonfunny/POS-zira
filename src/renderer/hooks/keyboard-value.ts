/**
 * Value editing for type=number inputs driven by the touch numpad. Cashiers
 * expect to type OVER the old value after focusing a field (no backspacing),
 * and a leading zero must never survive ("042").
 */
export function nextNumberAppend(current: string, key: string, fresh: boolean): string {
  const base = fresh ? '' : String(current ?? '');
  return (base + key).replace(/^0+(?=\d)/, '');
}

export function nextNumberBackspace(current: string): string {
  return String(current ?? '').slice(0, -1);
}
