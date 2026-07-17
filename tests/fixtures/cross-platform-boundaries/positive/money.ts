export type LineItem = {
  quantity: number;
  unitPrice: number;
};

export function calculateTotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}
