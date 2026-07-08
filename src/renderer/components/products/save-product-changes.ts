interface MutationResult {
  ok: boolean;
  data?: { variant?: { updatedAt?: string } };
  error?: string;
  code?: string;
}

interface ExecuteProductSaveOptions {
  productDirty: boolean;
  stockDirty: boolean;
  expectedUpdatedAt?: string;
  updateProduct: () => Promise<MutationResult>;
  adjustStock: (expectedUpdatedAt?: string) => Promise<MutationResult>;
}

export type ProductSaveExecutionResult = {
  status: 'success' | 'product-failed' | 'stock-failed';
  productSaved: boolean;
  expectedUpdatedAt?: string;
  error?: string;
};

export async function executeProductSave({
  productDirty,
  stockDirty,
  expectedUpdatedAt,
  updateProduct,
  adjustStock,
}: ExecuteProductSaveOptions): Promise<ProductSaveExecutionResult> {
  let nextExpectedUpdatedAt = expectedUpdatedAt;
  let productSaved = false;

  if (productDirty) {
    const productResult = await updateProduct();
    if (!productResult.ok) {
      return {
        status: 'product-failed',
        productSaved: false,
        expectedUpdatedAt,
        error: productResult.error || productResult.code,
      };
    }
    productSaved = true;
    nextExpectedUpdatedAt = productResult.data?.variant?.updatedAt || nextExpectedUpdatedAt;
  }

  if (stockDirty) {
    const stockResult = await adjustStock(nextExpectedUpdatedAt);
    if (!stockResult.ok) {
      return {
        status: 'stock-failed',
        productSaved,
        expectedUpdatedAt: nextExpectedUpdatedAt,
        error: stockResult.error || stockResult.code,
      };
    }
  }

  return {
    status: 'success',
    productSaved,
    expectedUpdatedAt: nextExpectedUpdatedAt,
  };
}
