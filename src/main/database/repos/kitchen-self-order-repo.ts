import { randomUUID } from 'crypto';
import {
  businessDateFromIso,
  formatKitchenSelfOrderNumber,
  normalizeKitchenSelfOrderFulfillment,
  normalizeKitchenSelfOrderLanguage,
  normalizeKitchenSelfOrderPriceGrosze,
  normalizeKitchenSelfOrderQuantity,
  sanitizeKitchenSelfOrderNote,
  serializeKitchenSelfOrderOptions,
  type KitchenSelfOrderFulfillment,
  type KitchenSelfOrderLanguage,
  type KitchenSelfOrderStatus,
  type KitchenSelfOrderSubmitInput,
} from '../../../shared/kitchen-self-order';
import { database } from '../database';

export interface KitchenSelfOrderRow {
  id: string;
  order_number: string;
  sequence_number: number;
  business_date: string;
  fulfillment_type: KitchenSelfOrderFulfillment;
  customer_language: KitchenSelfOrderLanguage;
  status: KitchenSelfOrderStatus;
  source_machine_id: string | null;
  source_label: string | null;
  created_at: string;
  printed_at: string | null;
  kitchen_printed: number;
  customer_slip_printed: number;
  total_grosze: number;
  kitchen_route: string | null;
  kitchen_printer_id: string | null;
  kitchen_job_id: string | null;
  customer_slip_route: string | null;
  error: string | null;
}

export interface KitchenSelfOrderItemRow {
  id: string;
  order_id: string;
  variant_id: string | null;
  product_id: string | null;
  name_snapshot: string;
  quantity: number;
  unit_price_grosze: number;
  line_total_grosze: number;
  options_json: string | null;
  note: string | null;
  sort_order: number;
}

export type KitchenSelfOrderWithItems = KitchenSelfOrderRow & {
  items: KitchenSelfOrderItemRow[];
};

export interface KitchenSelfOrderCreateInput extends KitchenSelfOrderSubmitInput {
  sourceMachineId?: string | null;
}

function nextSequenceForBusinessDate(businessDate: string): number {
  const row = database.get<{ max_no: number | null }>(
    `SELECT MAX(sequence_number) as max_no
     FROM kitchen_self_orders
     WHERE business_date = ?`,
    [businessDate],
  );
  return (row?.max_no ?? 0) + 1;
}

function getItems(orderId: string): KitchenSelfOrderItemRow[] {
  return database.all<KitchenSelfOrderItemRow>(
    'SELECT * FROM kitchen_self_order_items WHERE order_id = ? ORDER BY sort_order ASC',
    [orderId],
  );
}

export const kitchenSelfOrderRepo = {
  getById(id: string): KitchenSelfOrderWithItems | null {
    const row = database.get<KitchenSelfOrderRow>(
      'SELECT * FROM kitchen_self_orders WHERE id = ?',
      [id],
    );
    if (!row) return null;
    return { ...row, items: getItems(id) };
  },

  create(input: KitchenSelfOrderCreateInput): KitchenSelfOrderWithItems {
    const now = new Date().toISOString();
    const businessDate = businessDateFromIso(now);
    const language = normalizeKitchenSelfOrderLanguage(input.customerLanguage);
    const fulfillment = normalizeKitchenSelfOrderFulfillment(input.fulfillmentType);
    const sourceLabel = sanitizeKitchenSelfOrderNote(input.sourceLabel) || '';
    const sourceMachineId = sanitizeKitchenSelfOrderNote(input.sourceMachineId);
    const items = (input.items || [])
      .map((item, index) => ({
        id: randomUUID(),
        variantId: sanitizeKitchenSelfOrderNote(item.variantId),
        productId: sanitizeKitchenSelfOrderNote(item.productId),
        name: sanitizeKitchenSelfOrderNote(item.name) || 'Pozycja',
        quantity: normalizeKitchenSelfOrderQuantity(item.quantity),
        unitPriceGrosze: normalizeKitchenSelfOrderPriceGrosze(item.unitPriceGrosze),
        note: sanitizeKitchenSelfOrderNote(item.note),
        optionsJson: serializeKitchenSelfOrderOptions(item.modifiers, item.options),
        sortOrder: index,
      }))
      .filter((item) => item.quantity > 0);

    if (items.length === 0) {
      throw new Error('empty_order');
    }
    const totalGrosze = items.reduce(
      (sum, item) => sum + item.unitPriceGrosze * item.quantity,
      0,
    );

    let createdId = '';
    database.transaction(() => {
      const sequence = nextSequenceForBusinessDate(businessDate);
      const id = randomUUID();
      createdId = id;
      database.run(
        `INSERT INTO kitchen_self_orders (
          id,
          order_number,
          sequence_number,
          business_date,
          fulfillment_type,
          customer_language,
          status,
          source_machine_id,
          source_label,
          created_at,
          total_grosze
        ) VALUES (?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, ?)`,
        [
          id,
          formatKitchenSelfOrderNumber(sequence),
          sequence,
          businessDate,
          fulfillment,
          language,
          sourceMachineId,
          sourceLabel,
          now,
          totalGrosze,
        ],
      );

      for (const item of items) {
        database.run(
          `INSERT INTO kitchen_self_order_items (
            id,
            order_id,
            variant_id,
            product_id,
            name_snapshot,
            quantity,
            unit_price_grosze,
            line_total_grosze,
            options_json,
            note,
            sort_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            id,
            item.variantId,
            item.productId,
            item.name,
            item.quantity,
            item.unitPriceGrosze,
            item.unitPriceGrosze * item.quantity,
            item.optionsJson,
            item.note,
            item.sortOrder,
          ],
        );
      }
    });

    const created = this.getById(createdId);
    if (!created) throw new Error('kitchen_self_order_create_failed');
    return created;
  },

  markPrintResult(
    id: string,
    result: {
      kitchenPrinted: boolean;
      customerSlipPrinted: boolean;
      kitchenRoute?: string | null;
      kitchenPrinterId?: string | null;
      kitchenJobId?: string | null;
      customerSlipRoute?: string | null;
      error?: string | null;
    },
  ): KitchenSelfOrderWithItems | null {
    const status: KitchenSelfOrderStatus = result.kitchenPrinted && result.customerSlipPrinted
      ? 'PRINTED'
      : result.kitchenPrinted || result.customerSlipPrinted
        ? 'PARTIAL_PRINT'
        : 'PRINT_FAILED';
    database.run(
      `UPDATE kitchen_self_orders
       SET status = ?,
           printed_at = ?,
           kitchen_printed = ?,
           customer_slip_printed = ?,
           kitchen_route = ?,
           kitchen_printer_id = ?,
           kitchen_job_id = ?,
           customer_slip_route = ?,
           error = ?
       WHERE id = ?`,
      [
        status,
        new Date().toISOString(),
        result.kitchenPrinted ? 1 : 0,
        result.customerSlipPrinted ? 1 : 0,
        result.kitchenRoute || null,
        result.kitchenPrinterId || null,
        result.kitchenJobId || null,
        result.customerSlipRoute || null,
        result.error || null,
        id,
      ],
    );
    return this.getById(id);
  },

  markCustomerSlipResult(
    id: string,
    result: {
      customerSlipPrinted: boolean;
      customerSlipRoute?: string | null;
      error?: string | null;
    },
  ): KitchenSelfOrderWithItems | null {
    const current = this.getById(id);
    if (!current) return null;
    const kitchenPrinted = !!current.kitchen_printed;
    const status: KitchenSelfOrderStatus = kitchenPrinted && result.customerSlipPrinted
      ? 'PRINTED'
      : kitchenPrinted || result.customerSlipPrinted
        ? 'PARTIAL_PRINT'
        : 'PRINT_FAILED';
    database.run(
      `UPDATE kitchen_self_orders
       SET status = ?,
           printed_at = ?,
           customer_slip_printed = ?,
           customer_slip_route = ?,
           error = ?
       WHERE id = ?`,
      [
        status,
        result.customerSlipPrinted ? new Date().toISOString() : current.printed_at,
        result.customerSlipPrinted ? 1 : 0,
        result.customerSlipRoute || current.customer_slip_route || null,
        result.customerSlipPrinted ? null : result.error || null,
        id,
      ],
    );
    return this.getById(id);
  },
};
