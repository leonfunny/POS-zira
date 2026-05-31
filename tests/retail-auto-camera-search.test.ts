import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const retailTemplate = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/templates/retail/RetailTemplate.tsx'),
  'utf8',
);
const autoCameraSearch = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/AutoCameraSearch.tsx'),
  'utf8',
);
const posLayout = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/POSLayout.tsx'),
  'utf8',
);

describe('retail auto camera search', () => {
  it('adds a hidden stable-frame detector behind an explicit Auto button', () => {
    expect(retailTemplate).toContain('const [autoCameraEnabled, setAutoCameraEnabled]');
    expect(retailTemplate).toContain('<AutoCameraSearch');
    expect(retailTemplate).toContain("tOr('pos.autoCamera.button', 'Auto')");
    expect(autoCameraSearch).toContain('MOTION_DIFF_THRESHOLD');
    expect(autoCameraSearch).toContain('STABLE_FRAME_COUNT');
    expect(autoCameraSearch).toContain('OBJECT_DIFF_THRESHOLD');
    expect(autoCameraSearch).toContain('getSharedEnvironmentCameraStream');
  });

  it('recognizes, searches local products, and sells through the weighted-aware cart path', () => {
    expect(retailTemplate).toContain('window.electronAPI.pos.recognition.analyze');
    expect(retailTemplate).toContain('window.electronAPI.pos.products.getByBarcode');
    expect(retailTemplate).toContain('window.electronAPI.pos.products.search');
    expect(retailTemplate).toContain("await handleAddProduct(product, 'auto')");
    expect(retailTemplate).toContain("setAutoCameraResult(tOr('pos.autoCamera.chooseMatch', 'Choose item'))");
  });

  it('lets manual cart actions cancel stale auto recognition results', () => {
    expect(retailTemplate).toContain('autoCameraRunIdRef');
    expect(retailTemplate).toContain('const stale = () => runId !== autoCameraRunIdRef.current || !autoCameraEnabledRef.current');
    expect(retailTemplate).toContain('interruptAutoCamera();');
    expect(retailTemplate).toContain('pos:manual-cart-action');
    expect(retailTemplate).toContain('AUTO_CAMERA_SCALE_TIMEOUT_MS');
  });

  it('keeps hidden camera surfaces from blocking barcode focus', () => {
    expect(posLayout).toContain('.fixed.inset-0.z-50:not([aria-hidden="true"])');
    expect(posLayout).toContain("document.dispatchEvent(new CustomEvent('pos:manual-cart-action'))");
  });
});
