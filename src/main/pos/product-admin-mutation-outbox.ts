import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import { mkdir, readFile, readdir, rm, stat } from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile } from '../database/atomic-write';
import { database } from '../database/database';
import {
  productAdminMutationOutboxRepo,
  type ProductAdminMutationOutboxRow,
  type ProductAdminMutationType,
} from '../database/repos/product-admin-mutation-outbox-repo';

export interface ProductAdminMutationScope {
  serverUrl: string;
  salonId: string;
  deviceId: string;
}

export interface ProductAdminStagedImageInput {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface ExecuteProductAdminMutationInput {
  mutationType: ProductAdminMutationType;
  targetVariantId?: string | null;
  idempotencyKey?: string | null;
  request: Record<string, unknown>;
  stagedImage?: ProductAdminStagedImageInput;
}

interface ProductAdminMutationOutboxDeps {
  getScope: () => ProductAdminMutationScope;
  dispatch: (
    row: ProductAdminMutationOutboxRow,
    request: Record<string, unknown>,
    stagedImage: Buffer | null,
  ) => Promise<unknown>;
  apply: (
    row: ProductAdminMutationOutboxRow,
    response: unknown,
  ) => Promise<void> | void;
  sanitizeResponse?: (response: unknown) => unknown;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source).sort().map((key) => [key, stableValue(source[key])]),
  );
}

export function stableProductAdminMutationJson(value: unknown): string {
  const encoded = JSON.stringify(stableValue(value));
  return encoded === undefined ? 'null' : encoded;
}

export function productAdminMutationTenantKey(scope: ProductAdminMutationScope): string {
  const serverUrl = String(scope.serverUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  const salonId = String(scope.salonId || '').trim().toLowerCase();
  const deviceId = String(scope.deviceId || '').trim();
  if (!serverUrl || !salonId || !deviceId) {
    const error = new Error('product-admin-mutation-scope-incomplete') as Error & { code?: string };
    error.code = 'SALON_CONTEXT_MISMATCH';
    throw error;
  }
  return createHash('sha256')
    .update(stableProductAdminMutationJson({ serverUrl, salonId, deviceId }), 'utf8')
    .digest('hex');
}

function mutationIntentHash(
  mutationType: ProductAdminMutationType,
  targetVariantId: string | null,
  requestJson: string,
  stagedFileHash: string | null,
): string {
  return createHash('sha256')
    .update(stableProductAdminMutationJson({
      mutationType,
      targetVariantId,
      request: JSON.parse(requestJson),
      stagedFileHash,
    }), 'utf8')
    .digest('hex');
}

function mutationAssetRoot(tenantKey: string): string {
  return path.join(app.getPath('userData'), 'product-admin-pending', tenantKey);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isDefinitiveMutationError(error: any): boolean {
  const status = Number(error?.status);
  const code = String(error?.code || '').toUpperCase();
  if (status === 401 || status === 408 || status === 425 || status === 429
    || status >= 500
    || code === 'UNAUTHORIZED_PRODUCT_ADMIN'
    || code === 'UNSUPPORTED_CAPABILITY'
    || code === 'SALON_CONTEXT_MISMATCH'
    || code.includes('TIMEOUT')
    || code.includes('NETWORK')
    || code.includes('CONNECTION')
    || code.includes('IN_PROGRESS')) return false;
  return Number.isInteger(status) && status >= 400 && status < 500;
}

async function flushRequired(): Promise<void> {
  const result = await database.saveCoalesced(5000);
  if (!result.success) {
    const error = new Error(`product-admin-ledger-flush-failed: ${result.error || 'unknown'}`) as Error & { code?: string };
    error.code = 'LOCAL_DURABILITY_FAILED';
    throw error;
  }
}

export class ProductAdminMutationOutbox {
  private replayPromise: Promise<void> | null = null;
  private readonly dispatchFlights = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ProductAdminMutationOutboxDeps) {}

  async execute(input: ExecuteProductAdminMutationInput): Promise<unknown> {
    const scope = this.deps.getScope();
    const tenantKey = productAdminMutationTenantKey(scope);
    const targetVariantId = String(input.targetVariantId || '').trim() || null;
    const requestJson = stableProductAdminMutationJson(input.request);
    const stagedFileHash = input.stagedImage
      ? createHash('sha256').update(input.stagedImage.bytes).digest('hex')
      : null;
    const intentHash = mutationIntentHash(
      input.mutationType,
      targetVariantId,
      requestJson,
      stagedFileHash,
    );

    const targetPending = targetVariantId
      ? productAdminMutationOutboxRepo.findUnresolvedForTarget(tenantKey, targetVariantId)
      : null;
    if (targetPending && targetPending.intent_hash !== intentHash) {
      const error = new Error('another-product-mutation-is-pending') as Error & {
        code?: string;
        status?: number;
        details?: Record<string, unknown>;
      };
      error.code = 'MUTATION_IN_PROGRESS';
      error.status = 409;
      error.details = { mutationId: targetPending.mutation_id };
      throw error;
    }

    const mutationId = randomUUID();
    let stagedFilePath: string | null = null;
    if (input.stagedImage) {
      const root = mutationAssetRoot(tenantKey);
      await mkdir(root, { recursive: true });
      stagedFilePath = path.join(root, `${mutationId}.bin`);
      await atomicWriteFile(stagedFilePath, Buffer.from(input.stagedImage.bytes));
    }

    let row: ProductAdminMutationOutboxRow;
    try {
      row = productAdminMutationOutboxRepo.enqueue({
        mutationId,
        tenantKey,
        deviceId: scope.deviceId,
        mutationType: input.mutationType,
        targetVariantId,
        idempotencyKey: input.idempotencyKey,
        intentHash,
        requestJson,
        stagedFilePath,
        stagedFileHash,
      });
    } catch (error) {
      if (stagedFilePath) await rm(stagedFilePath, { force: true }).catch(() => undefined);
      throw error;
    }

    if (row.mutation_id !== mutationId && stagedFilePath) {
      await rm(stagedFilePath, { force: true }).catch(() => undefined);
    }
    await flushRequired();
    return this.dispatchRow(row);
  }

  async replayPending(): Promise<void> {
    if (this.replayPromise) return this.replayPromise;
    this.replayPromise = this.replayPendingUnlocked();
    try {
      await this.replayPromise;
    } finally {
      this.replayPromise = null;
    }
  }

  private async replayPendingUnlocked(): Promise<void> {
    const tenantKey = productAdminMutationTenantKey(this.deps.getScope());
    await this.sweepOrphanedStagedFiles(tenantKey);
    for (const row of productAdminMutationOutboxRepo.listReplayable(tenantKey)) {
      try {
        await this.dispatchRow(row);
      } catch {
        // Row state contains the durable outcome/backoff. Continue so one bad
        // mutation cannot starve unrelated products.
      }
    }
  }

  private async sweepOrphanedStagedFiles(tenantKey: string): Promise<void> {
    const root = mutationAssetRoot(tenantKey);
    const referenced = productAdminMutationOutboxRepo.listStagedFilePaths(tenantKey);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of names) {
      const candidate = path.join(root, name);
      if (!isPathInside(root, candidate) || referenced.has(candidate)) continue;
      try {
        const info = await stat(candidate);
        if (info.isFile() && info.mtimeMs < cutoff) await rm(candidate, { force: true });
      } catch {
        // Best-effort hygiene; referenced rows remain protected by the set.
      }
    }
  }

  private dispatchRow(initial: ProductAdminMutationOutboxRow): Promise<unknown> {
    const mutationId = initial.mutation_id;
    const existingFlight = this.dispatchFlights.get(mutationId);
    if (existingFlight) return existingFlight;

    const flight = this.dispatchRowUnlocked(initial);
    this.dispatchFlights.set(mutationId, flight);
    flight.then(
      () => {
        if (this.dispatchFlights.get(mutationId) === flight) {
          this.dispatchFlights.delete(mutationId);
        }
      },
      () => {
        if (this.dispatchFlights.get(mutationId) === flight) {
          this.dispatchFlights.delete(mutationId);
        }
      },
    );
    return flight;
  }

  private async dispatchRowUnlocked(initial: ProductAdminMutationOutboxRow): Promise<unknown> {
    let row = productAdminMutationOutboxRepo.getById(initial.mutation_id) || initial;
    if (row.status === 'COMMITTED') {
      const response = JSON.parse(row.response_json || 'null');
      await this.deps.apply(row, response);
      productAdminMutationOutboxRepo.markApplied(row.mutation_id);
      await flushRequired();
      await this.cleanupStagedFile(row);
      return response;
    }
    if (row.status === 'APPLIED') return JSON.parse(row.response_json || 'null');
    if (row.status === 'FAILED_FINAL') {
      const error = new Error(row.last_error || 'product-admin-mutation-failed') as Error & { code?: string; status?: number };
      error.code = row.last_error_code || undefined;
      error.status = row.last_error_status || 409;
      throw error;
    }

    const hadPriorDispatch = row.status === 'IN_FLIGHT'
      || row.dispatched_at != null
      || row.attempts > 0;
    productAdminMutationOutboxRepo.markInFlight(row.mutation_id);
    await flushRequired();
    row = productAdminMutationOutboxRepo.getById(row.mutation_id)!;
    const outcomeWasAlreadyAmbiguous = row.outcome_ambiguous === 1 || hadPriorDispatch;

    try {
      const request = JSON.parse(row.request_json) as Record<string, unknown>;
      const stagedImage = await this.readStagedImage(row);
      const response = await this.deps.dispatch(row, request, stagedImage);
      const persistedResponse = this.deps.sanitizeResponse
        ? this.deps.sanitizeResponse(response)
        : response;
      productAdminMutationOutboxRepo.markCommitted(
        row.mutation_id,
        stableProductAdminMutationJson(persistedResponse),
      );
      // Critical ordering: commit acknowledgement reaches disk before any
      // local mirror callback or success is returned to the renderer.
      await flushRequired();
      row = productAdminMutationOutboxRepo.getById(row.mutation_id)!;
      await this.deps.apply(row, persistedResponse);
      productAdminMutationOutboxRepo.markApplied(row.mutation_id);
      await flushRequired();
      await this.cleanupStagedFile(row);
      return response;
    } catch (error: any) {
      // The acknowledgement is already durable. A failed local mirror must
      // remain COMMITTED so the next replay applies the saved response without
      // issuing the HTTP mutation again.
      if (row.status === 'COMMITTED') throw error;
      const errorStatus = Number.isInteger(Number(error?.status))
        ? Number(error.status)
        : null;
      if (outcomeWasAlreadyAmbiguous) {
        // Once an earlier HTTP attempt had an ambiguous outcome, a later 4xx
        // cannot prove that the original request did not commit. Keep the
        // exact command replayable until a canonical success is recovered.
        productAdminMutationOutboxRepo.markAmbiguous(
          row.mutation_id,
          String(error?.code || '') || null,
          errorStatus,
          error?.message || String(error),
        );
        await flushRequired();
      } else if (isDefinitiveMutationError(error)) {
        productAdminMutationOutboxRepo.markFailedFinal(
          row.mutation_id,
          String(error?.code || '') || null,
          errorStatus,
          error?.message || String(error),
        );
        await flushRequired();
        await this.cleanupStagedFile(row);
      } else {
        productAdminMutationOutboxRepo.markAmbiguous(
          row.mutation_id,
          String(error?.code || '') || null,
          errorStatus,
          error?.message || String(error),
        );
        await flushRequired();
      }
      throw error;
    }
  }

  private async readStagedImage(row: ProductAdminMutationOutboxRow): Promise<Buffer | null> {
    if (!row.staged_file_path) return null;
    const root = mutationAssetRoot(row.tenant_key);
    if (!isPathInside(root, row.staged_file_path)) {
      const error = new Error('invalid-staged-image-path') as Error & { code?: string; status?: number };
      error.code = 'LOCAL_STAGED_ASSET_INVALID';
      error.status = 422;
      throw error;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(row.staged_file_path);
    } catch {
      const error = new Error('staged-image-missing') as Error & { code?: string; status?: number };
      error.code = 'LOCAL_STAGED_ASSET_MISSING';
      error.status = 422;
      throw error;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== row.staged_file_hash) {
      const error = new Error('staged-image-hash-mismatch') as Error & { code?: string; status?: number };
      error.code = 'LOCAL_STAGED_ASSET_HASH_MISMATCH';
      error.status = 422;
      throw error;
    }
    return bytes;
  }

  private async cleanupStagedFile(row: ProductAdminMutationOutboxRow): Promise<void> {
    if (!row.staged_file_path) return;
    const root = mutationAssetRoot(row.tenant_key);
    if (!isPathInside(root, row.staged_file_path)) return;
    await rm(row.staged_file_path, { force: true }).catch(() => undefined);
  }
}
