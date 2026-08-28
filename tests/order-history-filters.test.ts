import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/OrderHistoryModal.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('OrderHistoryModal filters', () => {
  it('sends payment and staff filters to the server before pagination', () => {
    expect(source).toContain('const serverFilters: { paymentMethod?: string; staffName?: string; requiresInvoice?: boolean } = {};');
    expect(source).toContain("serverFilters.requiresInvoice = true;");
    expect(source).toContain('serverFilters.paymentMethod = filterMethod;');
    expect(source).toContain('if (filterStaff) serverFilters.staffName = filterStaff;');
    expect(source).toContain('window.electronAPI.pos.orders.getServerList({ period: selectedPeriod, page, limit: PAGE_SIZE, ...serverFilters })');
  });

  it('passes fiscalOnly to local history and does not fiscal-filter local rows after pagination', () => {
    expect(source).toContain('const localHistoryFilters = {');
    expect(source).toContain('fiscalOnly: hideNonFiscalOrders');
    expect(source).toContain('window.electronAPI.pos.orders.getHistory(localHistoryFilters)');
    expect(source).toContain("source: 'unconfigured' as const");
    expect(source).not.toContain('applyFiscalVisibility(merged, true');
    expect(source).not.toContain('getConfirmedFiscalIds?.(unknownIds)');
  });

  it('uses one payment matcher for the renderer-side safety filter', () => {
    expect(source).toContain('function normalizePaymentMethod(method: string | null | undefined): string | null');
    expect(source).toContain("return method === 'TRANSFER' ? 'BANK_TRANSFER' : method;");
    expect(source).toContain('function orderMatchesPaymentFilter(order: OrderRow, paymentMethod: string): boolean');
    expect(source).toContain("if (paymentMethod === 'INVOICE') return Boolean(order.customer_nip);");
    expect(source).toContain('if (filterMethod) merged = merged.filter((o) => orderMatchesPaymentFilter(o, filterMethod));');
    expect(source).not.toContain("o.payment_method === filterMethod && !isSplit(o)");
  });

  it('resets to page 1 immediately when any history filter changes', () => {
    expect(source).toMatch(/const changePaymentFilter = \(nextMethod: string\) => \{\n\s+setPage\(1\);\n\s+setFilterMethod\(nextMethod\);/);
    expect(source).toMatch(/const changeStaffFilter = \(nextStaff: string\) => \{\n\s+setPage\(1\);\n\s+setFilterStaff\(nextStaff\);/);
    expect(source).toContain('onChange={(e) => changePaymentFilter(e.target.value)}');
    expect(source).toContain('onChange={(e) => changeStaffFilter(e.target.value)}');

    // The period is no longer a user control -- history is today-only -- so
    // there is no changePeriod handler to assert. The catch-all effect below
    // is what now guarantees the invariant for every filter, including the
    // ones that change without going through a handler at all
    // (hideNonFiscalOrders comes from config).
    const effect = source.match(/useEffect\(\(\) => \{ setPage\(1\); \}, \[([^\]]+)\]\);/);
    expect(effect, 'page-reset effect not found').not.toBeNull();
    const deps = effect![1].split(',').map((dep) => dep.trim());
    expect(deps).toContain('selectedPeriod');
    expect(deps).toContain('filterMethod');
    expect(deps).toContain('filterStaff');
    expect(deps).toContain('hideNonFiscalOrders');
  });

  it('ignores stale history loads that return after a newer filter request', () => {
    expect(source).toContain('const loadSeqRef = useRef(0);');
    expect(source).toContain('const loadSeq = loadSeqRef.current + 1;');
    expect(source).toContain('loadSeqRef.current = loadSeq;');
    expect(source).toContain('if (loadSeq !== loadSeqRef.current) return;');
  });
});
