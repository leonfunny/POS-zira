import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf-8').replace(/\r\n/g, '\n');
}

const warehouseTab = readSource('../src/renderer/components/warehouse/WarehouseModule.tsx');
const warehouseModule = readSource('../src/main/modules/warehouse.module.ts');
const apiClient = readSource('../src/main/network/api-client.ts');
const translations = readSource('../src/renderer/i18n/translations.ts');

function translationBlock(lang: string): string {
  const match = translations.match(new RegExp(`\\n  ${lang}: \\{([\\s\\S]*?)(?=\\n  [a-z]{2}: \\{|\\n\\};)`));
  return match?.[1] || '';
}

describe('Warehouse / Magazyn module contract', () => {
  it('keeps stock-changing warehouse actions fail-closed behind backend availability', () => {
    expect(warehouseTab).toContain('warehouseCapabilities');
    expect(warehouseTab).toContain('supportedDocumentTypes');
    expect(warehouseTab).toContain("const canUseWarehouseBackend = backendStatus === 'ready' && isSelectedTypeSupported;");
    expect(warehouseTab).toContain('const backendActionDisabled = !canUseWarehouseBackend || saving || posting || lines.length === 0;');
    expect(warehouseTab).toContain('const ensureWarehouseBackendReady = (): boolean => {');
    expect(warehouseTab).toContain('if (!ensureWarehouseBackendReady()) return null;');
    expect(warehouseTab).toContain("tOr(t, 'warehouse.contractorRequired'");
    expect(warehouseTab.match(/disabled={backendActionDisabled}/g)).toHaveLength(2);
    expect(warehouseTab.match(/title={backendActionTitle}/g)).toHaveLength(2);
    expect(translations).toContain("'warehouse.backendChecking'");
    expect(translations).toContain("'warehouse.contractUnsupported'");
    expect(translations).toContain("'warehouse.documentUnsupported'");
    expect(translations).toContain("'warehouse.contractorRequired'");
    expect(translations).toContain("'warehouse.unitCost'");
    expect(translations).toContain("'warehouse.sourceDocPlaceholder'");
    expect(translations).toContain("'warehouse.docType.INW'");
    expect(translations).toContain("'warehouse.effect.PZ'");
  });

  it('routes document and inventory mutations to the backend instead of local stock writes', () => {
    expect(warehouseTab).toContain('parseMoneyToGrosze(event.target.value)');
    expect(warehouseTab).toContain('window.electronAPI.warehouse.documents.setLines(created.id, payload.lines || [])');
    expect(warehouseTab).toContain('window.electronAPI.warehouse.inventory.setLines(created.id, buildInventoryLines())');
    expect(warehouseModule).toContain('IPC_CHANNELS.WAREHOUSE_CAPABILITIES');
    expect(apiClient).toContain("async getWarehouseCapabilities(token: string)");
    expect(apiClient).toContain("this.warehouseRequest(token, 'GET', '/capabilities')");
    expect(warehouseModule).toContain('Official posting, numbering, stock movements');
    expect(warehouseModule).toContain('apiClient.createWarehouseDocument(token, payload)');
    expect(warehouseModule).toContain('apiClient.postWarehouseDocument(token, id)');
    expect(warehouseModule).toContain('apiClient.postWarehouseInventory(token, id)');
    expect(warehouseModule).toContain('WAREHOUSE_BACKEND_UNAVAILABLE');
    expect(apiClient).toContain("if (response.status === 404 || response.status === 501) return null;");
    expect(warehouseModule).not.toContain('productRepo');
    expect(warehouseModule).not.toContain('UPDATE product_variants');
    expect(warehouseModule).not.toContain('in_stock =');
  });

  it('keeps warehouse labels localized instead of hard-coded in Polish or English', () => {
    expect(warehouseTab).toContain("labelKey: 'warehouse.docType.INW'");
    expect(warehouseTab).toContain("effectKey: 'warehouse.effect.PZ'");
    expect(warehouseTab).not.toContain("label: 'Spis'");
    expect(warehouseTab).not.toContain('function documentEffectLabel');
    for (const lang of ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl']) {
      const block = translationBlock(lang);
      for (const key of [
        'warehouse.title',
        'warehouse.subtitle',
        'warehouse.sourceDocPlaceholder',
        'warehouse.docType.INW',
        'warehouse.effect.PZ',
        'warehouse.effect.WZ',
        'warehouse.effect.MM',
        'warehouse.contractorRequired',
      ]) {
        expect(block, `${lang} missing ${key}`).toContain(`'${key}'`);
      }
    }
  });
});
