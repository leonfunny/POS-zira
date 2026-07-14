interface MutationResult {
  ok: boolean;
  data?: { variant?: { updatedAt?: string; canonicalUpdatedAt?: string } };
  error?: string;
  code?: string;
}

function mutationRevision(result: MutationResult, fallback?: string): string | undefined {
  return result.data?.variant?.canonicalUpdatedAt
    || result.data?.variant?.updatedAt
    || fallback;
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
    nextExpectedUpdatedAt = mutationRevision(productResult, nextExpectedUpdatedAt);
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
    nextExpectedUpdatedAt = mutationRevision(stockResult, nextExpectedUpdatedAt);
  }

  return {
    status: 'success',
    productSaved,
    expectedUpdatedAt: nextExpectedUpdatedAt,
  };
}
