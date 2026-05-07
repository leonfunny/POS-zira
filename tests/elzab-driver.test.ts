import { describe, expect, it } from 'vitest';
import { ElzabDriver } from '../src/main/hardware/elzab/elzab-driver';
import { MissingElzabBridge, type ElzabBridge } from '../src/main/hardware/elzab/elzab-bridge';
import type { ReceiptData } from '../src/shared/types';

const receipt: ReceiptData = {
  items: [],
  payment: { method: 'CASH', amount: 0 },
  subtotal: 0,
  total: 0,
};

describe('ElzabDriver fail-closed behavior', () => {
  it('returns explicit missing-sidecar errors instead of false success', async () => {
    const driver = new ElzabDriver({
      port: 'COM8',
      bridge: new MissingElzabBridge(),
    });

    await expect(driver.connect()).resolves.toBe(false);
    await expect(driver.getStatus()).resolves.toMatchObject({
      connected: false,
      type: 'ELZAB',
      protocol: 'ELZAB_STX',
      diagnostic: {
        code: 'ELZAB_BRIDGE_NOT_CONFIGURED',
      },
    });
    await expect(driver.printTest()).rejects.toThrow(/ELZAB_BRIDGE_NOT_CONFIGURED/);
    await expect(driver.printReceipt(receipt)).rejects.toThrow(/ELZAB_BRIDGE_NOT_CONFIGURED/);
  });

  it('keeps hardware absence explicit when the sidecar is present but the device is not', async () => {
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({
        ok: false,
        code: 'ELZAB_HARDWARE_NOT_FOUND',
        detail: 'No ELZAB response on COM8',
      }),
      getStatus: async () => ({
        ok: false,
        code: 'ELZAB_HARDWARE_NOT_FOUND',
        detail: 'No ELZAB response on COM8',
      }),
      printTest: async () => ({ ok: false, code: 'ELZAB_HARDWARE_NOT_FOUND' }),
      printReceipt: async () => ({ ok: false, code: 'ELZAB_HARDWARE_NOT_FOUND' }),
    };
    const driver = new ElzabDriver({ port: 'COM8', bridge });

    await expect(driver.connect()).resolves.toBe(false);
    await expect(driver.getStatus()).resolves.toMatchObject({
      connected: false,
      diagnostic: {
        code: 'ELZAB_HARDWARE_NOT_FOUND',
        detail: 'No ELZAB response on COM8',
      },
    });
    await expect(driver.printTest()).rejects.toThrow(/ELZAB_HARDWARE_NOT_FOUND/);
  });

  it('does not pretend reports are supported when the bridge has no report operation', async () => {
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt: async () => ({ ok: true }),
    };
    const driver = new ElzabDriver({ address: '192.168.192.1:9100', bridge });

    await expect(driver.connect()).resolves.toBe(true);
    await expect(driver.printZReport({
      date: '2026-05-06',
      transactionCount: 0,
      grossSales: 0,
      discounts: 0,
      netSales: 0,
    })).rejects.toThrow(/not implemented/);
  });
});
