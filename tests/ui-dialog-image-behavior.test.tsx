// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Modal from '../src/renderer/components/shared/Modal';
import ConfirmActionDialog from '../src/renderer/components/pos/ConfirmActionDialog';
import ProductCard from '../src/renderer/components/pos/ProductCard';

describe('dialog keyboard ownership and image recovery', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const escape = async () => { await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }); };

  it.each([false, true])('only the top dialog handles Escape (busy=%s)', async (busy) => {
    const parent = vi.fn();
    const child = vi.fn();
    await act(async () => root.render(<Modal title="Parent" onClose={parent}>
      <Modal title="Child" zLayer="nested" busy={busy} onClose={child}>Child</Modal>
    </Modal>));
    expect(document.activeElement?.textContent).toContain('Child');
    await escape();
    expect(parent).not.toHaveBeenCalled();
    expect(child).toHaveBeenCalledTimes(busy ? 0 : 1);
  });

  it('a confirmation receives Escape before its parent without confirming the action', async () => {
    const parent = vi.fn();
    const cancel = vi.fn();
    const confirm = vi.fn();
    await act(async () => root.render(<Modal title="Parent" onClose={parent}>
      <ConfirmActionDialog open tier="light" title="Confirm" body="Proceed?" confirmLabel="Yes" cancelLabel="No" onConfirm={confirm} onCancel={cancel} />
    </Modal>));
    await escape();
    expect(cancel).toHaveBeenCalledOnce();
    expect(parent).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('restores focus to the opener after closing and reopening', async () => {
    const opener = document.createElement('button');
    // Keep the opener outside the React root so it survives dialog removal.
    document.body.append(opener);
    opener.focus();
    for (let i = 0; i < 2; i++) {
      await act(async () => root.render(<Modal title="Dialog" onClose={() => {}}>Content</Modal>));
      expect(document.activeElement).not.toBe(opener);
      await act(async () => root.render(null));
      expect(document.activeElement).toBe(opener);
    }
    opener.remove();
  });

  it('keeps an unsaved parent open when Escape targets its child', async () => {
    const guard = vi.fn();
    const child = vi.fn();
    await act(async () => root.render(<Modal title="Parent" guardUnsaved onGuardedClose={guard} onClose={() => {}}>
      <Modal title="Child" zLayer="nested" onClose={child}>Child</Modal>
    </Modal>));
    await escape();
    expect(child).toHaveBeenCalledOnce();
    expect(guard).not.toHaveBeenCalled();
  });

  it('restores the external opener even when the dialog input auto-focuses', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    await act(async () => root.render(<Modal title="Dialog" onClose={() => {}}><input autoFocus /></Modal>));
    expect(document.activeElement).toBe(host.querySelector('input'));
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener); opener.remove();
  });

  it('returns to the parent field after closing a child dialog', async () => {
    const render = (child: boolean) => root.render(<Modal title="Parent" onClose={() => {}}>
      <input aria-label="Parent input" />
      {child && <Modal title="Child" zLayer="nested" onClose={() => {}}>Child</Modal>}
    </Modal>);
    await act(async () => render(false));
    const input = host.querySelector('input')!; input.focus();
    await act(async () => render(true));
    await act(async () => render(false));
    expect(document.activeElement).toBe(input);
  });

  it('lets an input consume Escape without closing its dialog', async () => {
    const close = vi.fn();
    await act(async () => root.render(<Modal title="Dialog" onClose={close}>
      <input onKeyDown={event => event.preventDefault()} />
    </Modal>));
    host.querySelector('input')!.focus();
    await escape();
    expect(close).not.toHaveBeenCalled();
  });

  it('retries a replacement image for the same product after an image error', async () => {
    const product: any = { id: 'product', name: 'Item', retail_price: 100, in_stock: 5, image_url: 'broken.jpg' };
    const render = (image_url: string) => root.render(<ProductCard product={{ ...product, image_url }} onAdd={() => {}} />);
    await act(async () => render('broken.jpg'));
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
    await act(async () => render('replacement.jpg'));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('replacement.jpg');
  });

  it('falls back from a broken thumbnail to the original image', async () => {
    const product: any = { id: 'product', name: 'Item', retail_price: 100, in_stock: 5, thumbnail_url: 'thumbnail.jpg', image_url: 'original.jpg' };
    await act(async () => root.render(<ProductCard product={product} onAdd={() => {}} />));
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')?.getAttribute('src')).toBe('original.jpg');
    await act(async () => { host.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(host.querySelector('img')).toBeNull();
  });
});
