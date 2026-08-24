// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRODUCT_ADMIN_CAPABILITIES_RETRY_DELAYS_MS,
  resetProductAdminCapabilitiesCache,
  useProductAdminCapabilities,
} from '../src/renderer/hooks/useProductAdminCapabilities';
import type { ProductAdminCapabilities } from '../src/shared/types';

const editableCapabilities: ProductAdminCapabilities = {
  version: 5,
  canCreateProduct: true,
  canUpdateProduct: true,
  canEditDisplayName: true,
  canDeactivateProduct: true,
  canAdjustStock: true,
  canCreateCategory: true,
  canUpdateCategory: true,
  canDeleteCategory: true,
  canReplaceCategoryImage: true,
  supportsCategoryImageUpload: true,
  canReorderCategory: true,
  supportsCategoryBatchUpdate: true,
  supportsCategoryKitchenPrint: true,
  supportsCategoryDelta: true,
  canViewPurchasePrice: true,
  canReplaceMainImage: true,
  canReceiveStock: true,
  supportsOptimisticConcurrency: true,
  supportsPurchasePrice: true,
  supportsMainImageUpload: true,
  supportsStockLots: true,
  supportsLotReceiving: true,
  supportsItemType: true,
  canChangeInventoryMode: true,
};

const unavailableCapabilities: ProductAdminCapabilities = {
  ...editableCapabilities,
  version: 0,
  canCreateProduct: false,
  canUpdateProduct: false,
};

const getCapabilities = vi.fn();
let container: HTMLDivElement;
let root: Root;

function CapabilityProbe() {
  const { capabilities, error, loading } = useProductAdminCapabilities(true);
  return (
    <output
      data-editable={capabilities?.canUpdateProduct === true ? 'yes' : 'no'}
      data-loading={loading ? 'yes' : 'no'}
    >
      {error || 'ok'}
    </output>
  );
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  resetProductAdminCapabilitiesCache();
  getCapabilities.mockReset();
  (window as any).electronAPI = {
    pos: { productAdmin: { getCapabilities } },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as any).electronAPI;
  resetProductAdminCapabilitiesCache();
  vi.useRealTimers();
});

describe('product-admin capability recovery', () => {
  it('stays fail-closed, then retries a transient startup failure', async () => {
    getCapabilities
      .mockResolvedValueOnce({
        ok: false,
        capabilities: unavailableCapabilities,
        error: 'fetch failed',
      })
      .mockResolvedValueOnce({
        ok: true,
        capabilities: editableCapabilities,
      });

    await act(async () => {
      root.render(<CapabilityProbe />);
      await Promise.resolve();
    });

    const probe = container.querySelector('output');
    expect(getCapabilities).toHaveBeenCalledTimes(1);
    expect(probe?.dataset.editable).toBe('no');
    expect(probe?.textContent).toBe('fetch failed');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRODUCT_ADMIN_CAPABILITIES_RETRY_DELAYS_MS[0]);
    });

    expect(getCapabilities).toHaveBeenCalledTimes(2);
    expect(probe?.dataset.editable).toBe('yes');
    expect(probe?.dataset.loading).toBe('no');
    expect(probe?.textContent).toBe('ok');
  });
});
