import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { createInvoiceBridgeE2eFixture } from '../scripts/create-invoice-bridge-e2e-fixture.mjs';
import {
  E2E_APP_IDENTIFIER,
  E2E_CHANNEL_ID,
  E2E_COMPANY_NIP,
  E2E_IDEMPOTENCY_KEY,
  E2E_ORDER_ID,
  assertE2eSentinel,
  e2eSentinelContents,
  expectedInvoiceDbPath,
  expectedPosDbPath,
  expectedReadyPath,
  expectedTokenPath,
  requireIsolatedLoopbackUrl,
} from '../scripts/invoice-bridge-e2e-common.mjs';
import {
  requirePackagedClientPath,
  runPackagedInvoiceBridgeE2e,
  waitForBridgeE2eReadiness,
} from '../scripts/run-invoice-bridge-e2e.mjs';

const NONCE = 'InvoiceBridgeE2ENonce0123456789ABCDEF';
const EXPECTED_COMMIT = 'a'.repeat(40);
const EXPECTED_TREE = 'b'.repeat(40);
const roots: string[] = [];

function freshRunRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}${randomUUID()}`);
  roots.push(root);
  return root;
}

async function writeInvoiceDb(runRoot: string): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        external_order_id TEXT,
        status TEXT,
        invoice_id TEXT,
        raw_json TEXT
      );
      CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT);
      CREATE TABLE invoices (id TEXT PRIMARY KEY);
      INSERT INTO orders (id, external_order_id, status, invoice_id, raw_json)
      VALUES (
        'local-e2e-1',
        '${E2E_ORDER_ID}',
        'NEW',
        NULL,
        '${JSON.stringify({
          import_source: 'ZIRA_POS_EXACT_BRIDGE_V1',
          bridge_pos_order_id: E2E_ORDER_ID,
          bridge_idempotency_key: E2E_IDEMPOTENCY_KEY,
          order: { id: E2E_ORDER_ID },
        }).replaceAll("'", "''")}'
      );
      INSERT INTO order_items (id, order_id) VALUES ('local-item-e2e-1', 'local-e2e-1');
    `);
    await writeFile(expectedInvoiceDbPath(runRoot), Buffer.from(db.export()), { flag: 'wx' });
  } finally {
    db.close();
  }
}

async function writeReadyManifest(
  runRoot: string,
  overrides: Partial<{ nonce: string; identifier: string; port: number; ready: boolean }> = {},
): Promise<void> {
  await writeFile(expectedReadyPath(runRoot), JSON.stringify({
    version: 1,
    nonce: NONCE,
    identifier: E2E_APP_IDENTIFIER,
    port: 54321,
    ready: true,
    ...overrides,
  }), { flag: 'wx' });
}

function oneRow(db: SqlJsDatabase, sql: string): Record<string, unknown> {
  const statement = db.prepare(sql);
  try {
    expect(statement.step()).toBe(true);
    return statement.getAsObject();
  } finally {
    statement.free();
  }
}

function fakePackagedDependencies(options: { mutateDbPath?: string } = {}) {
  const clientPath = '/virtual/win-unpacked/client.js';
  const tokenHelperPath = '/virtual/win-unpacked/token.js';
  const verifyPackagedPosClient = vi.fn(async () => ({
    posRoot: '/virtual/pos',
    commit: EXPECTED_COMMIT,
    tree: EXPECTED_TREE,
    clientPath,
    tokenHelperPath,
    moduleSha256: {
      'client.js': 'c'.repeat(64),
      'token.js': 'd'.repeat(64),
      'errors.js': 'e'.repeat(64),
      'contract.js': 'f'.repeat(64),
    },
    provenance: {
      ws: {
        runtime: {
          version: '8.21.1',
          treeSha256: '1'.repeat(64),
        },
      },
    },
  }));

  const tokenModule = {
    createZiraInvoiceBridgeFileTokenProvider: ({ tokenPath }: { tokenPath: string }) =>
      async () => (await readFile(tokenPath, 'utf8')).trim(),
  };
  class LocalInvoiceGatewayWebSocketTransport {
    constructor(readonly options: { tokenProvider: () => Promise<string> }) {}
  }
  class ZiraInvoiceBridgeClient {
    private syncs = 0;

    constructor(
      private readonly transport: LocalInvoiceGatewayWebSocketTransport,
    ) {}

    private async authenticate(): Promise<void> {
      if ((await this.transport.options.tokenProvider()).length < 32) {
        throw new Error('bad token');
      }
    }

    async capabilities() {
      await this.authenticate();
      return {
        contractVersion: 1,
        ready: true,
        companyNip: E2E_COMPANY_NIP,
        supportedIntents: ['FISCALISED_RETAIL'],
        channels: [{ id: E2E_CHANNEL_ID, name: 'Zira POS Bridge E2E', enabled: true }],
      };
    }

    async syncPosOrder() {
      await this.authenticate();
      this.syncs += 1;
      return {
        importResult: this.syncs === 1 ? 'IMPORTED' : 'ALREADY_IMPORTED',
        localOrderId: 'local-e2e-1',
        orderState: 'NEW',
        document: null,
      };
    }

    async getDocumentStatus() {
      await this.authenticate();
      if (options.mutateDbPath) {
        await writeFile(options.mutateDbPath, 'mutation', { flag: 'a' });
      }
      return {
        found: true,
        localOrderId: 'local-e2e-1',
        orderState: 'NEW',
        document: null,
      };
    }
  }
  const clientModule = {
    LocalInvoiceGatewayWebSocketTransport,
    ZiraInvoiceBridgeClient,
  };
  const loadPackagedModule = vi.fn((modulePath: string) => {
    if (modulePath === clientPath) return clientModule;
    if (modulePath === tokenHelperPath) return tokenModule;
    throw new Error('unexpected packaged module path');
  });
  return { verifyPackagedPosClient, loadPackagedModule };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('packaged invoice bridge E2E tools', () => {
  it('creates a direct-child temp POS fixture with a bound sentinel and fiscal SHA-256', async () => {
    const runRoot = freshRunRoot('zira-pos-bridge-fixture-');
    const result = await createInvoiceBridgeE2eFixture({ runRoot, nonce: NONCE });

    expect(await readFile(join(runRoot, '.zira-bridge-e2e'), 'utf8'))
      .toBe(e2eSentinelContents(NONCE));
    expect(result.dbPath).toBe(join(runRoot, 'pos.db'));
    expect(result.orderId).toBe(E2E_ORDER_ID);
    expect(result.companyNip).toBe(E2E_COMPANY_NIP);

    const SQL = await initSqlJs();
    const db = new SQL.Database(await readFile(result.dbPath));
    try {
      const seller = oneRow(db, "SELECT nip FROM seller_settings WHERE id = 'default'");
      const order = oneRow(db, `SELECT status, total FROM orders WHERE id = '${E2E_ORDER_ID}'`);
      const fiscal = oneRow(db, 'SELECT payload_json, payload_hash FROM fiscal_attempts LIMIT 1');
      expect(seller.nip).toBe(E2E_COMPANY_NIP);
      expect(order).toEqual(expect.objectContaining({ status: 'COMPLETED', total: 1230 }));
      expect(fiscal.payload_hash).toBe(
        createHash('sha256').update(String(fiscal.payload_json), 'utf8').digest('hex'),
      );
    } finally {
      db.close();
    }
  });

  it('rejects an E2E run root nested below a temporary parent', async () => {
    const parent = freshRunRoot('zira-pos-bridge-parent-');
    await mkdir(parent);
    const nested = join(parent, 'run');
    roots.push(nested);

    await expect(createInvoiceBridgeE2eFixture({ runRoot: nested, nonce: NONCE }))
      .rejects.toThrow('direct child');
  });

  it('requires an explicit isolated high-port loopback URL', () => {
    expect(requireIsolatedLoopbackUrl('ws://127.0.0.1:54321')).toBe('ws://127.0.0.1:54321');
    for (const value of [
      '',
      'ws://localhost:54321',
      'ws://127.0.0.1:9787',
      'ws://127.0.0.1:9999',
      'ws://127.0.0.1:17891',
      'ws://127.0.0.1:17892',
      'ws://127.0.0.1:17893',
      'ws://127.0.0.1:19999',
      'ws://127.0.0.1:40000',
      'wss://127.0.0.1:54321',
      'ws://127.0.0.1:54321/foreign',
    ]) {
      expect(() => requireIsolatedLoopbackUrl(value)).toThrow();
    }
  });

  it('accepts only the exact win-unpacked client below the POS root', () => {
    const posRoot = process.cwd();
    const packaged = join(
      posRoot,
      'release',
      'win-unpacked',
      'resources',
      'app',
      'dist',
      'main',
      'invoice-gateway',
      'client.js',
    );
    expect(requirePackagedClientPath(packaged, posRoot)).toBe(packaged);
    expect(() => requirePackagedClientPath(
      join(posRoot, 'dist', 'main', 'invoice-gateway', 'client.js'),
      posRoot,
    )).toThrow('win-unpacked');
  });

  it('rejects a wrong sentinel, POS sidecar, and production token path before module loading', async () => {
    const runRoot = freshRunRoot('zira-pos-bridge-negative-');
    await createInvoiceBridgeE2eFixture({ runRoot, nonce: NONCE });

    await expect(assertE2eSentinel(runRoot, 'DifferentInvoiceBridgeNonce0123456789AB'))
      .rejects.toThrow('sentinel does not match');
    await writeFile(`${expectedPosDbPath(runRoot)}-wal`, 'not-allowed');
    await expect(runPackagedInvoiceBridgeE2e({
      runRoot,
      nonce: NONCE,
      clientPath: '/never-loaded-client.js',
      tokenPath: expectedTokenPath(runRoot),
      url: 'ws://127.0.0.1:54321',
      timeoutMs: 1_000,
    })).rejects.toThrow('WAL sidecar');
    await rm(`${expectedPosDbPath(runRoot)}-wal`);
    await mkdir(join(runRoot, E2E_APP_IDENTIFIER));
    await writeReadyManifest(runRoot);
    await expect(runPackagedInvoiceBridgeE2e({
      runRoot,
      nonce: NONCE,
      clientPath: '/never-loaded-client.js',
      tokenPath: join(tmpdir(), 'com.zira.invoice', 'pos-bridge-token'),
      url: 'ws://127.0.0.1:54321',
      timeoutMs: 1_000,
    })).rejects.toThrow('isolated E2E token');
  });

  it('rejects a readiness manifest bound to another nonce or port', async () => {
    const runRoot = freshRunRoot('zira-pos-bridge-readiness-');
    await createInvoiceBridgeE2eFixture({ runRoot, nonce: NONCE });
    await mkdir(join(runRoot, E2E_APP_IDENTIFIER));
    await writeReadyManifest(runRoot, { port: 54322 });

    await expect(waitForBridgeE2eReadiness({
      runRoot,
      nonce: NONCE,
      url: 'ws://127.0.0.1:54321',
      timeoutMs: 1_000,
    })).rejects.toThrow('does not match this run');
  });

  it('asserts the lifecycle through injected packaged APIs without exposing the token', async () => {
    const runRoot = freshRunRoot('zira-pos-bridge-runner-');
    await createInvoiceBridgeE2eFixture({ runRoot, nonce: NONCE });

    const secret = 'runner-secret-0123456789abcdef0123456789abcdef';
    const tokenPath = expectedTokenPath(runRoot);
    await mkdir(join(runRoot, E2E_APP_IDENTIFIER));
    await writeFile(tokenPath, `${secret}\n`, 'utf8');
    await writeInvoiceDb(runRoot);
    await writeReadyManifest(runRoot);

    const dependencies = fakePackagedDependencies();
    const result = await runPackagedInvoiceBridgeE2e({
      runRoot,
      nonce: NONCE,
      posRoot: '/virtual/pos',
      expectedPosCommit: EXPECTED_COMMIT,
      expectedPosTree: EXPECTED_TREE,
      clientPath: '/virtual/win-unpacked/client.js',
      tokenPath,
      url: 'ws://127.0.0.1:54321',
      timeoutMs: 1_000,
    }, dependencies);

    const serialized = JSON.stringify(result);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      posCommit: EXPECTED_COMMIT,
      posTree: EXPECTED_TREE,
      firstImportResult: 'IMPORTED',
      secondImportResult: 'ALREADY_IMPORTED',
      statusFound: true,
      invoiceDbCounts: { orders: 1, orderItems: 1, invoices: 0 },
    }));
    expect(dependencies.verifyPackagedPosClient).toHaveBeenCalledWith(expect.objectContaining({
      expectedPosCommit: EXPECTED_COMMIT,
      expectedPosTree: EXPECTED_TREE,
    }));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(tokenPath);
  });

  it('fails if the packaged lifecycle mutates the immutable POS fixture', async () => {
    const runRoot = freshRunRoot('zira-pos-bridge-mutation-');
    const fixture = await createInvoiceBridgeE2eFixture({ runRoot, nonce: NONCE });
    const tokenPath = expectedTokenPath(runRoot);
    await mkdir(join(runRoot, E2E_APP_IDENTIFIER));
    await writeFile(tokenPath, `${'x'.repeat(40)}\n`, 'utf8');
    await writeInvoiceDb(runRoot);
    await writeReadyManifest(runRoot);

    await expect(runPackagedInvoiceBridgeE2e({
      runRoot,
      nonce: NONCE,
      posRoot: '/virtual/pos',
      expectedPosCommit: EXPECTED_COMMIT,
      expectedPosTree: EXPECTED_TREE,
      clientPath: '/virtual/win-unpacked/client.js',
      tokenPath,
      url: 'ws://127.0.0.1:54321',
      timeoutMs: 1_000,
    }, fakePackagedDependencies({ mutateDbPath: fixture.dbPath })))
      .rejects.toThrow('must not modify the POS fixture database');
  });
});
