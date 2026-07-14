import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbState, fileState, testDatabase, atomicWriteFile } = vi.hoisted(() => {
  const state = { db: null as SqlJsDatabase | null };
  const files = new Map<string, Buffer>();
  return {
    dbState: state,
    fileState: files,
    atomicWriteFile: vi.fn(async (filePath: string, data: Uint8Array) => {
      files.set(filePath, Buffer.from(data));
    }),
    testDatabase: {
      run(sql: string, params?: unknown[]): void {
        state.db!.run(sql, params as any[] | undefined);
      },
      get<T = any>(sql: string, params?: unknown[]): T | null {
        const statement = state.db!.prepare(sql);
        try {
          if (params) statement.bind(params as any[]);
          return statement.step() ? statement.getAsObject() as T : null;
        } finally {
          statement.free();
        }
      },
      all<T = any>(sql: string, params?: unknown[]): T[] {
        const statement = state.db!.prepare(sql);
        try {
          if (params) statement.bind(params as any[]);
          const rows: T[] = [];
          while (statement.step()) rows.push(statement.getAsObject() as T);
          return rows;
        } finally {
          statement.free();
        }
      },
      markDirty: vi.fn(),
      saveCoalesced: vi.fn(async () => ({ success: true, dbPath: 'test.db' })),
    },
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/zira-product-admin-outbox-tests' },
}));

vi.mock('../src/main/database/database', () => ({ database: testDatabase }));
vi.mock('../src/main/database/atomic-write', () => ({ atomicWriteFile }));
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (filePath: string) => {
    const value = fileState.get(filePath);
    if (!value) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Buffer.from(value);
  }),
  readdir: vi.fn(async (root: string) => Array.from(fileState.keys())
    .filter((filePath) => filePath.startsWith(`${root}/`))
    .map((filePath) => filePath.slice(root.length + 1))),
  rm: vi.fn(async (filePath: string) => {
    fileState.delete(filePath);
  }),
  stat: vi.fn(async () => ({ isFile: () => true, mtimeMs: Date.now() })),
}));

import { migrations } from '../src/main/database/migrations';
import { productAdminMutationOutboxRepo } from '../src/main/database/repos/product-admin-mutation-outbox-repo';
import {
  ProductAdminMutationOutbox,
  productAdminMutationTenantKey,
} from '../src/main/pos/product-admin-mutation-outbox';

const scope = {
  serverUrl: 'https://api.enail.pro/',
  salonId: 'salon-1',
  deviceId: 'till-1',
};

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  dbState.db = new SQL.Database();
  const migration = migrations.find((candidate) => candidate.version === 55);
  if (!migration) throw new Error('missing product-admin outbox migration');
  dbState.db.run(migration.up);
  fileState.clear();
  vi.clearAllMocks();
  testDatabase.saveCoalesced.mockResolvedValue({ success: true, dbPath: 'test.db' });
});

function crashReload(): void {
  const snapshot = dbState.db!.export();
  dbState.db!.close();
  dbState.db = new SQL.Database(snapshot);
}

describe('product-admin mutation outbox', () => {
  it('enforces tenant/idempotency identity and preserves exact bytes across a DB reload', () => {
    const tenantKey = productAdminMutationTenantKey(scope);
    const row = productAdminMutationOutboxRepo.enqueue({
      mutationId: 'mutation-1',
      tenantKey,
      deviceId: scope.deviceId,
      mutationType: 'CREATE_PRODUCT',
      idempotencyKey: 'create-key-1',
      intentHash: 'intent-1',
      requestJson: '{"payload":{"name":"Tea","priceGrossGrosze":1250}}',
    });
    expect(row.status).toBe('PENDING');

    crashReload();
    expect(productAdminMutationOutboxRepo.getById('mutation-1')).toMatchObject({
      tenant_key: tenantKey,
      device_id: 'till-1',
      idempotency_key: 'create-key-1',
      intent_hash: 'intent-1',
      request_json: '{"payload":{"name":"Tea","priceGrossGrosze":1250}}',
      status: 'PENDING',
    });

    expect(() => productAdminMutationOutboxRepo.enqueue({
      tenantKey,
      deviceId: scope.deviceId,
      mutationType: 'CREATE_PRODUCT',
      idempotencyKey: 'create-key-1',
      intentHash: 'different-intent',
      requestJson: '{"payload":{"name":"Coffee","priceGrossGrosze":1250}}',
    })).toThrowError(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 409,
    }));
  });

  it('re-applies a durable COMMITTED image response after a crash without repeating HTTP', async () => {
    const response = {
      variant: { id: 'variant-1', name: 'Tea', updatedAt: '2026-07-14T10:00:00.000Z' },
      receipt: { unitCostGrosze: 700 },
    };
    const firstDispatch = vi.fn(async (_row, request, bytes: Buffer | null) => {
      expect(request).toEqual({
        payload: {
          expectedUpdatedAt: '2026-07-14T09:00:00.000Z',
          fileName: 'tea.webp',
          mimeType: 'image/webp',
        },
      });
      expect(bytes?.toString('utf8')).toBe('exact-image-bytes');
      return response;
    });
    const firstApply = vi.fn(async () => {
      throw new Error('simulated process crash before local mirror');
    });
    const first = new ProductAdminMutationOutbox({
      getScope: () => scope,
      dispatch: firstDispatch,
      apply: firstApply,
      sanitizeResponse: (value: any) => ({ ...value, receipt: {} }),
    });

    await expect(first.execute({
      mutationType: 'UPLOAD_MAIN_IMAGE',
      targetVariantId: 'variant-1',
      request: {
        payload: {
          mimeType: 'image/webp',
          fileName: 'tea.webp',
          expectedUpdatedAt: '2026-07-14T09:00:00.000Z',
        },
      },
      stagedImage: {
        bytes: Buffer.from('exact-image-bytes'),
        mimeType: 'image/webp',
        fileName: 'tea.webp',
      },
    })).rejects.toThrow('simulated process crash');

    const committed = testDatabase.get<any>(
      'SELECT * FROM product_admin_mutation_outbox LIMIT 1',
    )!;
    expect(committed.status).toBe('COMMITTED');
    expect(committed.request_json).toBe('{}');
    expect(JSON.parse(committed.response_json)).toEqual({
      receipt: {},
      variant: response.variant,
    });
    expect(fileState.has(committed.staged_file_path)).toBe(true);
    expect(productAdminMutationOutboxRepo.listStagedFilePaths(committed.tenant_key)
      .has(committed.staged_file_path)).toBe(false);

    crashReload();
    const replayDispatch = vi.fn();
    const replayApply = vi.fn(async (_row, savedResponse) => {
      expect(savedResponse).toEqual({ receipt: {}, variant: response.variant });
    });
    const replay = new ProductAdminMutationOutbox({
      getScope: () => scope,
      dispatch: replayDispatch,
      apply: replayApply,
    });
    await replay.replayPending();

    expect(replayDispatch).not.toHaveBeenCalled();
    expect(replayApply).toHaveBeenCalledOnce();
    expect(productAdminMutationOutboxRepo.getById(committed.mutation_id)?.status).toBe('APPLIED');
    expect(fileState.has(committed.staged_file_path)).toBe(false);
  });

  it('scrubs protected costs from APPLIED and FAILED_FINAL rows while preserving idempotency identity', async () => {
    const createResponse = {
      variant: { id: 'variant-cost', updatedAt: '2026-07-14T10:00:00.000Z' },
      purchasePriceGrosze: 875,
    };
    const createDispatch = vi.fn(async () => createResponse);
    const createApply = vi.fn();
    const createOutbox = new ProductAdminMutationOutbox({
      getScope: () => scope,
      dispatch: createDispatch,
      apply: createApply,
      sanitizeResponse: (value: any) => ({ variant: value.variant }),
    });
    const createInput = {
      mutationType: 'CREATE_PRODUCT' as const,
      idempotencyKey: 'create-protected-cost',
      request: {
        payload: {
          name: 'Tea',
          priceGrossGrosze: 1250,
          purchasePriceGrosze: 875,
        },
      },
    };

    await expect(createOutbox.execute(createInput)).resolves.toEqual(createResponse);
    const applied = testDatabase.get<any>(
      'SELECT * FROM product_admin_mutation_outbox WHERE idempotency_key = ?',
      ['create-protected-cost'],
    )!;
    expect(applied).toMatchObject({ status: 'APPLIED', request_json: '{}' });
    expect(JSON.stringify(applied)).not.toContain('purchasePriceGrosze');

    // A same-key retry is identified by the immutable intent hash after the
    // request body has been scrubbed; it must not issue HTTP again.
    await expect(createOutbox.execute(createInput)).resolves.toEqual({
      variant: createResponse.variant,
    });
    expect(createDispatch).toHaveBeenCalledOnce();
    expect(createApply).toHaveBeenCalledOnce();

    const rejected = Object.assign(new Error('invalid expiry date'), {
      code: 'INVALID_EXPIRY',
      status: 422,
    });
    const receiveDispatch = vi.fn(async () => {
      throw rejected;
    });
    const receiveOutbox = new ProductAdminMutationOutbox({
      getScope: () => scope,
      dispatch: receiveDispatch,
      apply: vi.fn(),
    });
    const receiveInput = {
      mutationType: 'RECEIVE_STOCK' as const,
      targetVariantId: 'variant-cost',
      idempotencyKey: 'receive-protected-cost',
      request: {
        payload: {
          quantity: 2,
          unitCostGrosze: 650,
          expectedUpdatedAt: '2026-07-14T10:00:00.000Z',
        },
      },
    };

    await expect(receiveOutbox.execute(receiveInput)).rejects.toThrow('invalid expiry date');
    const failed = testDatabase.get<any>(
      'SELECT * FROM product_admin_mutation_outbox WHERE idempotency_key = ?',
      ['receive-protected-cost'],
    )!;
    expect(failed).toMatchObject({ status: 'FAILED_FINAL', request_json: '{}' });
    expect(JSON.stringify(failed)).not.toContain('unitCostGrosze');

    await expect(receiveOutbox.execute(receiveInput)).rejects.toThrow('invalid expiry date');
    expect(receiveDispatch).toHaveBeenCalledOnce();
  });

  it('leaves an ambiguous request asleep until eligible, then the next periodic replay drains it exactly', async () => {
    const unavailable = Object.assign(new Error('gateway unavailable'), {
      code: 'UPSTREAM_ERROR',
      status: 503,
    });
    const dispatch = vi.fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({
        variant: { id: 'variant-2', updatedAt: '2026-07-14T10:00:00.000Z' },
      });
    const apply = vi.fn();
    const outbox = new ProductAdminMutationOutbox({
      getScope: () => scope,
      dispatch,
      apply,
    });
    const request = {
      payload: {
        mode: 'recount',
        newQuantity: 12,
        expectedUpdatedAt: '2026-07-14T09:00:00.000Z',
      },
    };

    await expect(outbox.execute({
      mutationType: 'ADJUST_STOCK',
      targetVariantId: 'variant-2',
      idempotencyKey: 'stock-key-2',
      request,
    })).rejects.toThrow('gateway unavailable');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(testDatabase.get<any>(
      'SELECT status, next_attempt_at FROM product_admin_mutation_outbox LIMIT 1',
    )).toMatchObject({ status: 'IN_FLIGHT', next_attempt_at: expect.any(String) });

    await outbox.replayPending();
    expect(dispatch).toHaveBeenCalledTimes(1);

    testDatabase.run(
      "UPDATE product_admin_mutation_outbox SET next_attempt_at = datetime('now', '-1 second')",
    );
    crashReload();
    await outbox.replayPending();

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      idempotency_key: 'stock-key-2',
      attempts: 2,
    });
    expect(dispatch.mock.calls[1][1]).toEqual(request);
    expect(apply).toHaveBeenCalledOnce();
    expect(testDatabase.get<any>(
      'SELECT status FROM product_admin_mutation_outbox LIMIT 1',
    )?.status).toBe('APPLIED');
  });

  it('keeps ambiguity sticky across a later definitive 4xx until canonical success', async () => {
    const dispatch = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('response lost'), {
        code: 'NETWORK_ERROR',
        status: 503,
      }))
      .mockRejectedValueOnce(Object.assign(new Error('stale revision'), {
        code: 'REVISION_CONFLICT',
        status: 409,
      }))
      .mockResolvedValueOnce({
        variant: { id: 'variant-sticky', updatedAt: '2026-07-14T12:00:00.000Z' },
      });
    const apply = vi.fn();
    const outbox = new ProductAdminMutationOutbox({
      getScope: () => scope,
      dispatch,
      apply,
    });

    await expect(outbox.execute({
      mutationType: 'UPLOAD_MAIN_IMAGE',
      targetVariantId: 'variant-sticky',
      request: {
        payload: {
          mimeType: 'image/webp',
          fileName: 'sticky.webp',
          expectedUpdatedAt: '2026-07-14T10:00:00.000Z',
        },
      },
      stagedImage: {
        bytes: Buffer.from('sticky-image-bytes'),
        mimeType: 'image/webp',
        fileName: 'sticky.webp',
      },
    })).rejects.toThrow('response lost');

    let row = testDatabase.get<any>(
      'SELECT * FROM product_admin_mutation_outbox LIMIT 1',
    )!;
    expect(row).toMatchObject({ status: 'IN_FLIGHT', outcome_ambiguous: 1 });
    expect(fileState.has(row.staged_file_path)).toBe(true);
    expect(productAdminMutationOutboxRepo.listStagedFilePaths(row.tenant_key)
      .has(row.staged_file_path)).toBe(true);

    testDatabase.run(
      "UPDATE product_admin_mutation_outbox SET next_attempt_at = datetime('now', '-1 second')",
    );
    await outbox.replayPending();

    row = productAdminMutationOutboxRepo.getById(row.mutation_id)!;
    expect(row).toMatchObject({
      status: 'IN_FLIGHT',
      outcome_ambiguous: 1,
      last_error_code: 'REVISION_CONFLICT',
    });
    expect(row.request_json).toContain('sticky.webp');
    expect(fileState.has(row.staged_file_path!)).toBe(true);

    testDatabase.run(
      "UPDATE product_admin_mutation_outbox SET next_attempt_at = datetime('now', '-1 second')",
    );
    await outbox.replayPending();

    row = productAdminMutationOutboxRepo.getById(row.mutation_id)!;
    expect(row).toMatchObject({
      status: 'APPLIED',
      outcome_ambiguous: 0,
      request_json: '{}',
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenCalledOnce();
    expect(fileState.has(row.staged_file_path!)).toBe(false);
    expect(productAdminMutationOutboxRepo.listStagedFilePaths(row.tenant_key)
      .has(row.staged_file_path)).toBe(false);
  });

  it('treats a crash-left IN_FLIGHT row as ambiguous before claiming its replay', async () => {
    const tenantKey = productAdminMutationTenantKey(scope);
    const requestJson = '{"payload":{"mode":"recount","newQuantity":4}}';
    const row = productAdminMutationOutboxRepo.enqueue({
      mutationId: 'crash-after-server',
      tenantKey,
      deviceId: scope.deviceId,
      mutationType: 'ADJUST_STOCK',
      targetVariantId: 'variant-crash',
      idempotencyKey: 'stock-key-crash',
      intentHash: 'intent-crash',
      requestJson,
    });
    productAdminMutationOutboxRepo.markInFlight(row.mutation_id);
    crashReload();

    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error('later conflict'), {
        code: 'REVISION_CONFLICT',
        status: 409,
      });
    });
    const replay = new ProductAdminMutationOutbox({
      getScope: () => scope,
      dispatch,
      apply: vi.fn(),
    });
    await replay.replayPending();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(productAdminMutationOutboxRepo.getById(row.mutation_id)).toMatchObject({
      status: 'IN_FLIGHT',
      attempts: 2,
      outcome_ambiguous: 1,
      last_error_code: 'REVISION_CONFLICT',
      request_json: requestJson,
    });
  });

  it('keeps execute and periodic replay single-flight while the canonical request is in flight', async () => {
    let resolveCanonical!: (value: unknown) => void;
    const canonicalResponse = {
      variant: { id: 'variant-race', updatedAt: '2026-07-14T11:00:00.000Z' },
    };
    const dispatch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveCanonical = resolve;
      }))
      // Without the per-mutation single-flight guard, periodic replay reaches
      // this definitive response before the first request acknowledges success
      // and can poison the durable row as FAILED_FINAL.
      .mockRejectedValueOnce(Object.assign(new Error('duplicate request conflict'), {
        code: 'DUPLICATE_REQUEST',
        status: 409,
      }));
    const apply = vi.fn();
    const outbox = new ProductAdminMutationOutbox({
      getScope: () => scope,
      dispatch,
      apply,
    });

    const executePromise = outbox.execute({
      mutationType: 'ADJUST_STOCK',
      targetVariantId: 'variant-race',
      idempotencyKey: 'stock-key-race',
      request: {
        payload: {
          mode: 'recount',
          newQuantity: 8,
          expectedUpdatedAt: '2026-07-14T10:00:00.000Z',
        },
      },
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

    const listReplayable = vi.spyOn(productAdminMutationOutboxRepo, 'listReplayable');
    const replayPromise = outbox.replayPending();
    await vi.waitFor(() => expect(listReplayable).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBeforeCanonicalSuccess = dispatch.mock.calls.length;

    resolveCanonical(canonicalResponse);
    await expect(executePromise).resolves.toEqual(canonicalResponse);
    await replayPromise;

    expect(callsBeforeCanonicalSuccess).toBe(1);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(productAdminMutationOutboxRepo.getById(
      testDatabase.get<any>('SELECT mutation_id FROM product_admin_mutation_outbox LIMIT 1')!.mutation_id,
    )?.status).toBe('APPLIED');
  });
});
