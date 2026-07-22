// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenameFloorDialog } from '../src/renderer/components/billiard/RenameFloorDialog';

describe('RenameFloorDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('edits the existing floor name and submits the trimmed new value', async () => {
    const onSave = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(
        <RenameFloorDialog
          open
          floorName="Tầng 2"
          isPending={false}
          language="vi"
          onOpenChange={vi.fn()}
          onSave={onSave}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('#rename-floor-name');
    const saveButton = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(input?.value).toBe('Tầng 2');
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setValue?.call(input, '  Lầu VIP  ');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(saveButton?.disabled).toBe(false);

    await act(async () => {
      saveButton!.click();
    });
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith('Lầu VIP');
  });

  it('closes on Escape when no rename request is pending', async () => {
    const onOpenChange = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(
        <RenameFloorDialog
          open
          floorName="Tầng 2"
          isPending={false}
          language="vi"
          onOpenChange={onOpenChange}
          onSave={vi.fn()}
        />,
      );
    });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
