import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stockAdjustmentModes } from '../src/renderer/components/products/StockAdjustmentDialog';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('product workspace stock adjustment gates', () => {
  it('removes legacy receive when lot-aware receiving is supported', () => {
    expect(stockAdjustmentModes({ allowReceive: false }).map((mode) => mode.value))
      .not.toContain('receive');
    expect(stockAdjustmentModes({ allowReceive: true }).map((mode) => mode.value))
      .toContain('receive');
  });

  it('passes the raw lot-receiving capability through the edit view', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const editViewSource = source('src/renderer/components/products/ProductEditView.tsx');

    expect(moduleSource).toContain('supportsLotReceiving={adminCapabilities?.supportsLotReceiving === true}');
    expect(editViewSource).toContain('allowReceive={!supportsLotReceiving}');
  });

  it('rejects legacy receive at the main-process boundary for lot-aware tenants', () => {
    const mainSource = source('src/main/modules/pos.module.ts');
    const handlerStart = mainSource.indexOf('IPC_CHANNELS.POS_PRODUCT_ADMIN_ADJUST_STOCK');
    const handlerEnd = mainSource.indexOf('IPC_CHANNELS.POS_PRODUCT_ADMIN_GET_VARIANT', handlerStart);
    const handler = mainSource.slice(handlerStart, handlerEnd);
    const rejection = "requestPayload.mode === 'receive' && capabilities.supportsLotReceiving === true";

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain(rejection);
    expect(handler.indexOf(rejection)).toBeLessThan(handler.indexOf("mutationType: 'ADJUST_STOCK'"));
  });
});
