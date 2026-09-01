// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/renderer/utils/logger', () => ({ default: logger }));

import FabricArtworkPanel from '../src/renderer/components/label/FabricArtworkPanel';
import type { FabricTagArtwork } from '../src/shared/types';

const readyArtwork: FabricTagArtwork = {
  id: 'asset-ready',
  salonId: 'salon-a',
  customerName: 'Customer A',
  orderCode: 'ORDER-7',
  variant: 'S/M',
  revision: 'r1',
  originalFilename: 'customer-label.btw',
  sourceType: 'BTW',
  status: 'READY',
  sourceSha256: 'a'.repeat(64),
  productionFilename: 'customer-label.png',
  productionSha256: 'b'.repeat(64),
  widthPx: 160,
  heightPx: 160,
  physicalWidthMm: 20,
  physicalLengthMm: 20,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  retiredAt: null,
};

async function settle(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => Promise.resolve());
  }
}

describe('fabric artwork renderer bridge boundary', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.clearAllMocks();
    root = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
  });

  async function renderPanel(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<FabricArtworkPanel language="vi" />);
    });
    await settle();
  }

  it('renders a safe unavailable panel when the binding is entirely missing', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    await expect(renderPanel()).resolves.toBeUndefined();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Chưa có kết nối quản lý file mác vải');
    expect(alert?.textContent).toContain('Tem mã sản phẩm / EAN vẫn dùng được');
  });

  it('fails closed without calling a partial bridge that could crash mid-workflow', async () => {
    const list = vi.fn(async () => []);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { pos: { fabricTagArtworks: { list } } },
    });

    await expect(renderPanel()).resolves.toBeUndefined();

    expect(list).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Chưa có kết nối quản lý file mác vải');
  });

  it('shows the exact production PNG contract to VI, PL, and EN staff', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        pos: {
          fabricTagArtworks: {
            list: vi.fn(async () => []),
            importSource: vi.fn(async () => null),
            attachProduction: vi.fn(async () => null),
            getPreview: vi.fn(async () => null),
            retire: vi.fn(async () => null),
            print: vi.fn(async () => ({ success: true })),
          },
        },
      },
    });

    const expectations = [
      ['vi', 'rộng đúng 160 px, cao 80–480 px, mỗi mép trái/phải trắng 9 px; vùng in giữa 142 px. Khổ 20 mm ở 203 dpi, không co giãn.'],
      ['pl', 'dokładnie 160 px szerokości, 80–480 px wysokości, po 9 px białego marginesu z lewej i prawej; środkowy obszar druku ma 142 px. Format 20 mm przy 203 dpi, bez skalowania.'],
      ['en', 'exactly 160 px wide, 80–480 px high, with 9 px of white margin on both the left and right; the printable center is 142 px. 20 mm at 203 dpi, with no scaling.'],
    ] as const;

    for (const [language, expected] of expectations) {
      await act(async () => {
        if (!root) root = createRoot(container);
        root.render(<FabricArtworkPanel language={language} />);
      });
      await settle();
      expect(container.textContent).toContain(expected);
    }
  });

  it('chunks 120 as 50, 50, 20 and waits for one latched operator decision between deferred jobs', async () => {
    const completions: Array<(result: { success: boolean }) => void> = [];
    const print = vi.fn(() => {
      if (completions.length < 2) {
        return new Promise<{ success: boolean }>((resolve) => {
          completions.push(resolve);
        });
      }
      return Promise.resolve({ success: true });
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        pos: {
          fabricTagArtworks: {
            list: vi.fn(async () => [readyArtwork]),
            importSource: vi.fn(async () => null),
            attachProduction: vi.fn(async () => null),
            getPreview: vi.fn(async () => null),
            retire: vi.fn(async () => null),
            print,
          },
        },
      },
    });

    await renderPanel();
    const selected = container.querySelector<HTMLInputElement>(
      'input[aria-label="Chọn để in: S/M"]',
    );
    expect(selected?.disabled).toBe(false);
    await act(async () => selected?.click());

    const quantity = container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(quantity?.disabled).toBe(false);
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(quantity, '120');
      quantity?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const request = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('In các dòng đã chọn (120)'));
    expect(request).toBeDefined();
    await act(async () => request?.click());

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Xác nhận số lượng lớn');
    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') || [])
      .find((button) => button.textContent?.trim() === 'Xác nhận in');
    expect(confirm).toBeDefined();
    await act(async () => {
      // Both events fire before React can disable/unmount the button. The ref
      // latch must reject the second physical run synchronously.
      confirm?.click();
      confirm?.click();
    });
    await settle();

    expect(print).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Tiếp tục đợt kế tiếp');
    await act(async () => completions[0]({ success: true }));
    await settle();

    expect(print.mock.calls.map(([request]) => request)).toEqual([
      { assetId: 'asset-ready', quantity: 50 },
    ]);
    expect(container.textContent).toContain('Tiếp tục đợt kế tiếp');
    const firstContinue = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Tiếp tục đợt kế tiếp');
    await act(async () => {
      // A double click can release only the current decision latch.
      firstContinue?.click();
      firstContinue?.click();
    });
    await settle();

    expect(print).toHaveBeenCalledTimes(2);
    expect(print.mock.calls[1]?.[0]).toEqual({ assetId: 'asset-ready', quantity: 50 });
    await act(async () => completions[1]({ success: true }));
    await settle();

    expect(print).toHaveBeenCalledTimes(2);
    const secondContinue = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Tiếp tục đợt kế tiếp');
    await act(async () => secondContinue?.click());
    await settle(6);

    expect(print.mock.calls.map(([request]) => request)).toEqual([
      { assetId: 'asset-ready', quantity: 50 },
      { assetId: 'asset-ready', quantity: 50 },
      { assetId: 'asset-ready', quantity: 20 },
    ]);
    expect(print).not.toHaveBeenCalledWith({ assetId: 'asset-ready', quantity: 120 });
    expect(container.textContent).toContain('Đã gửi đủ 120 mác đến máy in');
  });

  it('stops at an inter-chunk pause without submitting the next chunk', async () => {
    const print = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        pos: {
          fabricTagArtworks: {
            list: vi.fn(async () => [readyArtwork]),
            importSource: vi.fn(async () => null),
            attachProduction: vi.fn(async () => null),
            getPreview: vi.fn(async () => null),
            retire: vi.fn(async () => null),
            print,
          },
        },
      },
    });

    await renderPanel();
    await act(async () => container.querySelector<HTMLInputElement>(
      'input[aria-label="Chọn để in: S/M"]',
    )?.click());
    const quantity = container.querySelector<HTMLInputElement>('input[type="number"]');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(quantity, '60');
      quantity?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const request = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('In các dòng đã chọn (60)'));
    await act(async () => request?.click());
    await settle();

    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith({ assetId: 'asset-ready', quantity: 50 });
    const stop = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Dừng tại đây');
    await act(async () => stop?.click());
    await settle();

    expect(print).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Đã dừng sau 1/2 đợt');
  });
});
