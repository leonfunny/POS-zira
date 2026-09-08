import type { AndroidDatabase } from './db';
import { createRefundAttemptRepo, type RefundAttempt } from './refund-attempt-repo';
import { validateAuthoritativeRefundResult } from '../../../../shared/refund-authority';
import { validateCanonicalRefundEvent, type RefundEventTenderAllocation } from '../../../../shared/refund-event';

export interface ConfirmCanonicalRefundInput {
  requestId: string;
  localOrderId: string;
  responseJson: string;
  scope: { serverUrl: string; salonId: string; operatorId: string; machineId: string };
}
const fail = (reason: string): never => { throw new Error(`ANDROID_REFUND_EVENT_INVALID: ${reason}`); };
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const minor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const methods = new Set(['CASH', 'CARD', 'BLIK', 'BANK_TRANSFER']); // OTHER needs a report bucket first.
function parse(raw: unknown): any {
  if (typeof raw !== 'string') return fail('JSON required');
  try { return JSON.parse(raw); } catch { return fail('Malformed JSON'); }
}
function canonical(value: any): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
function sum(values: number[]): number {
  let total = 0n;
  for (const value of values) { if (!minor(value)) return fail('Invalid minor units'); total += BigInt(value); }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return fail('Unsafe sum');
  return Number(total);
}
function pln(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value))) return fail('Invalid PLN');
  const scaled = Number(value) * 100; const rounded = Math.round(scaled);
  if (!minor(rounded) || !Number.isFinite(scaled) || Math.abs(scaled - rounded) > 0.000001) return fail('Invalid PLN precision');
  return rounded;
}
function tenders(raw: unknown): RefundEventTenderAllocation[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 4) return fail('Tender capacities required');
  const seen = new Set<string>();
  const rows = raw.map(row => {
    if (!object(row) || !methods.has(row.method) || seen.has(row.method) || !minor(row.amountMinor) || row.amountMinor === 0) return fail('Invalid tender');
    seen.add(row.method); return { method: row.method, amountMinor: row.amountMinor };
  });
  sum(rows.map(row => row.amountMinor));
  return rows.sort((a, b) => a.method < b.method ? -1 : a.method > b.method ? 1 : 0);
}
function audit(raw: unknown): any[] {
  if (!Array.isArray(raw)) return fail('Audit array required');
  const seen = new Set<string>();
  const rows = raw.map(line => {
    if (!object(line) || !uuid(line.refundRequestId) || !uuid(line.orderItemId)) return fail('Invalid audit identity');
    const key = `${line.refundRequestId}/${line.orderItemId}`;
    if (seen.has(key)) return fail('Duplicate audit line'); seen.add(key);
    return line;
  });
  return [...rows].sort((a, b) => `${a.refundRequestId}/${a.orderItemId}` < `${b.refundRequestId}/${b.orderItemId}` ? -1 : 1);
}
const fingerprint = (order: any) => JSON.stringify([
  order.id, order.backend_id, order.shift_id, order.synced, order.source, order.status,
  order.total, order.refund_amount ?? 0, order.refund_lines ?? null,
  order.payment_method, order.payment_tenders ?? null,
]);

/** Validate immutable evidence independently for current and historical requests. */
function evidence(attempt: RefundAttempt, responseJson: string) {
  const saved = parse(attempt.expected_json); const payload = parse(attempt.payload_json); const raw = parse(responseJson);
  if (!object(saved) || saved.protocolVersion !== 1 || !object(saved.authority) || !object(saved.event)
    || typeof saved.localFingerprint !== 'string' || !Array.isArray(parse(saved.localFingerprint))
    || !object(parse(saved.inputJson)) || !Array.isArray(saved.priorRefundLines) || !object(payload)) return fail('Invalid frozen V1 evidence');
  const authority = saved.authority; const expected = saved.event;
  const validated = validateAuthoritativeRefundResult(raw, authority as any);
  const eventResult = validateCanonicalRefundEvent(raw?.refundEvent, expected as any);
  if (!validated.ok || !eventResult.ok) return fail('Unconfirmed authoritative response/event');
  const event = eventResult.event;
  if (authority.requestId !== attempt.request_id || authority.backendOrderId !== attempt.backend_order_id
    || event.refundRequestId !== attempt.request_id || event.orderId !== attempt.backend_order_id
    || validated.deltaGrosze !== authority.expectedDeltaGrosze || validated.deltaGrosze !== event.deltaAmountMinor
    || sum(validated.lines.map(line => line.refundAmount)) !== validated.deltaGrosze) return fail('Exact response delta/line sum mismatch');
  const original = tenders(saved.originalTenderCapacities);
  const allocated = tenders(event.tenderAllocations);
  if (sum(original.map(row => row.amountMinor)) !== authority.orderTotalGrosze) return fail('Original tender sum mismatch');
  const allowed = new Set(['refundEventVersion', 'machineId', 'refundRequestId', 'shiftId', 'type', 'amount', 'items', 'tenderAllocations', 'reason', 'refundMethod']);
  if (Object.keys(payload).some(key => !allowed.has(key)) || payload.refundEventVersion !== 1
    || payload.machineId !== event.machineId || payload.refundRequestId !== event.refundRequestId || payload.shiftId !== event.shiftId
    || !['FULL', 'PARTIAL'].includes(payload.type) || pln(payload.amount) !== event.deltaAmountMinor
    || (payload.type === 'FULL' && validated.status !== 'FULL')
    || (payload.reason !== undefined && typeof payload.reason !== 'string')
    || (payload.refundMethod !== undefined && typeof payload.refundMethod !== 'string')
    || !Array.isArray(payload.items) || payload.items.length !== authority.items.length
    || !Array.isArray(payload.tenderAllocations)) return fail('Frozen payload mismatch');
  const ids = new Set<string>();
  for (const item of payload.items) {
    if (!object(item) || !uuid(item.orderItemId) || ids.has(item.orderItemId)
      || Object.keys(item).some(key => !['orderItemId', 'quantity', 'restock', 'unit', 'saleUnit'].includes(key))) return fail('Invalid payload item');
    ids.add(item.orderItemId);
    const selected = authority.items.find((line: any) => line.orderItemId === item.orderItemId);
    const returned = validated.lines.find(line => line.orderItemId === item.orderItemId);
    if (!selected || !returned || item.quantity !== selected.quantity || item.restock !== selected.restock
      || (item.unit !== undefined && item.unit !== returned.unit) || (item.saleUnit !== undefined && item.saleUnit !== returned.saleUnit)) return fail('Payload item mismatch');
  }
  const payloadTenders = tenders(payload.tenderAllocations.map((row: any) => {
    if (!object(row)) return fail('Invalid payload tender');
    return { method: row.method, amountMinor: pln(row.amount) };
  }));
  if (canonical(payloadTenders) !== canonical(allocated)) return fail('Payload tender mismatch');
  const lines = audit(validated.lines);
  audit(saved.priorRefundLines);
  return { saved, payload, authority, event, original, allocated, validated, lines };
}

/** Storage only: caller owns authenticated access, final context guard and a latched flush barrier. */
export function createRefundEventRepo(database: AndroidDatabase) {
  const journal = createRefundAttemptRepo(database);
  return {
    confirmCanonicalRefund(input: ConfirmCanonicalRefundInput): { applied: boolean; deltaGrosze: number; cumulativeGrosze: number } {
      if (!object(input) || !uuid(input.requestId) || !uuid(input.localOrderId) || !object(input.scope)) return fail('Invalid confirmation identity');
      const scope = input.scope;
      let url: URL;
      try { url = new URL(scope.serverUrl); } catch { return fail('Invalid server scope'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || scope.serverUrl !== scope.serverUrl.trim() || scope.serverUrl.endsWith('/')
        || !uuid(scope.salonId) || !uuid(scope.operatorId) || !uuid(scope.machineId)) return fail('Invalid confirmation scope');
      const attempt = journal.get(input.requestId);
      if (!attempt || attempt.local_order_id !== input.localOrderId
        || attempt.scope_key !== JSON.stringify([scope.serverUrl, scope.salonId, scope.operatorId])) return fail('Original journal scope mismatch');
      const current = evidence(attempt, input.responseJson);
      if (current.event.salonId !== scope.salonId || current.event.operatorId !== scope.operatorId
        || current.event.machineId !== scope.machineId) return fail('Event scope mismatch');
      const context = { serverUrl: scope.serverUrl, salonId: scope.salonId, machineId: scope.machineId,
        backendOrderId: attempt.backend_order_id, originalTenderCapacities: current.original };

      const verifyState = (terminal: boolean) => {
        const order = database.get<any>('SELECT * FROM orders WHERE id = ?', [input.localOrderId]);
        const device = database.get<any>('SELECT id FROM pos_device_identity WHERE singleton = 1');
        if (!order || order.backend_id !== attempt.backend_order_id || order.source !== 'POS' || order.synced !== 1
          || order.mode === 'billiard' || order.billiard_origin_json || order.total !== current.authority.orderTotalGrosze
          || device?.id !== scope.machineId || !uuid(attempt.shift_id) || order.shift_id !== attempt.shift_id) return fail('Local order/device mismatch');
        if (database.all('SELECT id FROM orders WHERE backend_id = ?', [attempt.backend_order_id]).length !== 1) return fail('Ambiguous local backend mapping');
        if (order.tip !== 0 || order.discount !== 0 || !minor(order.payment_amount) || !minor(order.change_amount)
          || order.payment_amount - order.change_amount !== order.total) return fail('Unsupported or unsettled local money');
        const shift = database.get<any>('SELECT * FROM shifts WHERE id = ?', [attempt.shift_id]);
        const binding = shift?.backend_binding_json ? parse(shift.backend_binding_json) : null;
        if (!shift || shift.backend_id !== current.event.shiftId || !object(binding)
          || canonical(binding) !== canonical({ serverUrl: scope.serverUrl, salonId: scope.salonId,
            machineId: scope.machineId, backendShiftId: current.event.shiftId })) return fail('Original shift binding mismatch');
        if (!terminal && (shift.closed_at !== null || shift.close_report_json !== null
          || database.all('SELECT id FROM shifts WHERE closed_at IS NULL').length !== 1)) return fail('Refund shift is not the sole open shift');
        if (!terminal && fingerprint(order) !== current.saved.localFingerprint) return fail('Frozen order fingerprint changed');
        const localPayments = order.payment_tenders === null ? [{ method: order.payment_method, amountMinor: order.total }]
          : (() => { const rows = parse(order.payment_tenders); if (!Array.isArray(rows)) return fail('Invalid local tenders');
            return rows.map(row => ({ method: row?.method, amountMinor: row?.amount })); })();
        const localTenders = tenders(localPayments);
        if (order.payment_method !== (localTenders.length > 1 ? 'SPLIT' : localTenders[0].method)
          || canonical(localTenders) !== canonical(current.original)) return fail('Local original tenders mismatch');
        const ledger = database.all<any>('SELECT * FROM pos_refund_events WHERE local_order_id = ? OR backend_order_id = ?',
          [input.localOrderId, attempt.backend_order_id]);
        const confirmed = database.all<RefundAttempt>("SELECT * FROM pos_refund_attempts WHERE (local_order_id = ? OR backend_order_id = ?) AND status = 'CONFIRMED'",
          [input.localOrderId, attempt.backend_order_id]);
        if (confirmed.length !== ledger.length) return fail('Missing ledger or legacy confirmed history');
        const unresolved = database.all<RefundAttempt>("SELECT * FROM pos_refund_attempts WHERE (local_order_id = ? OR backend_order_id = ?) AND status IN ('PREPARED','UNKNOWN')",
          [input.localOrderId, attempt.backend_order_id]);
        if (!terminal && unresolved.some(row => row.request_id !== input.requestId)) return fail('Other unresolved refund');
        const histories = ledger.map(row => {
          const savedAttempt = confirmed.find(item => item.request_id === row.request_id);
          if (!savedAttempt || savedAttempt.local_order_id !== input.localOrderId || savedAttempt.backend_order_id !== attempt.backend_order_id) return fail('Ledger journal missing');
          const proof = evidence(savedAttempt, savedAttempt.response_json!);
          const ev = proof.event;
          if (row.server_url !== scope.serverUrl || row.salon_id !== scope.salonId || row.local_order_id !== input.localOrderId
            || row.backend_order_id !== attempt.backend_order_id || row.local_shift_id !== order.shift_id
            || row.backend_shift_id !== ev.shiftId || ev.shiftId !== shift.backend_id || row.machine_id !== scope.machineId
            || ev.machineId !== scope.machineId || ev.salonId !== scope.salonId || row.operator_id !== ev.operatorId
            || savedAttempt.shift_id !== row.local_shift_id || savedAttempt.scope_key !== JSON.stringify([scope.serverUrl, scope.salonId, ev.operatorId])
            || row.occurred_at !== ev.occurredAt || row.delta_amount_minor !== ev.deltaAmountMinor
            || canonical(parse(row.event_json)) !== canonical(ev) || canonical(proof.original) !== canonical(current.original)
            || proof.authority.orderTotalGrosze !== order.total) return fail('Persisted event disagrees with journal');
          return proof;
        }).sort((a, b) => a.authority.alreadyRefundedGrosze - b.authority.alreadyRefundedGrosze);
        let cumulative = 0; let allLines: any[] = []; const used = new Map<string, number>();
        for (const history of histories) {
          if (history.authority.alreadyRefundedGrosze !== cumulative
            || canonical(audit(history.saved.priorRefundLines)) !== canonical(audit(allLines))) return fail('Incomplete cumulative/audit chain');
          cumulative = sum([cumulative, history.validated.deltaGrosze]);
          if (history.validated.cumulativeGrosze !== cumulative) return fail('Invalid cumulative chain');
          allLines = audit([...allLines, ...history.lines]);
          for (const row of history.allocated) used.set(row.method, sum([used.get(row.method) ?? 0, row.amountMinor]));
        }
        const localAudit = order.refund_lines === null ? [] : parse(order.refund_lines);
        if (order.refund_amount !== cumulative || canonical(audit(localAudit)) !== canonical(audit(allLines))
          || order.status !== (cumulative === 0 ? 'COMPLETED' : cumulative === order.total ? 'REFUNDED' : 'PARTIAL_REFUND')) return fail('Local cumulative projection mismatch');
        if (order.refund_event_context_json === null) {
          if (terminal || ledger.length || current.authority.alreadyRefundedGrosze !== 0 || current.saved.priorRefundLines.length) return fail('Zero-refund first conversion required');
        } else if (canonical(parse(order.refund_event_context_json)) !== canonical(context) || ledger.length === 0) return fail('Invalid immutable event context');
        for (const [method, amount] of used) {
          const original = current.original.find(row => row.method === method);
          if (!original || amount > original.amountMinor) return fail('Historical tender capacity exceeded');
        }
        if (!terminal) {
          if (current.authority.alreadyRefundedGrosze !== cumulative
            || canonical(audit(current.saved.priorRefundLines)) !== canonical(audit(allLines))) return fail('Frozen prior accounting mismatch');
          for (const row of current.allocated) {
            const original = current.original.find(item => item.method === row.method);
            if (!original || row.amountMinor > original.amountMinor - (used.get(row.method) ?? 0)) return fail('Remaining tender capacity exceeded');
          }
        } else if (!ledger.some(row => row.request_id === input.requestId)) return fail('Confirmed event missing');
        return { order, allLines };
      };

      if (attempt.status === 'CONFIRMED') {
        if (attempt.response_json !== input.responseJson) return fail('Confirmed response bytes changed');
        verifyState(true);
        return { applied: false, deltaGrosze: current.validated.deltaGrosze, cumulativeGrosze: current.validated.cumulativeGrosze };
      }
      const result = journal.confirmAndApply(input.requestId, input.responseJson, () => {
        const { allLines } = verifyState(false);
        const ev = current.event;
        database.run(`INSERT INTO pos_refund_events (request_id,server_url,salon_id,local_order_id,backend_order_id,
          local_shift_id,backend_shift_id,machine_id,operator_id,occurred_at,delta_amount_minor,event_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [input.requestId, scope.serverUrl, scope.salonId, input.localOrderId,
          attempt.backend_order_id, attempt.shift_id, ev.shiftId, ev.machineId, ev.operatorId, ev.occurredAt,
          ev.deltaAmountMinor, canonical(ev)]);
        database.run(`UPDATE orders SET refund_event_context_json = ?, status = ?, refund_amount = ?, refund_lines = ?,
          refund_reason = ?, refunded_at = ? WHERE id = ? AND backend_id = ? AND refund_amount = ?`,
        [canonical(context), current.validated.status === 'FULL' ? 'REFUNDED' : 'PARTIAL_REFUND', current.validated.cumulativeGrosze,
          JSON.stringify(audit([...allLines, ...current.lines])), current.payload.reason ?? '', ev.occurredAt,
          input.localOrderId, attempt.backend_order_id, current.authority.alreadyRefundedGrosze]);
        if (database.get<any>('SELECT changes() AS count')?.count !== 1) return fail('Order projection was not updated');
      });
      return { applied: result.applied, deltaGrosze: current.validated.deltaGrosze, cumulativeGrosze: current.validated.cumulativeGrosze };
    },
  };
}
