import { database } from '../database';
import type { CareSymbol, FabricTagData } from '../../../shared/types';
import { isCareSymbol } from '../../../shared/types';
import logger from '../../logger';

/**
 * Care-label content for a garment style.
 *
 * Temporarily keyed by the catalogue `template_id`, which groups the rows for
 * one style. On the first measured LOTUS data those sibling rows are colours,
 * not sizes, so this repository must not infer size from them. The owner-provided
 * size list will be added by a later migration once its data contract is fixed.
 */
export interface FabricTagTemplateRow {
  template_id: string;
  brand_name: string | null;
  logo_data_url: string | null;
  composition: string | null;
  /** JSON array of CareSymbol. Stored as text because SQLite has no arrays. */
  care_symbols: string | null;
  care_text: string | null;
  fabric: string | null;
  layout: string;
  backend_id: string | null;
  synced: number;
  synced_at: string | null;
  updated_at: string | null;
}

/** What the renderer edits and the print path consumes. */
export interface FabricTagTemplate {
  templateId: string;
  brandName: string | null;
  logoDataUrl: string | null;
  composition: string | null;
  careSymbols: CareSymbol[];
  careText: string | null;
  fabric: string | null;
  layout: FabricTagData['layout'];
}

/**
 * Care symbols round-trip through JSON, so a corrupt or hand-edited row must
 * not take the print path down with it. Unknown symbols are dropped rather
 * than passed on: the renderer draws them as vector art and an unrecognised
 * name would silently print nothing where a washing instruction should be.
 */
function parseCareSymbols(raw: string | null, templateId: string): CareSymbol[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const known = parsed.filter(isCareSymbol);
    if (known.length !== parsed.length) {
      logger.warn(
        `[FabricTagTemplate] ${parsed.length - known.length} unknown care symbol(s) dropped for ${templateId}`,
      );
    }
    return known;
  } catch {
    logger.warn(`[FabricTagTemplate] Unreadable care_symbols for ${templateId}; treating as none`);
    return [];
  }
}

function toTemplate(row: FabricTagTemplateRow): FabricTagTemplate {
  return {
    templateId: row.template_id,
    brandName: row.brand_name,
    logoDataUrl: row.logo_data_url,
    composition: row.composition,
    careSymbols: parseCareSymbols(row.care_symbols, row.template_id),
    careText: row.care_text,
    fabric: row.fabric,
    layout: row.layout === 'care-first' ? 'care-first' : 'default',
  };
}

export const fabricTagTemplateRepo = {
  get(templateId: string): FabricTagTemplate | null {
    const row = database.get<FabricTagTemplateRow>(
      'SELECT * FROM fabric_tag_templates WHERE template_id = ?',
      [templateId],
    );
    return row ? toTemplate(row) : null;
  },

  /** Template ids that have care-label content, for marking them in the UI. */
  listTemplateIds(): string[] {
    const rows = database.all<{ template_id: string }>(
      `SELECT template_id
       FROM fabric_tag_templates
       WHERE TRIM(COALESCE(brand_name, '')) <> ''
          OR TRIM(COALESCE(logo_data_url, '')) <> ''`,
    );
    return rows.map((row) => row.template_id);
  },

  list(): FabricTagTemplate[] {
    // Keep this legacy summary endpoint blob-free. A valid logo can be 512KiB;
    // selecting every logo into SQL.js and structured-cloning the result can
    // multiply hundreds of MiB across main/renderer. Call get(id) for the one
    // template whose full payload is actually needed.
    const rows = database.all<FabricTagTemplateRow>(
      `SELECT template_id, brand_name, NULL AS logo_data_url, composition,
              care_symbols, care_text, fabric, layout, backend_id, synced,
              synced_at, updated_at
       FROM fabric_tag_templates
       ORDER BY updated_at DESC`,
    );
    return rows.map(toTemplate);
  },

  /**
   * Insert or replace a style's care label.
   *
   * `synced` is reset to 0 on every write: the row has changed and whatever
   * the server last saw is now stale. Nothing consumes that flag yet, but a
   * write that forgot to clear it would be invisible until sync ships and then
   * silently skip the row.
   */
  save(template: FabricTagTemplate): void {
    database.run(
      `INSERT INTO fabric_tag_templates (
         template_id, brand_name, logo_data_url, composition, care_symbols,
         care_text, fabric, layout, synced, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
       ON CONFLICT(template_id) DO UPDATE SET
         brand_name = excluded.brand_name,
         logo_data_url = excluded.logo_data_url,
         composition = excluded.composition,
         care_symbols = excluded.care_symbols,
         care_text = excluded.care_text,
         fabric = excluded.fabric,
         layout = excluded.layout,
         synced = 0,
         updated_at = datetime('now')`,
      [
        template.templateId,
        template.brandName ?? null,
        template.logoDataUrl ?? null,
        template.composition ?? null,
        JSON.stringify(template.careSymbols ?? []),
        template.careText ?? null,
        template.fabric ?? null,
        template.layout === 'care-first' ? 'care-first' : 'default',
      ],
    );
  },

  remove(templateId: string): void {
    database.run('DELETE FROM fabric_tag_templates WHERE template_id = ?', [templateId]);
  },
};
