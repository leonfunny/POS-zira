import type { IpcMain } from 'electron';
import { isCareSymbol, type FabricTagTemplate } from '../../shared/types';
import { FABRIC_TAG_TEMPLATE_CHANNELS } from '../../shared/fabric-tag-template-ipc';

export interface FabricTagTemplateRepository {
  list(): unknown;
  listTemplateIds(): unknown;
  get(templateId: string): unknown;
  save(template: FabricTagTemplate): void;
  remove(templateId: string): unknown;
}

type IpcHandleRegistrar = Pick<IpcMain, 'handle'>;

function invalid(field: string, expected: string): never {
  throw new TypeError(`Invalid fabric tag template ${field}: expected ${expected}`);
}

export function parseFabricTagTemplateId(value: unknown): string {
  if (typeof value !== 'string') invalid('templateId', 'a non-empty string');
  const templateId = value.trim();
  if (!templateId) invalid('templateId', 'a non-empty string');
  return templateId;
}

function nullableString(
  record: Record<string, unknown>,
  field: keyof Omit<FabricTagTemplate, 'templateId' | 'careSymbols' | 'layout'>,
): string | null {
  const value = record[field];
  if (value == null) return null;
  if (typeof value !== 'string') invalid(String(field), 'a string or null');
  return value;
}

/** Validate and normalize untrusted renderer input before it reaches SQLite. */
export function parseFabricTagTemplateInput(value: unknown): FabricTagTemplate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('payload', 'an object');
  }

  const record = value as Record<string, unknown>;
  const rawCareSymbols = record.careSymbols;
  if (rawCareSymbols != null && !Array.isArray(rawCareSymbols)) {
    invalid('careSymbols', 'an array');
  }
  // Array.from materializes sparse slots as undefined so they cannot bypass
  // Array.prototype.every and reach persistence as invalid symbols.
  const careSymbols = rawCareSymbols == null ? [] : Array.from(rawCareSymbols);
  if (!careSymbols.every(isCareSymbol)) {
    invalid('careSymbols', 'only supported care symbols');
  }

  const rawLayout = record.layout;
  if (rawLayout != null && rawLayout !== 'default' && rawLayout !== 'care-first') {
    invalid('layout', '"default" or "care-first"');
  }

  return {
    templateId: parseFabricTagTemplateId(record.templateId),
    brandName: nullableString(record, 'brandName'),
    logoDataUrl: nullableString(record, 'logoDataUrl'),
    composition: nullableString(record, 'composition'),
    careSymbols: [...careSymbols],
    careText: nullableString(record, 'careText'),
    fabric: nullableString(record, 'fabric'),
    layout: rawLayout ?? 'default',
  };
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
    repository.save(template);
    return repository.get(template.templateId);
  });
  ipc.handle(FABRIC_TAG_TEMPLATE_CHANNELS.remove, (_event, templateId: unknown) =>
    repository.remove(parseFabricTagTemplateId(templateId)),
  );
}
