import type { IpcMain } from 'electron';
import { FABRIC_TAG_LIMITS, type FabricTagTemplate } from '../../shared/types';
import { FABRIC_TAG_TEMPLATE_CHANNELS } from '../../shared/fabric-tag-template-ipc';
import {
  parseFabricTagCareSymbols,
  parseFabricTagLogoDataUrl,
  parseFabricTagText,
} from '../hardware/tsc/fabric-tag-input';

/** Backward-compatible export; template and print jobs share one policy. */
export const FABRIC_TAG_TEMPLATE_LIMITS = FABRIC_TAG_LIMITS;

export interface FabricTagTemplateRepository {
  list(): unknown;
  listTemplateIds(): unknown;
  get(templateId: string): unknown;
  save(template: FabricTagTemplate): void;
  remove(templateId: string): unknown;
}

type IpcHandleRegistrar = Pick<IpcMain, 'handle'>;

export function parseFabricTagTemplateId(value: unknown): string {
  return parseFabricTagText(
    value,
    'templateId',
    FABRIC_TAG_TEMPLATE_LIMITS.templateId,
    { context: 'fabric tag template', required: true },
  )!;
}

function nullableString(
  record: Record<string, unknown>,
  field: 'brandName' | 'composition' | 'careText' | 'fabric',
): string | null {
  return parseFabricTagText(
    record[field],
    field,
    FABRIC_TAG_TEMPLATE_LIMITS[field],
    { context: 'fabric tag template' },
  );
}

function nullableLogoDataUrl(record: Record<string, unknown>): string | null {
  return parseFabricTagLogoDataUrl(record.logoDataUrl, 'fabric tag template')?.dataUrl ?? null;
}

/**
 * The parts a composition line was built from, checked the way every other
 * field here is. A malformed list is refused rather than trimmed to something
 * plausible: the renderer builds it from a fixed picker, so anything else
 * arriving is a bug worth hearing about, not a shape to guess at.
 */
function parseFabricTagMaterials(value: unknown): { name: string; percent: number }[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('Invalid fabric tag template materials: expected an array');
  }
  if (value.length > FABRIC_TAG_TEMPLATE_LIMITS.materials) {
    throw new TypeError(
      `Invalid fabric tag template materials: at most ${FABRIC_TAG_TEMPLATE_LIMITS.materials} entries`,
    );
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError('Invalid fabric tag template material: expected an object');
    }
    const record = entry as Record<string, unknown>;
    const name = parseFabricTagText(
      record.name,
      'material name',
      FABRIC_TAG_TEMPLATE_LIMITS.materialName,
      { context: 'fabric tag template', required: true },
    )!;
    const percent = Number(record.percent ?? 0);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new TypeError('Invalid fabric tag template material percent: expected 0-100');
    }
    return { name, percent: Math.floor(percent) };
  });
}

/** Validate and normalize untrusted renderer input before it reaches SQLite. */
export function parseFabricTagTemplateInput(value: unknown): FabricTagTemplate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid fabric tag template payload: expected an object');
  }

  const record = value as Record<string, unknown>;
  const careSymbols = parseFabricTagCareSymbols(record.careSymbols, 'fabric tag template');

  const rawLayout = record.layout;
  if (rawLayout != null && rawLayout !== 'default' && rawLayout !== 'care-first') {
    throw new TypeError('Invalid fabric tag template layout: expected "default" or "care-first"');
  }

  return {
    templateId: parseFabricTagTemplateId(record.templateId),
    brandName: nullableString(record, 'brandName'),
    logoDataUrl: nullableLogoDataUrl(record),
    composition: nullableString(record, 'composition'),
    careSymbols,
    careText: nullableString(record, 'careText'),
    materials: parseFabricTagMaterials(record.materials),
    fabric: nullableString(record, 'fabric'),
    layout: rawLayout ?? 'default',
  };
}

function assertFabricTagTemplateHasIdentity(template: FabricTagTemplate): void {
  if (!template.brandName && !template.logoDataUrl) {
    throw new TypeError(
      'Invalid fabric tag template: brandName or logoDataUrl is required before saving',
    );
  }
}

export function registerFabricTagTemplateIpcHandlers(
  ipc: IpcHandleRegistrar,
  repository: FabricTagTemplateRepository,
): void {
  ipc.handle(FABRIC_TAG_TEMPLATE_CHANNELS.list, () => repository.list());
  ipc.handle(FABRIC_TAG_TEMPLATE_CHANNELS.listIds, () => repository.listTemplateIds());
  ipc.handle(FABRIC_TAG_TEMPLATE_CHANNELS.get, (_event, templateId: unknown) =>
    repository.get(parseFabricTagTemplateId(templateId)),
  );
  ipc.handle(FABRIC_TAG_TEMPLATE_CHANNELS.save, (_event, input: unknown) => {
    const template = parseFabricTagTemplateInput(input);
    // The print boundary requires the same identity. Rejecting it here avoids
    // persisting a template that appears in listIds but can never be printed.
    assertFabricTagTemplateHasIdentity(template);
    repository.save(template);
    return repository.get(template.templateId);
  });
  ipc.handle(FABRIC_TAG_TEMPLATE_CHANNELS.remove, (_event, templateId: unknown) =>
    repository.remove(parseFabricTagTemplateId(templateId)),
  );
}
