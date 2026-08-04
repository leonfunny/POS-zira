/**
 * Re-export. The contract itself moved to src/shared/pos/order-line-contract.ts
 * so the Android shim can import the SAME code instead of copying it — the
 * boundary verifier forbids the shim from reaching into src/main/**.
 */
export {
  getLineSellBy,
  getLineSaleQuantity,
  getLineSaleUnit,
  getLineTotalGrosze,
  shouldDecrementStockAtCheckout,
  buildBackendOrderItem,
  type LocalOrderLineContract,
} from '../../shared/pos/order-line-contract';
