import { describe, expect, it, vi } from 'vitest';
import { SERVICE_TOKENS } from '../src/main/core/tokens';
import { notifyPosRenderers } from '../src/main/windows/notify-pos-renderers';

function makeWindow(id: number, destroyed = false) {
  return {
    id,
    isDestroyed: () => destroyed,
    webContents: {
      send: vi.fn(),
    },
  };
}

describe('notifyPosRenderers', () => {
  it('notifies both the main POS surface and standalone POS window', () => {
    const main = makeWindow(1);
    const standalone = makeWindow(2);
    const container = {
      getOptional: vi.fn((token: string) => {
        if (token === SERVICE_TOKENS.MAIN_WINDOW) return main;
        if (token === SERVICE_TOKENS.WINDOW_MANAGER) {
          return { getWindow: vi.fn(() => standalone) };
        }
        return undefined;
      }),
    };

    notifyPosRenderers(container as any, 'pos:products-synced');

    expect(main.webContents.send).toHaveBeenCalledWith('pos:products-synced', undefined);
    expect(standalone.webContents.send).toHaveBeenCalledWith('pos:products-synced', undefined);
  });

  it('deduplicates when main and standalone POS are the same BrowserWindow', () => {
    const win = makeWindow(1);
    const container = {
      getOptional: vi.fn((token: string) => {
        if (token === SERVICE_TOKENS.MAIN_WINDOW) return win;
        if (token === SERVICE_TOKENS.WINDOW_MANAGER) {
          return { getWindow: vi.fn(() => win) };
        }
        return undefined;
      }),
    };

    notifyPosRenderers(container as any, 'pos:stock-updated', { variantId: 'v1' });

    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('pos:stock-updated', { variantId: 'v1' });
  });
});
