/**
 * Total tags a print run will produce. Kept separate so the button can say the
 * number before anything is committed to cloth.
 */
export function totalTagsToPrint(quantities: Record<string, number>): number {
  return Object.values(quantities).reduce((sum, value) => {
    const n = Number(value);
    return sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  }, 0);
}
