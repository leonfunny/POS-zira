import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const posLayout = readSource('../src/renderer/components/pos/POSLayout.tsx');
const retailTemplate = readSource('../src/renderer/components/pos/templates/retail/RetailTemplate.tsx');

describe('POS home reset button', () => {
  it('turns the Zira POS header into a home reset button that clears sale state', () => {
    expect(posLayout).toContain('const handleHomeReset = useCallback(() => {');
    expect(posLayout).toContain("dispatch({ type: 'cart/clear' })");
    expect(posLayout).toContain("dispatch({ type: 'customer/clear' })");
    expect(posLayout).toContain("dispatch({ type: 'tip/clear' })");
    expect(posLayout).toContain("dispatch({ type: 'table/setActive', payload: { tableId: null } })");
    expect(posLayout).toContain("dispatch({ type: 'display/setMode', payload: { mode: 'idle' } })");
    expect(posLayout).toContain('onClick={handleHomeReset}');
    expect(posLayout).toContain('<span>Zira POS</span>');
    expect(posLayout).toContain('homeResetKey={homeResetKey}');
  });

  it('resets the retail screen back to the initial category gallery', () => {
    expect(retailTemplate).toContain('homeResetKey?: number');
    expect(retailTemplate).toContain('if (!homeResetKey) return;');
    expect(retailTemplate).toContain("setSearchQuery('')");
    expect(retailTemplate).toContain('setSearchResults([])');
    expect(retailTemplate).toContain('setActiveCategoryId(null)');
    expect(retailTemplate).toContain("setActiveUnitFilter('all')");
    expect(retailTemplate).toContain('setShowPayment(false)');
    expect(retailTemplate).toContain('setShowHistory(false)');
  });
});
