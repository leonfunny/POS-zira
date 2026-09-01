import type {
  FabricTagArtwork,
  FabricTagArtworkImportInput,
  FabricTagArtworkPreview,
  FabricTagArtworkPrintRequest,
} from './types';

export interface FabricTagArtworksBridge {
  /** Main-process picker; returns null when the operator cancels. */
  importSource: (input: FabricTagArtworkImportInput) => Promise<FabricTagArtwork | null>;
  /** Attach a validated 160px-wide production PNG to an existing source row. */
  attachProduction: (assetId: string) => Promise<FabricTagArtwork | null>;
  list: () => Promise<FabricTagArtwork[]>;
  getPreview: (assetId: string) => Promise<FabricTagArtworkPreview | null>;
  retire: (assetId: string) => Promise<FabricTagArtwork | null>;
  print: (
    request: FabricTagArtworkPrintRequest,
  ) => Promise<{ success: boolean; error?: string }>;
}

export const FABRIC_TAG_ARTWORK_CHANNELS = {
  importSource: 'pos:fabric-tag-artworks:import-source',
  attachProduction: 'pos:fabric-tag-artworks:attach-production',
  list: 'pos:fabric-tag-artworks:list',
  getPreview: 'pos:fabric-tag-artworks:get-preview',
  retire: 'pos:fabric-tag-artworks:retire',
  print: 'pos:fabric-tag-artworks:print',
} as const satisfies Record<keyof FabricTagArtworksBridge, string>;

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createFabricTagArtworksBridge(invoke: Invoke): FabricTagArtworksBridge {
  return {
    importSource: (input) => invoke(
      FABRIC_TAG_ARTWORK_CHANNELS.importSource,
      input,
    ) as Promise<FabricTagArtwork | null>,
    attachProduction: (assetId) => invoke(
      FABRIC_TAG_ARTWORK_CHANNELS.attachProduction,
      assetId,
    ) as Promise<FabricTagArtwork | null>,
    list: () => invoke(FABRIC_TAG_ARTWORK_CHANNELS.list) as Promise<FabricTagArtwork[]>,
    getPreview: (assetId) => invoke(
      FABRIC_TAG_ARTWORK_CHANNELS.getPreview,
      assetId,
    ) as Promise<FabricTagArtworkPreview | null>,
    retire: (assetId) => invoke(
      FABRIC_TAG_ARTWORK_CHANNELS.retire,
      assetId,
    ) as Promise<FabricTagArtwork | null>,
    print: (request) => invoke(
      FABRIC_TAG_ARTWORK_CHANNELS.print,
      request,
    ) as Promise<{ success: boolean; error?: string }>,
  };
}
