// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableActionPopover } from '../src/renderer/components/billiard/TableActionPopover';
import type { TableOverview } from '../src/renderer/components/billiard/types';
import {
  translations,
  type Language,
} from '../src/renderer/i18n/translations';

const offlineReason = 'Connection required to manage table sessions';

function renderProps(table: TableOverview) {
  return {
    table,
    open: true,
    actionsDisabled: true,
    actionsDisabledReason: offlineReason,
    onOpenChange: vi.fn(),
    onStartSession: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onAddItem: vi.fn(),
    onPayment: vi.fn(),
    onTransfer: vi.fn(),
    onUpdateGuestCount: vi.fn(),
    onRemoveItem: vi.fn(),
    onUpdateItemQty: vi.fn(),
    isPending: false,
    language: 'en' as const,
  };
}

describe('billiard offline action guard', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
  });

  async function render(table: TableOverview) {
    await act(async () => {
      root = createRoot(container);
      root.render(<TableActionPopover {...renderProps(table)} />);
    });
  }

  it('shows a clear offline explanation and blocks starting a table', async () => {
    await render({
      resource: { id: 'table-1', name: 'Table 1', pricingRules: { basePrice: 60 } },
      session: null,
      status: 'free',
    });

    expect(container.textContent).toContain(offlineReason);
    const footerButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('footer button'));
    expect(footerButtons).toHaveLength(1);
    expect(footerButtons[0].disabled).toBe(true);
    expect(footerButtons[0].title).toBe(offlineReason);
  });

  it('blocks every server mutation on an active table while keeping the drawer readable', async () => {
    await render({
      resource: { id: 'table-1', name: 'Table 1', pricingRules: { basePrice: 60 } },
      status: 'paused',
      session: {
        id: 'session-1',
        status: 'PAUSED',
        startedAt: new Date().toISOString(),
        guestCount: 2,
        items: [{
          id: 'item-1',
          name: 'Tea',
          quantity: 2,
          unitPrice: 8,
        }],
      },
    });

    const guardedButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(`button[title="${offlineReason}"]`),
    );
    expect(guardedButtons.length).toBeGreaterThanOrEqual(9);
    expect(guardedButtons.every((button) => button.disabled)).toBe(true);
    expect(container.textContent).toContain('Tea');
  });

  it('explains the API guard in every supported POS language', () => {
    const languages: Language[] = ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl'];
    for (const language of languages) {
      expect(translations[language]['billiard.offlineActionNotice']).toBeTruthy();
    }
  });

  it('does not confuse a disconnected realtime socket with an unreachable REST API', () => {
    const floorSource = readFileSync(
      join(__dirname, '../src/renderer/components/billiard/BilliardFloorPlan.tsx'),
      'utf8',
    );
    const syncSource = readFileSync(
      join(__dirname, '../src/main/sync/billiard-sync.ts'),
      'utf8',
    );

    expect(floorSource).toContain('syncStatus?.apiReachable === false');
    expect(floorSource).not.toContain('sessionActionsOffline = syncStatus?.online');
    expect(syncSource).toContain('apiReachable: this.apiReachability.get()');
    expect(syncSource).toContain('this.setApiReachable(true,');
    expect(syncSource).toContain('this.setApiReachable(false,');
  });
});
