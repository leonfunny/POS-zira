import { calculateTotal } from './money';

export function calculateFixtureTotal(): number {
  return calculateTotal([
    { quantity: 2, unitPrice: 450 },
    { quantity: 1, unitPrice: 125 },
  ]);
}
