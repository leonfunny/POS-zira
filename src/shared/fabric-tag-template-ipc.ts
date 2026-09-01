import type { FabricTagTemplate } from './types';

export interface FabricTagTemplatesBridge {
  list: () => Promise<FabricTagTemplate[]>;
  listIds: () => Promise<string[]>;
  get: (templateId: string) => Promise<FabricTagTemplate | null>;
  save: (template: FabricTagTemplate) => Promise<FabricTagTemplate | null>;
  remove: (templateId: string) => Promise<void>;
}

/**
 * One contract for every process that participates in fabric-tag template IPC.
 * Keeping the method-to-channel mapping here prevents the main-window and POS
 * preloads from silently drifting apart.
 */
export const FABRIC_TAG_TEMPLATE_CHANNELS = {
  list: 'pos:fabric-tag-templates:list',
  listIds: 'pos:fabric-tag-templates:listIds',
  get: 'pos:fabric-tag-templates:get',
  save: 'pos:fabric-tag-templates:save',
  remove: 'pos:fabric-tag-templates:remove',
} as const satisfies Record<keyof FabricTagTemplatesBridge, string>;

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createFabricTagTemplatesBridge(invoke: Invoke): FabricTagTemplatesBridge {
  return {
    list: () => invoke(FABRIC_TAG_TEMPLATE_CHANNELS.list) as Promise<FabricTagTemplate[]>,
    listIds: () => invoke(FABRIC_TAG_TEMPLATE_CHANNELS.listIds) as Promise<string[]>,
    get: (templateId) =>
      invoke(FABRIC_TAG_TEMPLATE_CHANNELS.get, templateId) as Promise<FabricTagTemplate | null>,
    save: (template) =>
      invoke(FABRIC_TAG_TEMPLATE_CHANNELS.save, template) as Promise<FabricTagTemplate | null>,
    remove: (templateId) =>
      invoke(FABRIC_TAG_TEMPLATE_CHANNELS.remove, templateId) as Promise<void>,
  };
}
