import { createHash, randomUUID } from 'crypto';
import { app, nativeImage } from 'electron';
import { access, mkdir, open } from 'fs/promises';
import * as path from 'path';

import {
  FABRIC_TAG_ARTWORK_LIMITS,
  FABRIC_TAG_ARTWORK_MEDIA,
  type FabricTagArtwork,
  type FabricTagArtworkImportInput,
  type FabricTagArtworkPreview,
  type FabricTagArtworkPrintRequest,
} from '../../shared/types';
import { readRasterImageDimensions } from '../../shared/fabric-tag-image';
import { atomicWriteFile } from '../database/atomic-write';
import { database } from '../database/database';
import {
  fabricTagArtworkRepo,
  toFabricTagArtwork,
  type FabricTagArtworkRow,
} from '../database/repos/fabric-tag-artwork-repo';
import {
  assertNoHorizontalEdgeContact,
  packFabricTagMonochrome,
  type MonoBitmap,
} from '../hardware/tsc/fabric-tag-renderer';
import logger from '../logger';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SHA256 = /^[a-f0-9]{64}$/;
const BTW_HEADER = '\r\nBar Tender Format File\r\n';
const WHITE_MARGIN_CHANNEL_FLOOR = 245;

export class FabricTagArtworkInputError extends TypeError {
  readonly failureClass = 'FINAL' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FabricTagArtworkInputError';
  }
}

function invalid(message: string): never {
  throw new FabricTagArtworkInputError(message);
}

function boundedText(
  value: unknown,
  field: string,
  maximum: number,
  required = true,
): string | null {
  if (value == null) {
    if (required) invalid(`Invalid fabric artwork ${field}: a value is required`);
    return null;
  }
  if (typeof value !== 'string') invalid(`Invalid fabric artwork ${field}: expected text`);
  const text = value.trim();
  if (required && !text) invalid(`Invalid fabric artwork ${field}: a value is required`);
  if (text.length > maximum) {
    invalid(`Invalid fabric artwork ${field}: maximum ${maximum} characters`);
  }
  if (CONTROL_CHARACTERS.test(text)) {
    invalid(`Invalid fabric artwork ${field}: control characters are not allowed`);
  }
  return text || null;
}

function assertOnlyFields(record: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    invalid(`Invalid ${context}: unexpected field${unexpected.length === 1 ? '' : 's'} ${unexpected.join(', ')}`);
  }
}

export function validateFabricTagArtworkMetadata(
  value: unknown,
): Required<Omit<FabricTagArtworkImportInput, 'orderCode'>> & { orderCode: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Invalid fabric artwork metadata: expected an object');
  }
  const record = value as Record<string, unknown>;
  assertOnlyFields(
    record,
    ['customerName', 'orderCode', 'variant', 'revision'],
    'fabric artwork metadata',
  );
  return {
    customerName: boundedText(
      record.customerName,
      'customerName',
      FABRIC_TAG_ARTWORK_LIMITS.customerName,
    )!,
    orderCode: boundedText(
      record.orderCode,
      'orderCode',
      FABRIC_TAG_ARTWORK_LIMITS.orderCode,
      false,
    ),
    variant: boundedText(
      record.variant,
      'variant',
      FABRIC_TAG_ARTWORK_LIMITS.variant,
    )!,
    revision: boundedText(
      record.revision,
      'revision',
      FABRIC_TAG_ARTWORK_LIMITS.revision,
    )!,
  };
}

export function validateFabricTagArtworkAssetId(value: unknown): string {
  return boundedText(value, 'assetId', 128)!;
}

export function validateFabricTagArtworkPrintRequest(
  value: unknown,
): FabricTagArtworkPrintRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Invalid fabric artwork print request: expected an object');
  }
  const record = value as Record<string, unknown>;
  assertOnlyFields(record, ['assetId', 'quantity'], 'fabric artwork print request');
  const assetId = validateFabricTagArtworkAssetId(record.assetId);
  const quantity = record.quantity;
  if (
    typeof quantity !== 'number'
    || !Number.isSafeInteger(quantity)
    || quantity < 1
    || quantity > FABRIC_TAG_ARTWORK_LIMITS.quantity
  ) {
    invalid(
      `Invalid fabric artwork quantity: expected an integer from 1 to ${FABRIC_TAG_ARTWORK_LIMITS.quantity}`,
    );
  }
  return { assetId, quantity };
}

export function validateBtwSource(bytes: Uint8Array, filename = 'artwork.btw'): void {
  if (path.extname(filename).toLowerCase() !== '.btw') {
    invalid('BarTender source must use the .btw extension');
  }
  if (bytes.byteLength < BTW_HEADER.length || bytes.byteLength > FABRIC_TAG_ARTWORK_LIMITS.sourceBytes) {
    invalid(`BarTender source must be between ${BTW_HEADER.length} and ${FABRIC_TAG_ARTWORK_LIMITS.sourceBytes} bytes`);
  }
  const header = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 128))).toString('ascii');
  if (!header.startsWith(BTW_HEADER) || !header.includes('Bar Tender Format File')) {
    invalid('BarTender source header is missing or unsupported');
  }
}

export interface DecodedFabricArtworkPng {
  widthPx: number;
  heightPx: number;
  /** BGRA, four bytes per full-canvas pixel. */
  bgra: Buffer;
}

export interface ValidatedFabricArtworkPng extends DecodedFabricArtworkPng {
  physicalWidthMm: number;
  physicalLengthMm: number;
  printableBitmap: MonoBitmap;
}

export type FabricArtworkPngDecoder = (bytes: Buffer) => DecodedFabricArtworkPng;

function decodePngWithElectron(bytes: Buffer): DecodedFabricArtworkPng {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) invalid('Production PNG could not be decoded');
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  return { widthPx: width, heightPx: height, bgra };
}

function isVisuallyWhite(bgra: Buffer, offset: number): boolean {
  const alpha = bgra[offset + 3] / 255;
  const composite = (channel: number) => channel * alpha + 255 * (1 - alpha);
  return composite(bgra[offset]) >= WHITE_MARGIN_CHANNEL_FLOOR
    && composite(bgra[offset + 1]) >= WHITE_MARGIN_CHANNEL_FLOOR
    && composite(bgra[offset + 2]) >= WHITE_MARGIN_CHANNEL_FLOOR;
}

/** Crop the two verified nine-dot safety margins, retaining the central 142 dots. */
export function cropFabricArtworkCanvas(
  bgra: Buffer,
  widthPx: number,
  heightPx: number,
): Buffer {
  if (widthPx !== FABRIC_TAG_ARTWORK_MEDIA.fullCanvasWidthPx) {
    invalid(`Production PNG width must be exactly ${FABRIC_TAG_ARTWORK_MEDIA.fullCanvasWidthPx}px`);
  }
  const expected = widthPx * heightPx * 4;
  if (bgra.byteLength !== expected) {
    invalid(`Decoded production PNG returned ${bgra.byteLength} bytes; expected ${expected}`);
  }

  const inset = FABRIC_TAG_ARTWORK_MEDIA.edgeInsetPx;
  const printableWidth = FABRIC_TAG_ARTWORK_MEDIA.printableWidthPx;
  const cropped = Buffer.alloc(printableWidth * heightPx * 4);

  for (let y = 0; y < heightPx; y += 1) {
    const rowOffset = y * widthPx * 4;
    for (let x = 0; x < inset; x += 1) {
      if (!isVisuallyWhite(bgra, rowOffset + x * 4)) {
        invalid(`Production PNG needs a white ${inset}px left safety margin (ink at x=${x}, y=${y})`);
      }
    }
    for (let x = widthPx - inset; x < widthPx; x += 1) {
      if (!isVisuallyWhite(bgra, rowOffset + x * 4)) {
        invalid(`Production PNG needs a white ${inset}px right safety margin (ink at x=${x}, y=${y})`);
      }
    }
    bgra.copy(
      cropped,
      y * printableWidth * 4,
      rowOffset + inset * 4,
      rowOffset + (inset + printableWidth) * 4,
    );
  }
  return cropped;
}

export function validateProductionPng(
  bytes: Buffer,
  decoder: FabricArtworkPngDecoder = decodePngWithElectron,
): ValidatedFabricArtworkPng {
  if (bytes.byteLength < 33 || bytes.byteLength > FABRIC_TAG_ARTWORK_LIMITS.productionPngBytes) {
    invalid(`Production PNG must be between 33 and ${FABRIC_TAG_ARTWORK_LIMITS.productionPngBytes} bytes`);
  }

  let declared: { width: number; height: number };
  try {
    declared = readRasterImageDimensions(bytes, 'image/png');
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  if (declared.width !== FABRIC_TAG_ARTWORK_MEDIA.fullCanvasWidthPx) {
    invalid(
      `Production PNG width must be exactly ${FABRIC_TAG_ARTWORK_MEDIA.fullCanvasWidthPx}px for 20mm media; got ${declared.width}px`,
    );
  }
  if (
    declared.height < FABRIC_TAG_ARTWORK_MEDIA.minHeightPx
    || declared.height > FABRIC_TAG_ARTWORK_MEDIA.maxHeightPx
  ) {
    invalid(
      `Production PNG height must be ${FABRIC_TAG_ARTWORK_MEDIA.minHeightPx}-${FABRIC_TAG_ARTWORK_MEDIA.maxHeightPx}px; got ${declared.height}px`,
    );
  }

  let decoded: DecodedFabricArtworkPng;
  try {
    decoded = decoder(bytes);
  } catch (error) {
    if (error instanceof FabricTagArtworkInputError) throw error;
    invalid(`Production PNG could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (decoded.widthPx !== declared.width || decoded.heightPx !== declared.height) {
    invalid(
      `Production PNG decoded dimensions ${decoded.widthPx}x${decoded.heightPx} do not match its header ${declared.width}x${declared.height}`,
    );
  }

  const cropped = cropFabricArtworkCanvas(decoded.bgra, decoded.widthPx, decoded.heightPx);
  const printableBitmap = packFabricTagMonochrome(
    cropped,
    FABRIC_TAG_ARTWORK_MEDIA.printableWidthPx,
    decoded.heightPx,
  );
  assertNoHorizontalEdgeContact(printableBitmap);
  if (printableBitmap.data.every((byte) => byte === 0xff)) {
    invalid('Production PNG is blank and contains no printable ink');
  }
  return {
    ...decoded,
    physicalWidthMm: FABRIC_TAG_ARTWORK_MEDIA.physicalWidthMm,
    physicalLengthMm: decoded.heightPx / FABRIC_TAG_ARTWORK_MEDIA.dotsPerMm,
    printableBitmap,
  };
}

interface FabricTagArtworkServiceDeps {
  userDataPath?: () => string;
  now?: () => string;
  id?: () => string;
  decodePng?: FabricArtworkPngDecoder;
  persist?: () => Promise<void>;
  tenantGeneration?: () => number;
  /** Test seam for bounded handle reads; production opens the selected path read-only. */
  openFile?: (filePath: string) => Promise<{
    stat: () => Promise<{ size: number; isFile: () => boolean }>;
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: null,
    ) => Promise<{ bytesRead: number }>;
    close: () => Promise<void>;
  }>;
}

export interface LoadedFabricTagArtworkProduction {
  artwork: FabricTagArtwork;
  bitmap: MonoBitmap;
  physicalLengthMm: number;
  salonId: string;
  tenantGeneration: number;
  /** Main-process-only row identity used to fence the final RAW dispatch. */
  dispatchFence: {
    sourceSha256: string;
    productionPath: string;
    productionSha256: string;
    widthPx: number;
    heightPx: number;
    physicalWidthMm: number;
    physicalLengthMm: number;
    updatedAt: string;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tenantKey(salonId: string): string {
  return createHash('sha256').update(salonId.trim().toLowerCase(), 'utf8').digest('hex');
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class FabricTagArtworkService {
  private readonly userDataPath: () => string;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly decoder: FabricArtworkPngDecoder;
  private readonly persist: () => Promise<void>;
  private readonly tenantGeneration: () => number;
  private readonly openFile: NonNullable<FabricTagArtworkServiceDeps['openFile']>;

  constructor(deps: FabricTagArtworkServiceDeps = {}) {
    this.userDataPath = deps.userDataPath ?? (() => app.getPath('userData'));
    this.now = deps.now ?? (() => new Date().toISOString());
    this.id = deps.id ?? randomUUID;
    this.decoder = deps.decodePng ?? decodePngWithElectron;
    this.tenantGeneration = deps.tenantGeneration ?? (() => database.getTenantGeneration());
    this.openFile = deps.openFile ?? ((filePath) => open(filePath, 'r'));
    this.persist = deps.persist ?? (async () => {
      const result = await database.saveCoalesced(5_000);
      if (!result.success) {
        throw new Error(`Could not persist fabric artwork metadata: ${result.error || 'unknown error'}`);
      }
    });
  }

  private requireSalonId(value: unknown): string {
    return boundedText(value, 'salonId', 128)!;
  }

  private assertTenantGeneration(expected: number): void {
    if (this.tenantGeneration() !== expected) {
      invalid('Salon changed while fabric artwork was being processed; retry in the current salon');
    }
  }

  private async persistMetadata(): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      // Persistence details may contain the user-data or database path. Keep
      // that diagnostic in the main-process log and expose only a stable,
      // path-free message across Electron IPC.
      logger.error('[FabricTagArtworkService] Failed to persist artwork metadata:', error);
      throw new Error('Fabric artwork metadata could not be saved');
    }
  }

  private assertAttachableBtwRow(row: FabricTagArtworkRow): void {
    if (
      row.source_type !== 'BTW'
      || row.status !== 'NEEDS_CONVERSION'
      || row.production_filename !== null
      || row.production_sha256 !== null
      || row.production_path !== null
      || row.width_px !== null
      || row.height_px !== null
      || row.physical_width_mm !== null
      || row.physical_length_mm !== null
    ) {
      invalid(
        'Production PNG can only be attached once to a BarTender source awaiting conversion; import a new revision instead',
      );
    }
  }

  private rootForSalon(salonId: string): string {
    return path.join(this.userDataPath(), 'fabric-tag-artworks', tenantKey(salonId));
  }

  private async readBoundedFile(filePath: string, maximum: number): Promise<Buffer> {
    let handle: Awaited<ReturnType<NonNullable<FabricTagArtworkServiceDeps['openFile']>>>;
    try {
      // Keep one OS handle from validation through EOF. A path-based stat
      // followed by readFile lets a network share/OneDrive client replace the
      // path with a much larger file between those two operations.
      handle = await this.openFile(filePath);
    } catch {
      invalid('Artwork file is unavailable');
    }
    try {
      let initialInfo: Awaited<ReturnType<typeof handle.stat>>;
      try {
        initialInfo = await handle.stat();
      } catch {
        invalid('Artwork file is unavailable');
      }
      if (!initialInfo.isFile()) invalid('Selected artwork source is not a regular file');
      if (initialInfo.size < 1 || initialInfo.size > maximum) {
        invalid(`Selected artwork source must be 1-${maximum} bytes; got ${initialInfo.size}`);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= maximum) {
        // Read at most maximum+1 in fixed chunks. The extra byte proves an
        // in-flight growth crossed the limit without ever allocating the
        // attacker-controlled post-stat size.
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
        let bytesRead: number;
        try {
          ({ bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null));
        } catch {
          invalid('Artwork file is unavailable');
        }
        if (bytesRead === 0) break;
        total += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }

      if (total > maximum) invalid('Selected artwork source changed size while being imported');
      let finalInfo: Awaited<ReturnType<typeof handle.stat>>;
      try {
        finalInfo = await handle.stat();
      } catch {
        invalid('Artwork file is unavailable');
      }
      if (total < 1 || total !== initialInfo.size || finalInfo.size !== total) {
        invalid('Selected artwork source changed size while being imported');
      }
      return Buffer.concat(chunks, total);
    } finally {
      try {
        await handle.close();
      } catch (error) {
        logger.warn('[FabricTagArtworkService] Failed to close an artwork file handle:', error);
      }
    }
  }

  private async writeImmutable(
    salonId: string,
    bucket: 'sources' | 'production',
    digest: string,
    extension: '.btw' | '.png',
    bytes: Buffer,
  ): Promise<string> {
    if (!SHA256.test(digest)) throw new Error('Invalid artwork storage digest');
    const root = this.rootForSalon(salonId);
    const directory = path.join(root, bucket);
    const target = path.join(directory, `${digest}${extension}`);
    if (!isPathInside(root, target)) throw new Error('Resolved artwork storage path escaped its salon root');
    try {
      await mkdir(directory, { recursive: true });
    } catch {
      throw new Error('Artwork managed storage is unavailable');
    }
    if (await pathExists(target)) {
      const existing = await this.readBoundedFile(
        target,
        bucket === 'production'
          ? FABRIC_TAG_ARTWORK_LIMITS.productionPngBytes
          : FABRIC_TAG_ARTWORK_LIMITS.sourceBytes,
      );
      if (sha256(existing) !== digest) {
        throw new Error('Immutable artwork storage hash mismatch');
      }
      return target;
    }
    try {
      await atomicWriteFile(target, bytes);
    } catch {
      throw new Error('Artwork could not be copied into managed storage');
    }
    return target;
  }

  private assertStoredPath(salonId: string, storedPath: string): void {
    if (!isPathInside(this.rootForSalon(salonId), storedPath)) {
      throw new FabricTagArtworkInputError('Artwork file is outside the current salon storage');
    }
  }

  async importSource(
    salonIdInput: unknown,
    metadataInput: unknown,
    selectedPath: string,
  ): Promise<FabricTagArtwork> {
    const salonId = this.requireSalonId(salonIdInput);
    const tenantGeneration = this.tenantGeneration();
    const metadata = validateFabricTagArtworkMetadata(metadataInput);
    const originalFilename = boundedText(
      path.basename(selectedPath),
      'filename',
      FABRIC_TAG_ARTWORK_LIMITS.originalFilename,
    )!;
    const extension = path.extname(originalFilename).toLowerCase();
    if (extension !== '.btw' && extension !== '.png') {
      invalid('Artwork source must be a .btw or .png file');
    }

    const maximum = extension === '.png'
      ? FABRIC_TAG_ARTWORK_LIMITS.productionPngBytes
      : FABRIC_TAG_ARTWORK_LIMITS.sourceBytes;
    const bytes = await this.readBoundedFile(selectedPath, maximum);
    this.assertTenantGeneration(tenantGeneration);
    const sourceSha256 = sha256(bytes);
    let production: ValidatedFabricArtworkPng | null = null;
    if (extension === '.btw') validateBtwSource(bytes, originalFilename);
    else production = validateProductionPng(bytes, this.decoder);

    const sourcePath = await this.writeImmutable(
      salonId,
      'sources',
      sourceSha256,
      extension,
      bytes,
    );
    this.assertTenantGeneration(tenantGeneration);
    const now = this.now();
    const artwork = fabricTagArtworkRepo.insert({
      id: this.id(),
      salonId,
      customerName: metadata.customerName,
      orderCode: metadata.orderCode,
      variant: metadata.variant,
      revision: metadata.revision,
      originalFilename,
      sourceType: extension === '.btw' ? 'BTW' : 'PNG',
      status: production ? 'READY' : 'NEEDS_CONVERSION',
      sourceSha256,
      sourcePath,
      productionFilename: production ? originalFilename : null,
      productionSha256: production ? sourceSha256 : null,
      productionPath: production ? sourcePath : null,
      widthPx: production?.widthPx ?? null,
      heightPx: production?.heightPx ?? null,
      physicalWidthMm: production?.physicalWidthMm ?? null,
      physicalLengthMm: production?.physicalLengthMm ?? null,
      now,
    });
    await this.persistMetadata();
    return artwork;
  }

  async attachProduction(
    salonIdInput: unknown,
    assetIdInput: unknown,
    selectedPath: string,
  ): Promise<FabricTagArtwork> {
    const salonId = this.requireSalonId(salonIdInput);
    const tenantGeneration = this.tenantGeneration();
    const assetId = validateFabricTagArtworkAssetId(assetIdInput);
    const existing = fabricTagArtworkRepo.getRow(salonId, assetId);
    if (!existing) invalid('Fabric artwork was not found for the current salon');
    this.assertAttachableBtwRow(existing);

    const filename = boundedText(
      path.basename(selectedPath),
      'filename',
      FABRIC_TAG_ARTWORK_LIMITS.originalFilename,
    )!;
    if (path.extname(filename).toLowerCase() !== '.png') {
      invalid('Production artwork must use the .png extension');
    }
    const bytes = await this.readBoundedFile(
      selectedPath,
      FABRIC_TAG_ARTWORK_LIMITS.productionPngBytes,
    );
    this.assertTenantGeneration(tenantGeneration);
    const validated = validateProductionPng(bytes, this.decoder);
    const digest = sha256(bytes);
    const productionPath = await this.writeImmutable(
      salonId,
      'production',
      digest,
      '.png',
      bytes,
    );
    this.assertTenantGeneration(tenantGeneration);
    const current = fabricTagArtworkRepo.getRow(salonId, assetId);
    if (
      !current
      || current.source_sha256 !== existing.source_sha256
      || current.source_path !== existing.source_path
      || current.updated_at !== existing.updated_at
    ) {
      invalid('Fabric artwork changed while its production PNG was being attached; import a new revision instead');
    }
    this.assertAttachableBtwRow(current);
    const updated = fabricTagArtworkRepo.attachProduction(salonId, assetId, {
      productionFilename: filename,
      productionSha256: digest,
      productionPath,
      widthPx: validated.widthPx,
      heightPx: validated.heightPx,
      physicalWidthMm: validated.physicalWidthMm,
      physicalLengthMm: validated.physicalLengthMm,
      now: this.now(),
    });
    if (!updated || updated.status !== 'READY') {
      throw new Error('Production artwork could not be attached');
    }
    await this.persistMetadata();
    return updated;
  }

  list(salonIdInput: unknown): FabricTagArtwork[] {
    return fabricTagArtworkRepo.list(this.requireSalonId(salonIdInput));
  }

  async getPreview(
    salonIdInput: unknown,
    assetIdInput: unknown,
  ): Promise<FabricTagArtworkPreview | null> {
    const salonId = this.requireSalonId(salonIdInput);
    const tenantGeneration = this.tenantGeneration();
    const assetId = validateFabricTagArtworkAssetId(assetIdInput);
    const row = fabricTagArtworkRepo.getRow(salonId, assetId);
    if (!row || row.status === 'RETIRED' || !row.production_path) return null;
    const { bytes, validated } = await this.readAndValidateProduction(
      salonId,
      row,
      tenantGeneration,
    );
    return {
      assetId,
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      widthPx: validated.widthPx,
      heightPx: validated.heightPx,
    };
  }

  async retire(salonIdInput: unknown, assetIdInput: unknown): Promise<FabricTagArtwork> {
    const salonId = this.requireSalonId(salonIdInput);
    const assetId = validateFabricTagArtworkAssetId(assetIdInput);
    if (!fabricTagArtworkRepo.getRow(salonId, assetId)) {
      invalid('Fabric artwork was not found for the current salon');
    }
    const retired = fabricTagArtworkRepo.retire(salonId, assetId, this.now());
    if (!retired || retired.status !== 'RETIRED') throw new Error('Fabric artwork could not be retired');
    await this.persistMetadata();
    return retired;
  }

  private async readAndValidateProduction(
    salonId: string,
    row: FabricTagArtworkRow,
    tenantGeneration: number,
  ): Promise<{
    bytes: Buffer;
    validated: ValidatedFabricArtworkPng;
    currentRow: FabricTagArtworkRow;
  }> {
    if (
      row.status !== 'READY'
      || !row.production_path
      || !row.production_sha256
      || !SHA256.test(row.production_sha256)
    ) {
      invalid('Fabric artwork does not have a printable production PNG');
    }
    this.assertStoredPath(salonId, row.production_path);
    const bytes = await this.readBoundedFile(
      row.production_path,
      FABRIC_TAG_ARTWORK_LIMITS.productionPngBytes,
    );
    this.assertTenantGeneration(tenantGeneration);
    if (sha256(bytes) !== row.production_sha256) {
      invalid('Production PNG hash no longer matches the imported artwork');
    }
    const validated = validateProductionPng(bytes, this.decoder);
    if (
      row.width_px !== validated.widthPx
      || row.height_px !== validated.heightPx
      || Number(row.physical_width_mm) !== validated.physicalWidthMm
      || Number(row.physical_length_mm) !== validated.physicalLengthMm
    ) {
      invalid('Production PNG metadata no longer matches the imported artwork');
    }
    this.assertTenantGeneration(tenantGeneration);
    const currentRow = fabricTagArtworkRepo.getRow(salonId, row.id);
    if (
      !currentRow
      || currentRow.status !== 'READY'
      || currentRow.production_path !== row.production_path
      || currentRow.production_sha256 !== row.production_sha256
      || currentRow.width_px !== row.width_px
      || currentRow.height_px !== row.height_px
      || Number(currentRow.physical_width_mm) !== Number(row.physical_width_mm)
      || Number(currentRow.physical_length_mm) !== Number(row.physical_length_mm)
    ) {
      invalid('Fabric artwork changed while its production PNG was being validated; retry');
    }
    return { bytes, validated, currentRow };
  }

  async loadProductionForPrint(
    salonIdInput: unknown,
    requestInput: unknown,
  ): Promise<LoadedFabricTagArtworkProduction & { quantity: number }> {
    const salonId = this.requireSalonId(salonIdInput);
    const tenantGeneration = this.tenantGeneration();
    const request = validateFabricTagArtworkPrintRequest(requestInput);
    const row = fabricTagArtworkRepo.getRow(salonId, request.assetId);
    if (!row) invalid('Fabric artwork was not found for the current salon');
    const { validated, currentRow } = await this.readAndValidateProduction(
      salonId,
      row,
      tenantGeneration,
    );
    return {
      artwork: toFabricTagArtwork(currentRow),
      bitmap: validated.printableBitmap,
      physicalLengthMm: validated.physicalLengthMm,
      salonId,
      tenantGeneration,
      dispatchFence: {
        sourceSha256: currentRow.source_sha256,
        productionPath: currentRow.production_path!,
        productionSha256: currentRow.production_sha256!,
        widthPx: currentRow.width_px!,
        heightPx: currentRow.height_px!,
        physicalWidthMm: Number(currentRow.physical_width_mm),
        physicalLengthMm: Number(currentRow.physical_length_mm),
        updatedAt: currentRow.updated_at,
      },
      quantity: request.quantity,
    };
  }

  /**
   * Synchronous final fence for the boundary immediately before RAW dispatch.
   * File decoding and printer preflight are asynchronous, so the current row
   * and tenant generation must still match the exact bytes already rendered.
   */
  assertProductionCurrentForDispatch(loaded: LoadedFabricTagArtworkProduction): void {
    this.assertTenantGeneration(loaded.tenantGeneration);
    const current = fabricTagArtworkRepo.getRow(loaded.salonId, loaded.artwork.id);
    const fence = loaded.dispatchFence;
    if (
      !current
      || current.salon_id !== loaded.salonId
      || current.status !== 'READY'
      || current.source_sha256 !== fence.sourceSha256
      || current.production_path !== fence.productionPath
      || current.production_sha256 !== fence.productionSha256
      || current.width_px !== fence.widthPx
      || current.height_px !== fence.heightPx
      || Number(current.physical_width_mm) !== fence.physicalWidthMm
      || Number(current.physical_length_mm) !== fence.physicalLengthMm
      || current.updated_at !== fence.updatedAt
    ) {
      invalid('Fabric artwork changed before it reached the printer; retry with the current revision');
    }
  }
}

export const fabricTagArtworkService = new FabricTagArtworkService();
