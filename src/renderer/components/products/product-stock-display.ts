export type ProductStockLike = {
  in_stock?: number | null;
  available_qty?: number | null;
};

export type ProductStockDisplay = {
  physical: number;
  available: number;
  differs: boolean;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function productStockDisplay(product: ProductStockLike): ProductStockDisplay {
  const physicalValue = finiteNumber(product.in_stock);
  const availableValue = finiteNumber(product.available_qty);
  const physical = physicalValue ?? availableValue ?? 0;
  const available = availableValue ?? physicalValue ?? 0;

  return {
    physical,
    available,
    differs: physical !== available,
  };
}

export function formatStockQuantity(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/\.?0+$/, '');
}
