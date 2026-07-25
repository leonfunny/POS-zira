// @vitest-environment happy-dom
/**
 * Contrast + control weight on the dark floor.
 *
 * Asset artwork (salon chair, spa bed, ...) is dark-on-transparent and its
 * label ink was chosen for the light floor, so on the dark floor both the
 * silhouette and the text disappeared. The view-lock button had the opposite
 * problem: it flooded its whole 44px touch target with red and dominated the
 * corner of the room.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraggableTable } from '../src/renderer/components/billiard/DraggableTable';
import type { TableOverview } from '../src/renderer/components/billiard/types';

const chair = (): TableOverview => ({
  resource: {
    id: 'chair-1',
    name: 'Salon Chair',
    metadata: { topViewImage: 'salon-chair' },
    pricingRules: { basePrice: 0 },
  },
  session: null,
  status: 'free',
} as unknown as TableOverview);

function baseProps(table: TableOverview) {
  return {
    table,
    position: { x: 50, y: 50 },
    editMode: false,
    roomWidthM: 16,
    roomHeightM: 10,
    canvasRef: { current: null },
    onDrag: vi.fn(),
    onDragEnd: vi.fn(),
    onTableClick: vi.fn(),
    onRename: vi.fn(),
    language: 'en' as const,
  };
}

describe('billiard dark floor contrast', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  async function render(darkSurface: boolean) {
    await act(async () => {
      root = createRoot(container);
      root.render(<DraggableTable {...baseProps(chair())} darkSurface={darkSurface} />);
    });
  }

  const label = () =>
    Array.from(container.querySelectorAll('span'))
      .find((el) => el.textContent === 'Salon Chair') || null;

  it('gives asset tiles ivory ink and a light silhouette halo on the dark floor', async () => {
    await render(true);

    const name = label();
    expect(name).not.toBeNull();
    expect(name!.className).toContain('text-emerald-50');
    expect(name!.className).not.toContain('text-black');

    // Ivory ink needs a dark halo behind it, not the light-floor white glow.
    const overlay = name!.closest('div');
    expect(overlay?.getAttribute('style') || '').toContain('rgba(0,0,0,0.95)');

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    const filter = (image as HTMLImageElement).style.filter;
    expect(filter).toContain('drop-shadow');
    expect(filter).toContain('255,255,255');
  });

  it('leaves the light floor exactly as it was', async () => {
    await render(false);

    const name = label();
    expect(name!.className).toContain('text-black');

    const overlay = name!.closest('div');
    expect(overlay?.getAttribute('style') || '').toContain('rgba(255,255,255,0.9)');

    // No halo needed: the artwork already contrasts with the ivory floor.
    expect((container.querySelector('img') as HTMLImageElement).style.filter).toBe('');
  });

  it('keeps the 44px lock target while shrinking the red it paints', () => {
    const floor = readFileSync(
      join(__dirname, '../src/renderer/components/billiard/BilliardFloorPlan.tsx'),
      'utf8',
    );

    // Touch target stays per the floor-controls spec...
    expect(floor).toContain('className="flex h-11 w-11');
    // ...but the locked fill is a small chip, not the whole button.
    expect(floor).not.toContain("? 'bg-red-600 text-white hover:bg-red-700'");
    expect(floor).toContain("locked ? 'bg-red-600 text-white' : 'text-slate-700'");
    expect(floor).toContain('flex h-6 w-6 items-center justify-center rounded-md');
  });
});
