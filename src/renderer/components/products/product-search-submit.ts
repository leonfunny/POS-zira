export function getSearchSubmitResult<T>(products: T[]): T | null {
  return products[0] ?? null;
}
