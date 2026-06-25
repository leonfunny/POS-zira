import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const modal = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/QuickAddCameraModal.tsx'),
  'utf8',
);
const cameraStream = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/camera-stream.ts'),
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
const posModule = fs.readFileSync(
  path.resolve(__dirname, '../src/main/modules/pos.module.ts'),
  'utf8',
);
const apiClient = fs.readFileSync(
  path.resolve(__dirname, '../src/main/network/api-client.ts'),
  'utf8',
);

describe('POS quick-add camera flow', () => {
  it('opens from retail quick actions and captures 2-3 camera photos before send', () => {
    expect(quickActions).toContain("label={tOr('pos.quickAdd.camera', 'Camera')}");
    expect(cameraStream).toContain('navigator.mediaDevices.getUserMedia');
    expect(modal).toContain('getSharedEnvironmentCameraStream');
    expect(modal).toContain('images.length < 2');
    expect(modal).toContain('images.length >= 3');
  });

  it('does not start the camera while the modal is hidden', () => {
    expect(modal).toContain('cameraStartPromiseRef');
    expect(modal).toContain('if (!open) {');
    expect(modal).toContain('releaseSharedEnvironmentCameraStream();');
    expect(modal).toContain("open ? '' : 'pointer-events-none opacity-0'");
    expect(modal).toContain("transform: 'translateX(-120vw)'");
    expect(modal).not.toContain('if (!open) return null');
    expect(modal).not.toMatch(/mountedRef\.current = true;\s*void startCamera\(\);/);
    expect(modal).not.toMatch(/setProductName\(result\.analysis\?\.name \?\? ''\);\s*stopCamera\(\);/);
  });

  it('prepares, finalizes, and auto-adds the created variant to cart', () => {
    expect(posLayout).toContain('window.electronAPI.pos.quickAdd.prepare');
    expect(posLayout).toContain('window.electronAPI.pos.quickAdd.finalize');
    expect(posLayout).toContain('name: input.name');
    expect(posLayout).toContain('idempotencyKey: input.idempotencyKey');
    expect(posLayout).toContain('result.variant');
    expect(posLayout).toContain('window.electronAPI.pos.products.getById');
    expect(posLayout).toContain("type: 'cart/addItem'");
  });

  it('lets the cashier review or enter a product name before saving', () => {
    expect(modal).toContain('const [productName, setProductName]');
    expect(modal).toContain("tOr('pos.quickAdd.productName', 'Product name')");
    expect(modal).toContain("tOr('pos.quickAdd.missingName', 'Enter a product name')");
    expect(modal).toContain('name,');
    expect(posModule).not.toContain('AI analysis returned no product name');
    expect(posModule).toContain('normalizeQuickAddAnalysis');
    expect(posModule).toContain('fallbackQuickAddName');
    expect(posModule).toContain('nameNeedsReview');
    expect(posModule).toContain('const finalName = payload.name.trim();');
    expect(posModule).toContain('const variantForLocal = result.variant');
  });

  it('keeps retries idempotent and avoids navigating back after server-side creation', () => {
    expect(modal).toContain('prepareIdempotencyKeyRef');
    expect(modal).toContain('finalizeIdempotencyKeyRef');
    expect(modal).toContain('pos.quickAdd.confirmAbandon');
    expect(modal).not.toContain('onClick={() => setPrepared(null)}');
  });

  it('authenticates quick-add server calls', () => {
    expect(posModule).toContain('const token = getSecureAuthToken();');
    expect(posModule).toContain('apiClient.quickAddUploadImage(token,');
    expect(posModule).toContain('apiClient.quickAddAnalyzeMultiple(token,');
    expect(posModule).toContain('apiClient.quickAddCreate(token,');
    expect(apiClient).toContain('Authorization: `Bearer ${token}`');
  });
});
