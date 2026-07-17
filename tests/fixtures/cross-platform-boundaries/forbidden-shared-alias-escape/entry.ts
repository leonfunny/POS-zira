import { calculateSaleLineTotalGrosze } from '@shared/pos-sale';

export function calculateFixtureTotal(): number {
  return calculateSaleLineTotalGrosze(1, 100);
}
