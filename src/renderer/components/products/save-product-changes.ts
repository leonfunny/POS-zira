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
    let stockResult: MutationResult;
    try {
      stockResult = await adjustStock(nextExpectedUpdatedAt);
    } catch (error) {
      return {
        status: 'stock-failed',
        productSaved,
        expectedUpdatedAt: nextExpectedUpdatedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!stockResult.ok) {
      return {
        status: 'stock-failed',
        productSaved,
        expectedUpdatedAt: nextExpectedUpdatedAt,
        error: stockResult.error || stockResult.code,
      };
    }
    nextExpectedUpdatedAt = stockResult.data?.variant?.updatedAt || nextExpectedUpdatedAt;
  }

  return {
    status: 'success',
    productSaved,
    expectedUpdatedAt: nextExpectedUpdatedAt,
  };
}
