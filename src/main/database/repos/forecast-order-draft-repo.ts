import { randomUUID } from 'crypto';
import type {
  ForecastOrderDraftCreateInput,
  ForecastOrderDraftDTO,
  ForecastOrderDraftLineDTO,
  ForecastOrderDraftStatus,
} from '../../../shared/types';
import { database } from '../database';

function toInt(value: unknown, fallback = 0): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapLine(row: any): ForecastOrderDraftLineDTO {
  return {
    id: String(row.id),
    draftId: String(row.draft_id),
    variantId: String(row.variant_id),
    name: String(row.name || ''),
    sku: row.sku ?? null,
    barcode: row.barcode ?? null,
    supplierName: row.supplier_name ?? null,
    stockOnHand: toInt(row.stock_on_hand),
    velocity7d: toNumber(row.velocity_7d),
    velocity30d: toNumber(row.velocity_30d),
    suggestedOrderQty: toInt(row.suggested_order_qty),
    orderQty: toInt(row.order_qty),
    unitValue: toInt(row.unit_value),
    estimatedRetailValue: toInt(row.estimated_retail_value),
    reason: String(row.reason || ''),
    sortOrder: toInt(row.sort_order),
  };
}

function mapDraft(row: any, lines: ForecastOrderDraftLineDTO[] = []): ForecastOrderDraftDTO {
  return {
    id: String(row.id),
    status: (row.status || 'draft') as ForecastOrderDraftStatus,
    sourceRunId: row.source_run_id ?? null,
    asOfDate: String(row.as_of_date),
    notes: row.notes ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    itemCount: toInt(row.item_count),
    totalQty: toInt(row.total_qty),
    totalEstimatedRetailValue: toInt(row.total_estimated_retail_value),
    lines,
  };
}

export const forecastOrderDraftRepo = {
  create(input: ForecastOrderDraftCreateInput): ForecastOrderDraftDTO {
    const lines = input.lines
      .map((line) => ({
        ...line,
        variantId: line.variantId.trim(),
        name: line.name.trim(),
        orderQty: Math.max(0, toInt(line.orderQty)),
        suggestedOrderQty: Math.max(0, toInt(line.suggestedOrderQty)),
        stockOnHand: Math.max(0, toInt(line.stockOnHand)),
        unitValue: Math.max(0, toInt(line.unitValue)),
        velocity7d: Math.max(0, toNumber(line.velocity7d)),
        velocity30d: Math.max(0, toNumber(line.velocity30d)),
        supplierName: line.supplierName?.trim() || null,
        reason: line.reason.trim() || 'Forecast recommendation',
      }))
      .filter((line) => line.variantId && line.name && line.orderQty > 0);

    if (lines.length === 0) {
      throw new Error('Draft must contain at least one item with quantity above zero.');
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const totalQty = lines.reduce((sum, line) => sum + line.orderQty, 0);
    const totalEstimatedRetailValue = lines.reduce((sum, line) => sum + line.orderQty * line.unitValue, 0);

    database.transaction(() => {
      database.run(
        `INSERT INTO forecast_order_drafts (
           id, source_run_id, as_of_date, status, notes, item_count, total_qty,
           total_estimated_retail_value, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.sourceRunId ?? null,
          input.asOfDate,
          'draft',
          input.notes?.trim() || null,
          lines.length,
          totalQty,
          totalEstimatedRetailValue,
          now,
          now,
        ],
      );

      lines.forEach((line, index) => {
        database.run(
          `INSERT INTO forecast_order_draft_lines (
             id, draft_id, variant_id, name, sku, barcode, supplier_name,
             stock_on_hand, velocity_7d, velocity_30d, suggested_order_qty,
             order_qty, unit_value, estimated_retail_value, reason, sort_order
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            id,
            line.variantId,
            line.name,
            line.sku ?? null,
            line.barcode ?? null,
            line.supplierName,
            line.stockOnHand,
            line.velocity7d,
            line.velocity30d,
            line.suggestedOrderQty,
            line.orderQty,
            line.unitValue,
            line.orderQty * line.unitValue,
            line.reason,
            index,
          ],
        );
      });
    });

    return this.getById(id)!;
  },

  listRecent(limit = 10): ForecastOrderDraftDTO[] {
    const rows = database.all<any>(
      `SELECT *
       FROM forecast_order_drafts
       ORDER BY created_at DESC
       LIMIT ?`,
      [Math.max(1, Math.min(50, toInt(limit, 10)))],
    );
    return rows.map((row) => mapDraft(row));
  },

  getById(id: string): ForecastOrderDraftDTO | null {
    const draft = database.get<any>('SELECT * FROM forecast_order_drafts WHERE id = ?', [id]);
    if (!draft) return null;
    const lines = database.all<any>(
      `SELECT *
       FROM forecast_order_draft_lines
       WHERE draft_id = ?
       ORDER BY sort_order ASC, name ASC`,
      [id],
    ).map(mapLine);
    return mapDraft(draft, lines);
  },
};
