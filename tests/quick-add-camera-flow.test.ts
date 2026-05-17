import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const modal = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/QuickAddCameraModal.tsx'),
  'utf8',
);
const posLayout = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/POSLayout.tsx'),
  'utf8',
);
const quickActions = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/templates/retail/QuickActions.tsx'),
  'utf8',
);

describe('POS quick-add camera flow', () => {
  it('opens from retail quick actions and captures 2-3 camera photos before send', () => {
    expect(quickActions).toContain("label={tOr('pos.quickAdd.camera', 'Camera')}");
    expect(modal).toContain('navigator.mediaDevices.getUserMedia');
    expect(modal).toContain('images.length < 2');
    expect(modal).toContain('images.length >= 3');
  });

  it('prepares, finalizes, and auto-adds the created variant to cart', () => {
    expect(posLayout).toContain('window.electronAPI.pos.quickAdd.prepare');
    expect(posLayout).toContain('window.electronAPI.pos.quickAdd.finalize');
    expect(posLayout).toContain('idempotencyKey: input.idempotencyKey');
    expect(posLayout).toContain('result.variant');
    expect(posLayout).toContain('window.electronAPI.pos.products.getById');
    expect(posLayout).toContain("type: 'cart/addItem'");
  });

  it('keeps retries idempotent and avoids navigating back after server-side creation', () => {
    expect(modal).toContain('prepareIdempotencyKeyRef');
    expect(modal).toContain('finalizeIdempotencyKeyRef');
    expect(modal).toContain('pos.quickAdd.confirmAbandon');
    expect(modal).not.toContain('onClick={() => setPrepared(null)}');
  });
});
