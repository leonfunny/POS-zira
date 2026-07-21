import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { migrations } from '../src/main/database/migrations';
import {
  billiardPaymentPayload,
  billiardTransferPayload,
  buildBilliardAvailabilityPath,
  buildBilliardBookingStartsAt,
  buildBilliardBookingsPath,
  canonicalBilliardBillingMode,
  canonicalBilliardSessionStatus,
  getBilliardMutationPolicy,
  isBilliardNetworkError,
  isAllowedBilliardMutation,
  isAllowedBilliardOperation,
  normalizeBilliardDashboard,
  normalizeBilliardCatalogProduct,
  normalizeBilliardAvailability,
  normalizeBilliardBookings,
  normalizeBilliardPendingPayments,
  resolveBilliardOutstandingBalance,
  resolveBilliardSessionTotal,
} from '../src/shared/billiard-contract';

function readSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('billiard desktop/backend contract', () => {
  it('normalizes the canonical dashboard array into cache collections', () => {
    const resource = { id: 'table-1', name: 'Table 1' };
    const session = { id: 'session-1', status: 'ACTIVE' };
    const layout = { id: 'layout-1', resourceId: 'table-1' };

    expect(normalizeBilliardDashboard([
      { resource, session, status: 'occupied', layout },
      { resource: { id: 'table-2' }, session: null, status: 'free', layout: null },
    ])).toEqual({
      resources: [resource, { id: 'table-2' }],
      sessions: [session],
      layouts: [layout],
    });
  });

  it('keeps compatibility with wrapped and legacy split dashboard responses', () => {
    expect(normalizeBilliardDashboard({
      data: [{ resource: { id: 'table-1' }, session: null, layout: null }],
    }).resources).toEqual([{ id: 'table-1' }]);

    expect(normalizeBilliardDashboard({
      resources: [{ id: 'table-2' }],
      activeSessions: [{ id: 'session-2' }],
      layouts: [{ id: 'layout-2' }],
    })).toEqual({
      resources: [{ id: 'table-2' }],
      sessions: [{ id: 'session-2' }],
      layouts: [{ id: 'layout-2' }],
    });
  });

  it('rejects partial or malformed dashboard snapshots before cache replacement', () => {
    expect(normalizeBilliardDashboard([])).toEqual({
      resources: [],
      sessions: [],
      layouts: [],
    });
    expect(() => normalizeBilliardDashboard({ message: 'ok' })).toThrow(
      'incomplete collections',
    );
    expect(() => normalizeBilliardDashboard({ resources: [] })).toThrow(
      'incomplete collections',
    );
    expect(() => normalizeBilliardDashboard([
      { resource: { id: 'table-1' }, session: { status: 'ACTIVE' } },
    ])).toThrow('session row has no id');
  });

  it('rejects malformed pending-payment snapshots before local journal pruning', () => {
    const pending = {
      id: 'session-1',
      status: 'COMPLETED',
      paymentStatus: 'UNPAID',
    };
    expect(normalizeBilliardPendingPayments([pending])).toEqual([pending]);
    expect(normalizeBilliardPendingPayments({ data: [pending] })).toEqual([pending]);
    expect(() => normalizeBilliardPendingPayments({ items: [] })).toThrow(
      'expected an array',
    );
    expect(() => normalizeBilliardPendingPayments([
      { ...pending, status: 'ACTIVE' },
    ])).toThrow('unsafe session row');
  });

  it('uses backend-canonical uppercase session values', () => {
    expect(canonicalBilliardSessionStatus('paused')).toBe('PAUSED');
    expect(canonicalBilliardSessionStatus('unknown')).toBe('ACTIVE');
    expect(canonicalBilliardBillingMode('per_hour_rounded')).toBe('PER_HOUR_ROUNDED');
    expect(canonicalBilliardBillingMode(undefined)).toBe('PER_MINUTE');
  });

  it('uses backend field names for transfer and payment mutations', () => {
    expect(billiardTransferPayload('table-2')).toEqual({ targetResourceId: 'table-2' });
    expect(billiardPaymentPayload('CASH', 120.5)).toEqual({
      paymentMethod: 'CASH',
      amount: 120.5,
    });
  });

  it('keeps a finalized zero total authoritative and estimates an active session', () => {
    expect(resolveBilliardSessionTotal({
      status: 'COMPLETED',
      totalCharge: 0,
      timeCharge: 50,
      items: [{ unitPrice: 10, quantity: 2 }],
    })).toBe(0);
    expect(resolveBilliardSessionTotal({
      status: 'ACTIVE',
      totalCharge: 0,
      currentTimeCharge: 50,
      items: [{ unitPrice: 10, quantity: 2 }],
    })).toBe(70);
  });

  it('collects only the outstanding balance after a partial payment', () => {
    expect(resolveBilliardOutstandingBalance({
      status: 'COMPLETED',
      totalCharge: 100,
      paidAmount: 40,
    })).toBe(60);
    expect(resolveBilliardOutstandingBalance({
      status: 'COMPLETED',
      totalCharge: 100,
      paidAmount: 120,
    })).toBe(0);
  });

  it('renders and bills a local ProductVariantRow with the same price and stock', () => {
    expect(normalizeBilliardCatalogProduct({
      id: 'variant-1',
      name: 'Cola',
      retail_price: 1299,
      price_gross: 1299,
      available_qty: 4,
      in_stock: 1,
    })).toEqual({
      variantId: 'variant-1',
      name: 'Cola',
      price: 12.99,
      stock: 4,
      hasStock: true,
    });
    expect(normalizeBilliardCatalogProduct({
      id: 'variant-2',
      name: 'Empty',
      retail_price: 500,
      available_qty: 0,
      in_stock: 0,
    }).hasStock).toBe(false);
  });

  it('allows only the explicit billiard/resource mutation surface', () => {
    expect(isAllowedBilliardMutation('PUT', '/billiard/table-layouts/table-1')).toBe(true);
    expect(isAllowedBilliardMutation('POST', '/billiard/sessions/session-1/payment')).toBe(true);
    expect(isAllowedBilliardMutation('POST', '/resources')).toBe(true);
    expect(isAllowedBilliardMutation('GET', '/billiard/sessions/session-1')).toBe(true);
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(isAllowedBilliardMutation('GET', '/billiard/bookings?date=2026-07-18&limit=200')).toBe(true);
    expect(isAllowedBilliardMutation('GET', `/billiard/availability/${uuid}?date=2026-07-18`)).toBe(true);
    expect(isAllowedBilliardMutation('POST', `/billiard/bookings/${uuid}/check-in`)).toBe(true);
    expect(isAllowedBilliardMutation('GET', '/billiard/bookings?date=2026-07-18&limit=200&admin=true')).toBe(false);
    expect(isAllowedBilliardMutation('POST', '/billiard/bookings/not-a-uuid/cancel')).toBe(false);
    expect(isAllowedBilliardMutation('GET', '/users')).toBe(false);
    expect(isAllowedBilliardMutation('DELETE', '/resources/types')).toBe(false);
    expect(isAllowedBilliardMutation('PUT', '/billiard/../users')).toBe(false);
  });

  it('binds queue policy and operation labels to the exact HTTP route', () => {
    const sessionPath = '/billiard/sessions/session-1';
    const paymentPath = `${sessionPath}/payment`;
    expect(getBilliardMutationPolicy('PATCH', sessionPath)).toBe('queue-safe');
    expect(getBilliardMutationPolicy('POST', paymentPath)).toBe('online-only');
    expect(isAllowedBilliardOperation('process_payment', 'POST', paymentPath)).toBe(true);
    expect(isAllowedBilliardOperation('update_session', 'POST', paymentPath)).toBe(false);
    expect(isAllowedBilliardOperation('end_session', 'PATCH', `${sessionPath}/end`)).toBe(true);
    expect(isAllowedBilliardOperation('online_api', 'PATCH', `${sessionPath}/end`)).toBe(false);
  });

  it('normalizes reservation responses and builds timezone-safe guarded routes', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(buildBilliardBookingsPath('2026-07-18')).toBe(
      '/billiard/bookings?date=2026-07-18&limit=200',
    );
    expect(buildBilliardAvailabilityPath(uuid, '2026-07-18')).toBe(
      `/billiard/availability/${uuid}?date=2026-07-18`,
    );
    expect(() => buildBilliardBookingsPath('2026-02-31')).toThrow('Invalid reservation date');
    expect(buildBilliardBookingStartsAt('2026-07-18', 18)).toMatch(
      /^2026-07-18T18:00:00[+-]\d{2}:\d{2}$/,
    );
    expect(normalizeBilliardBookings({ items: [{
      id: uuid,
      resource_id: uuid,
      resource: { name: 'Bàn #1' },
      starts_at: '2026-07-18T18:00:00+02:00',
      ends_at: '2026-07-18T20:00:00+02:00',
      owner: { full_name: 'Lan', phone: '123' },
      internal_notes: 'Manual booking by staff. Guests: 4',
      total_price: '100',
      status: 'booked',
    }] })).toEqual([expect.objectContaining({
      id: uuid,
      tableName: 'Bàn #1',
      customerName: 'Lan',
      guestCount: 4,
      totalPrice: 100,
      status: 'BOOKED',
    })]);
    expect(normalizeBilliardAvailability({
      slots: [{ hour: '18:00', available: true, price: '50' }],
      currency: 'PLN',
    })).toEqual({
      slots: [{ hour: '18:00', available: true, price: 50 }],
      currency: 'PLN',
    });
  });

  it('never classifies an HTTP response as an offline transport failure', () => {
    expect(isBilliardNetworkError({ status: 409, message: 'network conflict' })).toBe(false);
    expect(isBilliardNetworkError(new Error('fetch failed'))).toBe(true);
    expect(isBilliardNetworkError(new Error('Session is already active'))).toBe(false);
  });

  it('preserves canonical resource/session snapshots in the local cache schema', () => {
    const migration = migrations.find((entry) => entry.name === 'billiard_cache_payload_snapshots');
    expect(migration?.version).toBe(59);
    expect(migration?.up).toContain('ALTER TABLE billiard_resources ADD COLUMN payload_json TEXT');
    expect(migration?.up).toContain('ALTER TABLE billiard_sessions ADD COLUMN payload_json TEXT');
  });

  it('uses the deployed layout routes and the dedicated billiard mutation lane', () => {
    const source = readSource('../src/renderer/hooks/useBilliardApi.ts');
    expect(source).toContain("mutate('online_api', method, path, body)");
    expect(source).not.toContain('getSyncStatus()');
    expect(source).toContain("'PUT', `/billiard/table-layouts/${resourceId}`");
    expect(source).toContain("'PUT', '/billiard/table-layouts/batch'");
    expect(source).not.toContain('window.electronAPI.apiCall');
    expect(source).not.toContain('/billiard/layouts/upsert');
  });

  it('mounts the reservation panel on the canonical guarded backend API', () => {
    const apiHook = readSource('../src/renderer/hooks/useBilliardApi.ts');
    const panel = readSource('../src/renderer/components/billiard/ReservationPanel.tsx');
    const floorPlan = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    const translations = readSource('../src/renderer/i18n/translations.ts');

    expect(apiHook).toContain('const bookingsApi = useMemo');
    expect(apiHook).toContain("onlineApi('POST', '/billiard/bookings', data)");
    expect(apiHook).toContain('buildBilliardAvailabilityPath(resourceId, date)');
    expect(panel).toContain('buildBilliardBookingStartsAt(date, selectedHour)');
    expect(panel).toContain('bookingsApi.checkIn');
    expect(panel).toContain('bookingsRequestGeneration');
    expect(panel).toContain('requestGeneration !== bookingsRequestGeneration.current');
    expect(panel).toContain('date !== currentBookingsDate.current');
    expect(panel).not.toContain('[bookingsApi, date, t]');
    expect(panel).not.toContain('electronAPI?.reservation');
    expect(panel).not.toContain('billiardGuest');
    expect(floorPlan).toContain('<ReservationPanel');
    expect(floorPlan).toContain('key="billiard-reservations-panel"');
    expect(floorPlan).toContain('if (isLoading && !overview)');
    expect(floorPlan).toContain('setReservationsOpen(true)');
    expect(translations).toContain("'billiard.reservations': 'Đặt bàn'");
    expect(translations).toContain("'billiard.reservations': 'Rezerwacje'");
  });

  it('normalizes local F&B prices and keeps unsupported digital tenders hidden', () => {
    const addItem = readSource('../src/renderer/components/billiard/AddItemToTabModal.tsx');
    const contract = readSource('../src/shared/billiard-contract.ts');
    const payment = readSource('../src/renderer/components/billiard/PaymentDialog.tsx');
    const transfer = readSource('../src/renderer/components/billiard/TransferTableDialog.tsx');

    expect(addItem).toContain('normalizeBilliardCatalogProduct(product)');
    expect(contract).toContain('variant.retail_price');
    expect(contract).toContain('priceNumber / 100');
    expect(addItem).toContain('combo.combo_price');
    expect(payment).toContain("setStep('review')");
    expect(payment).toContain('const snapshot = endedSnapshot ?? await ensureEnded()');
    expect(payment).toContain("'GET',");
    expect(payment).toContain("paymentMethod: 'CASH'");
    expect(payment).toContain('amount: amountDue');
    expect(payment).toContain('formatCurrency(paidAmount)');
    expect(payment).toContain('alreadySettledZero');
    expect(payment).toContain("recovery === 'paid'");
    expect(payment).not.toContain('getSyncStatus()');
    expect(payment).not.toContain('cardPayment(');
    expect(payment).not.toContain("paymentMethod: 'BLIK'");
    expect(payment).not.toContain('billiard.printReceipt');
    expect(transfer).toContain('(floorOverview as any)?.tables');
  });

  it('replaces authoritative resource cache rows and never queues session end', () => {
    const resourceRepo = readSource('../src/main/database/repos/billiard-resource-repo.ts');
    const sync = readSource('../src/main/sync/billiard-sync.ts');
    expect(resourceRepo).toContain('replaceAll(resources: any[])');
    expect(resourceRepo).toContain('replaceBilliardResources(database, resources)');
    expect(sync).toContain('billiardResourceRepo.replaceAll(normalized.resources)');
    expect(sync).toContain("const onlineOnly = routePolicy === 'online-only'");
    expect(sync).toContain('!isAllowedBilliardOperation(op, method, path)');
    expect(sync).not.toContain('ONLINE_ONLY_OPERATIONS');
    expect(sync).toContain('timeCharge: Number(payload.timeCharge ?? 0)');
    expect(sync).toContain("this.notifyRenderer('payment-pending')");
    expect(sync).toContain('pendingPayments,');
    expect(sync).toContain("await this.flushPaymentJournal('session end')");
    expect(sync).toContain('sessionReconciliationRead');
    expect(sync).not.toContain('this.isOnline = false');
  });

  it('recovers the complete pending-payment snapshot through the cashier-safe endpoint', () => {
    const sync = readSource('../src/main/sync/billiard-sync.ts');
    const syncModule = readSource('../src/main/modules/sync.module.ts');
    const mutationRepo = readSource('../src/main/database/repos/billiard-mutation-repo.ts');
    const sessionRepo = readSource('../src/main/database/repos/billiard-session-repo.ts');
    expect(sync).toContain("'/billiard/sessions/pending-payments'");
    expect(sync).toContain('billiardSessionRepo.reconcilePendingSnapshot(pendingPayments)');
    expect(sync).toContain("syncPendingPayments(token, 'periodic pending payment reconciliation')");
    expect(sync).toContain('Every mutation probes REST first');
    expect(sync).not.toContain('if (this.isOnline || onlineOnly)');
    expect(sync).toContain('REST-recovery queue replay failed');
    expect(sync).toContain('if (this.replayInFlight) return this.replayInFlight');
    expect(sync).toContain('Could not durably queue the billiard operation');
    expect(sync).toContain('Discarding stale dashboard response');
    expect(sync).toContain('Discarding stale pending-payment response');
    expect(sync).toContain('Number(err?.status) === 404');
    expect(sync).toContain('preserving the local payment journal');
    expect(sync).toContain('billiardSessionRepo.pruneExpiredPaidTombstones()');
    expect(sync).toContain('await this.syncSessionAfterMutation(op, path, result, token)');
    expect(sync).toContain('Never surface this read-after-write');
    expect(syncModule).toContain('Post-login billiard sync failed');
    const disconnectBlock = syncModule.slice(
      syncModule.indexOf("bus.on('socket:disconnected'"),
      syncModule.indexOf("setupSocketHandlers"),
    );
    expect(disconnectBlock).not.toContain('stopPeriodicDashboardRefresh');
    expect(sessionRepo).toContain('reconcilePendingSnapshot(sessions: any[], now = Date.now())');
    expect(sessionRepo).toContain('isFreshPaidTombstone');
    expect(mutationRepo).toContain("status = 'quarantined'");
    expect(mutationRepo).toContain('SAFE_BILLIARD_REPLAY_OPERATIONS');
    expect(sync).toContain("routePolicy !== 'queue-safe'");
    expect(sync).toContain('billiardMutationRepo.markQuarantined');
    const fullSync = sync.slice(sync.indexOf('async fullSync()'), sync.indexOf('// ── Dashboard cache refresh'));
    expect(fullSync.indexOf('this.syncFloorPlans(token)')).toBeLessThan(
      fullSync.indexOf("'/billiard/dashboard'"),
    );
  });

  it('preserves HTTP status and exposes pending cash recovery in the floor plan', () => {
    const apiClient = readSource('../src/main/network/api-client.ts');
    const floorPlan = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    const sessionDetail = readSource('../src/renderer/components/billiard/SessionDetailModal.tsx');
    const tableDrawer = readSource('../src/renderer/components/billiard/TableActionPopover.tsx');
    expect(apiClient).toContain('error.status = response.status');
    expect(floorPlan).toContain('(overview as any)?.pendingPayments');
    expect(floorPlan).toContain('setPaymentSession(session)');
    // Pending cash recovery lives in the UnsettledPanel the floor renders.
    expect(floorPlan).toContain('<UnsettledPanel');
    const unsettledPanel = readSource('../src/renderer/components/billiard/UnsettledPanel.tsx');
    expect(unsettledPanel).toContain('resolveBilliardOutstandingBalance(session)');
    expect(floorPlan).toContain("canEditLayout = String(user?.role || '').toUpperCase() === 'OWNER'");
    expect(floorPlan).toContain("useResourceType('POOL_TABLE', canEditLayout)");
    expect(floorPlan).toContain('const [selectedTableId, setSelectedTableId]');
    expect(floorPlan).toContain('table.resource.id === selectedTableId');
    expect(floorPlan).not.toContain('detailSessionId');
    expect(sessionDetail).not.toContain('useEndSession');
    expect(tableDrawer).not.toContain('onEnd: () => void');
  });

  it('keeps floor gestures bounded and renders one opaque cashier drawer', () => {
    const floorPlan = readSource('../src/renderer/components/billiard/BilliardFloorPlan.tsx');
    const tableDrawer = readSource('../src/renderer/components/billiard/TableActionPopover.tsx');
    const draggableTable = readSource('../src/renderer/components/billiard/DraggableTable.tsx');
    const addItem = readSource('../src/renderer/components/billiard/AddItemToTabModal.tsx');
    const payment = readSource('../src/renderer/components/billiard/PaymentDialog.tsx');
    const transfer = readSource('../src/renderer/components/billiard/TransferTableDialog.tsx');

    expect(floorPlan).toContain('data-billiard-canvas-viewport');
    expect(floorPlan).toContain('h-[clamp(440px,62vh,720px)]');
    expect(floorPlan).toContain('new ResizeObserver(updateSize)');
    expect(floorPlan).toContain('...fittedCanvasSize');
    expect(floorPlan).toContain('wheel={{ step: 0.08 }}');
    expect(floorPlan).toContain('disabled: editMode');
    expect(floorPlan).not.toContain('disabled={editMode}');
    expect(floorPlan).not.toContain("addEventListener('wheel'");
    expect(floorPlan).not.toContain('<SessionDetailModal');
    expect(floorPlan).toContain('onOpenChange={closeSelectedTable}');
    expect(floorPlan).toContain(
      'suspended={Boolean(addItemSessionId || transferSessionId || paymentSession)}',
    );

    const nestedDialogActions = floorPlan.slice(
      floorPlan.indexOf('onAddItem={() => {'),
      floorPlan.indexOf('onUpdateGuestCount={(count) => {'),
    );
    expect(nestedDialogActions).not.toContain('setSelectedTableId(null)');

    const tableClick = floorPlan.slice(
      floorPlan.indexOf('// Handle table click in operate mode'),
      floorPlan.indexOf('// Quick start'),
    );
    expect(tableClick).toContain('setSelectedTableId(table.resource.id)');
    expect(tableClick).not.toContain('.mutate(');

    expect(tableDrawer).toContain('role="dialog"');
    expect(tableDrawer).toContain('bg-white text-slate-900');
    expect(tableDrawer).toContain('sm:w-[400px]');
    expect(tableDrawer).not.toContain('bg-popover');
    expect(tableDrawer).not.toContain('bg-muted');
    expect(tableDrawer).not.toContain('text-muted-foreground');
    expect(tableDrawer).not.toContain('clickPosition');
    expect(tableDrawer).not.toContain('onOpenDetail');
    expect(tableDrawer).toContain('session?.currentTimeCharge ?? session?.timeCharge');
    expect(tableDrawer).toContain('if (!open || suspended) return;');
    expect(tableDrawer).toContain("const inertProps = suspended ? { inert: '' } : {};");
    expect(tableDrawer).toContain('{...inertProps}');
    expect(tableDrawer).toContain('aria-hidden={suspended || undefined}');

    expect(draggableTable).toContain("role={editMode ? undefined : 'button'}");
    expect(draggableTable).toContain("e.key !== 'Enter' && e.key !== ' '");
    expect(addItem).toContain('trapDialogFocus(event, dialogRef.current)');
    expect(addItem).toContain("document.addEventListener('keydown', handleKeyDown)");
    expect(addItem).toContain('role="dialog"');
    expect(payment).toContain('autoFocus');
    expect(payment).toContain('role="dialog"');
    expect(payment).toContain('trapDialogFocus(event, dialogRef.current)');
    expect(payment).toContain("document.addEventListener('keydown', handleKeyDown)");
    expect(transfer).toContain('autoFocus');
    expect(transfer).toContain('role="dialog"');
    expect(transfer).toContain('trapDialogFocus(event, dialogRef.current)');
    expect(transfer).toContain("document.addEventListener('keydown', handleKeyDown)");
  });
});
