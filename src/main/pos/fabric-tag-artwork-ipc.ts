import {
  BrowserWindow,
  dialog,
  type IpcMain,
  type IpcMainInvokeEvent,
} from 'electron';

import { FABRIC_TAG_ARTWORK_CHANNELS } from '../../shared/fabric-tag-artwork-ipc';
import type {
  FabricTagArtwork,
  FabricTagArtworkPreview,
  FabricTagArtworkPrintRequest,
} from '../../shared/types';
import {
  type FabricTagArtworkService,
  validateFabricTagArtworkAssetId,
  validateFabricTagArtworkMetadata,
  validateFabricTagArtworkPrintRequest,
} from './fabric-tag-artwork-service';

type IpcHandleRegistrar = Pick<IpcMain, 'handle'>;

export type FabricTagArtworkPickerKind = 'source' | 'production';

export interface FabricTagArtworkIpcDependencies {
  service: Pick<
    FabricTagArtworkService,
    'importSource' | 'attachProduction' | 'list' | 'getPreview' | 'retire'
  >;
  getSalonId: () => unknown;
  print: (request: FabricTagArtworkPrintRequest) => Promise<{ success: boolean; error?: string }>;
  /** Test seam; production always uses Electron's native file picker below. */
  pickFile?: (
    event: IpcMainInvokeEvent,
    kind: FabricTagArtworkPickerKind,
  ) => Promise<string | null>;
}

async function inCurrentSalon<T>(
  dependencies: FabricTagArtworkIpcDependencies,
  salonId: unknown,
  operation: (salonId: unknown) => Promise<T>,
): Promise<T> {
  const result = await operation(salonId);
  if (String(dependencies.getSalonId() ?? '').trim() !== String(salonId ?? '').trim()) {
    throw new Error('Salon changed while fabric artwork was being processed; retry');
  }
  return result;
}

async function pickArtworkFile(
  event: IpcMainInvokeEvent,
  kind: FabricTagArtworkPickerKind,
): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: kind === 'source'
      ? 'Import customer fabric-label artwork'
      : 'Attach production PNG',
    properties: ['openFile'],
    filters: kind === 'source'
      ? [{ name: 'Fabric artwork', extensions: ['btw', 'png'] }]
      : [{ name: 'Production PNG', extensions: ['png'] }],
  };
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length !== 1) return null;
  return result.filePaths[0];
}

/**
 * Register the complete artwork-library boundary. Paths enter only through a
 * trusted main-process picker and are never accepted from the renderer.
 */
export function registerFabricTagArtworkIpcHandlers(
  ipc: IpcHandleRegistrar,
  dependencies: FabricTagArtworkIpcDependencies,
): void {
  const pickFile = dependencies.pickFile ?? pickArtworkFile;

  ipc.handle(FABRIC_TAG_ARTWORK_CHANNELS.importSource, async (event, input: unknown) => {
    // Reject malformed metadata before interrupting the operator with a dialog.
    const metadata = validateFabricTagArtworkMetadata(input);
    // Capture ownership before the native dialog. The operator can leave the
    // salon while it is open; a file/form selected under salon A must never be
    // imported into whatever salon happens to be active afterwards.
    const salonId = dependencies.getSalonId();
    const selectedPath = await pickFile(event, 'source');
    if (!selectedPath) return null;
    if (String(dependencies.getSalonId() ?? '').trim() !== String(salonId ?? '').trim()) {
      throw new Error('Salon changed while the artwork picker was open; retry in the current salon');
    }
    return inCurrentSalon(dependencies, salonId, (capturedSalonId) =>
      dependencies.service.importSource(
        capturedSalonId,
        metadata,
        selectedPath,
      ),
    );
  });

  ipc.handle(FABRIC_TAG_ARTWORK_CHANNELS.attachProduction, async (event, input: unknown) => {
    const assetId = validateFabricTagArtworkAssetId(input);
    const salonId = dependencies.getSalonId();
    const selectedPath = await pickFile(event, 'production');
    if (!selectedPath) return null;
    if (String(dependencies.getSalonId() ?? '').trim() !== String(salonId ?? '').trim()) {
      throw new Error('Salon changed while the artwork picker was open; retry in the current salon');
    }
    return inCurrentSalon(dependencies, salonId, (capturedSalonId) =>
      dependencies.service.attachProduction(
        capturedSalonId,
        assetId,
        selectedPath,
      ),
    );
  });

  ipc.handle(
    FABRIC_TAG_ARTWORK_CHANNELS.list,
    (): FabricTagArtwork[] => dependencies.service.list(dependencies.getSalonId()),
  );

  ipc.handle(
    FABRIC_TAG_ARTWORK_CHANNELS.getPreview,
    (_event, input: unknown): Promise<FabricTagArtworkPreview | null> => {
      const assetId = validateFabricTagArtworkAssetId(input);
      const salonId = dependencies.getSalonId();
      return inCurrentSalon(dependencies, salonId, (capturedSalonId) =>
        dependencies.service.getPreview(capturedSalonId, assetId),
      );
    },
  );

  ipc.handle(
    FABRIC_TAG_ARTWORK_CHANNELS.retire,
    (_event, input: unknown): Promise<FabricTagArtwork> => {
      const assetId = validateFabricTagArtworkAssetId(input);
      const salonId = dependencies.getSalonId();
      return inCurrentSalon(dependencies, salonId, (capturedSalonId) =>
        dependencies.service.retire(capturedSalonId, assetId),
      );
    },
  );

  ipc.handle(FABRIC_TAG_ARTWORK_CHANNELS.print, (_event, input: unknown) =>
    dependencies.print(validateFabricTagArtworkPrintRequest(input)),
  );
}
