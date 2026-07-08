import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('product modal accessibility', () => {
  it('routes every shared Modal close trigger through the guarded close path', () => {
    const modal = source('src/renderer/components/shared/Modal.tsx');

    expect(modal).toContain('const requestClose = useCallback');
    expect(modal).toContain('requestClose();');
    expect(modal.match(/if \(guardUnsaved\)/g)).toHaveLength(1);
  });

  it.each([
    'ProductSearchOverlay.tsx',
    'ProductCreateDialog.tsx',
    'ProductAddFlow.tsx',
    'StockAdjustmentDialog.tsx',
    'DeactivateProductDialog.tsx',
    'CategoryManagerDialog.tsx',
  ])('uses shared Modal in %s', (file) => {
    const dialog = source(`src/renderer/components/products/${file}`);
    expect(dialog).toContain("from '../shared/Modal'");
    expect(dialog).toContain('<Modal');
  });

  it('uses shared Modal for failed local imports', () => {
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    expect(moduleSource).toContain("import Modal from '../shared/Modal'");
    expect(moduleSource).toContain('<Modal');
  });

  it('keeps focused product fields above the measured touch keyboard', () => {
    const modal = source('src/renderer/components/shared/Modal.tsx');
    const createDialog = source('src/renderer/components/products/ProductCreateDialog.tsx');
    const editView = source('src/renderer/components/products/ProductEditView.tsx');
    const keyboardFocusHook = source('src/renderer/hooks/useKeyboardAwareFocus.ts');

    expect(modal).toContain('keyboardAware?: boolean');
    expect(modal).toContain("bottom: 'var(--touch-keyboard-inset, 0px)'");
    expect(modal).toContain("maxHeight: 'calc(100dvh - var(--touch-keyboard-inset, 0px) - 2rem)'");
    expect(modal).toContain('useKeyboardAwareFocus');
    expect(createDialog).toContain('keyboardAware');
    expect(editView).toContain('useKeyboardAwareFocus');
    expect(editView).toContain("height: 'calc(100dvh - var(--touch-keyboard-inset, 0px) - 2rem)'");
    expect(editView).toContain('ref={editScrollRef}');
    expect(editView).toContain('onFocusCapture={handleKeyboardAwareFocus}');
    expect(keyboardFocusHook).toContain('ResizeObserver');
    expect(keyboardFocusHook).toContain("closest('label')");
    expect(keyboardFocusHook).toContain('scrollIntoView');
  });
});
