// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFreeformDrag } from '../src/renderer/components/billiard/hooks/useFreeformDrag';

describe('floor drag lifecycle', () => {
  let host: HTMLDivElement;
  let root: Root;
  let drag: ReturnType<typeof useFreeformDrag>;
  let move: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;
  const canvas = { current: { getBoundingClientRect: () => ({ width: 1000, height: 1000 }) } } as any;
  const target = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() };
  const pointer = (x: number, pointerId = 1) => ({ button: 0, clientX: x, clientY: 0, pointerId, currentTarget: target }) as any;
  function Harness({ enabled = true }: { enabled?: boolean }) {
    drag = useFreeformDrag({ id: 'table', canvasRef: canvas, posX: 20, posY: 20, roomWidthM: 10, roomHeightM: 10, enabled, onDrag: move, onDragEnd: save, onDragCancel: cancel });
    return <span>{String(drag.isDragging)}</span>;
  }
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    move = vi.fn(); save = vi.fn(); cancel = vi.fn();
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const start = async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => drag.dragHandlers.onPointerDown(pointer(0)));
    await act(async () => drag.dragHandlers.onPointerMove(pointer(100)));
    expect(move).toHaveBeenCalled();
    expect(host.textContent).toBe('true');
  };
  it.each(['onPointerCancel', 'onLostPointerCapture'] as const)('%s rolls back without saving', async (event) => {
    await start();
    await act(async () => drag.dragHandlers[event](pointer(100)));
    await act(async () => drag.dragHandlers.onPointerUp(pointer(100)));
    expect(cancel).toHaveBeenCalledExactlyOnceWith('table');
    expect(save).not.toHaveBeenCalled(); expect(host.textContent).toBe('false');
  });
  it('a normal pointerup saves once and subsequent lost capture does not roll back', async () => {
    await start();
    await act(async () => drag.dragHandlers.onPointerUp(pointer(100)));
    await act(async () => drag.dragHandlers.onLostPointerCapture(pointer(100)));
    expect(save).toHaveBeenCalledExactlyOnceWith('table', 30, 20);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('leaving edit mode rolls back the active drag', async () => {
    await start();
    await act(async () => root.render(<Harness enabled={false} />));
    expect(cancel).toHaveBeenCalledExactlyOnceWith('table');
    expect(save).not.toHaveBeenCalled(); expect(host.textContent).toBe('false');
  });
  it('unmount rolls back the active drag', async () => {
    await start();
    await act(async () => root.render(null));
    expect(cancel).toHaveBeenCalledExactlyOnceWith('table'); expect(save).not.toHaveBeenCalled();
  });
  it('ignores a different pointer', async () => {
    await start();
    await act(async () => drag.dragHandlers.onPointerCancel(pointer(100, 2)));
    expect(cancel).not.toHaveBeenCalled(); expect(host.textContent).toBe('true');
  });
});
