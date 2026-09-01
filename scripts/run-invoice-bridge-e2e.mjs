#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import {
  E2E_APP_IDENTIFIER,
  E2E_CHANNEL_ID,
  E2E_CHANNEL_NAME,
  E2E_COMPANY_NIP,
  E2E_IDEMPOTENCY_KEY,
  E2E_ORDER_ID,
  assertE2eSentinel,
  assertRegularCanonicalFile,
  e2eFixtureManifestContents,
  expectedFixtureManifestPath,
  expectedPosDbPath,
  expectedInvoiceDbPath,
  expectedReadyPath,
  expectedTokenPath,
  parseNamedArgs,
  requireE2eNonce,
  requireIsolatedLoopbackUrl,
} from './invoice-bridge-e2e-common.mjs';
import {
  packagedClientPath,
  verifyInvoiceBridgeE2eProvenance,
} from './invoice-bridge-e2e-provenance.mjs';

const requireFromScript = createRequire(import.meta.url);
const DEFAULT_TIMEOUT_MS = 10_000;

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function assertFixtureManifest(runRoot, nonce, posDbSha256) {
  const manifestPath = await assertRegularCanonicalFile(
    expectedFixtureManifestPath(runRoot),
    'POS E2E fixture manifest',
  );
  const expected = e2eFixtureManifestContents(nonce, posDbSha256);
  if (await readFile(manifestPath, 'utf8') !== expected) {
    throw new Error('POS E2E fixture manifest does not match this database/run');
  }
}

async function assertMissingFile(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} must not exist for the immutable POS fixture`);
}

async function assertNoPosSidecars(dbPath) {
  await assertMissingFile(`${dbPath}-wal`, 'POS E2E WAL sidecar');
  await assertMissingFile(`${dbPath}-shm`, 'POS E2E shared-memory sidecar');
}

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForBridgeE2eReadiness({ runRoot, nonce, url, timeoutMs }) {
  const cleanNonce = requireE2eNonce(nonce);
  const canonicalRoot = await assertE2eSentinel(runRoot, cleanNonce);
  const expected = JSON.stringify({
    version: 1,
    nonce: cleanNonce,
    identifier: E2E_APP_IDENTIFIER,
    port: Number(new URL(requireIsolatedLoopbackUrl(url)).port),
    ready: true,
  });
  const readyPath = expectedReadyPath(canonicalRoot);
  const deadline = Date.now() + requireTimeout(timeoutMs);

  while (Date.now() < deadline) {
    try {
      const stats = await lstat(readyPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('Zira Invoice E2E readiness manifest must be a regular file');
      }
      // The Zira publisher uses create-new + sync + hard-link + unlink so it
      // cannot replace an existing manifest on either Windows or Unix. The
      // final link is briefly link-count 2 until the private temp name is
      // removed; wait for that no-clobber publish to finish before reading.
      if (stats.nlink !== 1) {
        await delay(25);
        continue;
      }
      if (!samePath(await realpath(readyPath), readyPath)) {
        throw new Error('Zira Invoice E2E readiness manifest must use its canonical path');
      }
      const actual = await readFile(readyPath, 'utf8');
      if (actual !== expected) {
        throw new Error('Zira Invoice E2E readiness manifest does not match this run');
      }
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for the Zira Invoice E2E readiness manifest');
}

function sqliteCount(db, table) {
  const statement = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`);
  try {
    if (!statement.step()) throw new Error(`Could not count ${table}`);
    const value = Number(statement.getAsObject().count);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid ${table} count`);
    }
    return value;
  } finally {
    statement.free();
  }
}

function sqliteOne(db, sql) {
  const statement = db.prepare(sql);
  try {
    if (!statement.step()) throw new Error('Expected exactly one imported order');
    const row = statement.getAsObject();
    if (statement.step()) throw new Error('Expected exactly one imported order');
    return row;
  } finally {
    statement.free();
  }
}

async function readInvoiceDbCounts(runRoot) {
  const invoiceDbPath = await assertRegularCanonicalFile(
    expectedInvoiceDbPath(runRoot),
    'Isolated Zira Invoice E2E database',
  );
  const SQL = await initSqlJs();
  const db = new SQL.Database(await readFile(invoiceDbPath));
  try {
    const counts = {
      orders: sqliteCount(db, 'orders'),
      orderItems: sqliteCount(db, 'order_items'),
      invoices: sqliteCount(db, 'invoices'),
    };
    const order = sqliteOne(
      db,
      'SELECT external_order_id, status, invoice_id, raw_json FROM orders',
    );
    assert.equal(order.external_order_id, E2E_ORDER_ID);
    assert.equal(order.status, 'NEW');
    assert.equal(order.invoice_id, null);
    assert.equal(typeof order.raw_json, 'string');
    const raw = JSON.parse(order.raw_json);
    assert.equal(raw?.import_source, 'ZIRA_POS_EXACT_BRIDGE_V1');
    assert.equal(raw?.bridge_pos_order_id, E2E_ORDER_ID);
    assert.equal(raw?.bridge_idempotency_key, E2E_IDEMPOTENCY_KEY);
    assert.equal(raw?.order?.id, E2E_ORDER_ID);
    return counts;
  } finally {
    db.close();
  }
}

function requireTimeout(value) {
  const raw = value == null || value === '' ? String(DEFAULT_TIMEOUT_MS) : String(value);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error('E2E timeout must be a positive integer');
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error('E2E timeout must be between 1000 and 30000 milliseconds');
  }
  return timeoutMs;
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its time budget`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertPackagedExports(clientModule, tokenModule) {
  if (
    typeof clientModule?.LocalInvoiceGatewayWebSocketTransport !== 'function'
    || typeof clientModule?.ZiraInvoiceBridgeClient !== 'function'
  ) {
    throw new Error('Packaged POS client does not expose the invoice bridge API');
  }
  if (typeof tokenModule?.createZiraInvoiceBridgeFileTokenProvider !== 'function') {
    throw new Error('Packaged POS token helper is missing');
  }
}

export function requirePackagedClientPath(value, posRoot) {
  const supplied = path.resolve(String(value || ''));
  const root = path.resolve(String(posRoot || ''));
  const expected = packagedClientPath(root);
  if (!value || !samePath(supplied, expected)) {
    throw new Error('POS client path must be the exact win-unpacked client below the POS root');
  }
  return supplied;
}

export async function verifyPackagedPosClient(options) {
  const verified = await verifyInvoiceBridgeE2eProvenance({
    posRoot: options?.posRoot,
    expectedPosCommit: options?.expectedPosCommit,
    expectedPosTree: options?.expectedPosTree,
  });
  const clientPath = requirePackagedClientPath(options?.clientPath, verified.posRoot);
  if (!samePath(clientPath, verified.clientPath)) {
    throw new Error('Verified packaged POS client path does not match the requested client');
  }
  return {
    ...verified,
    moduleSha256: Object.fromEntries(
      Object.entries(verified.provenance.gatewayModules)
        .map(([filename, description]) => [filename, description.sha256]),
    ),
  };
}

export async function runPackagedInvoiceBridgeE2e(options, dependencies = {}) {
  const nonce = requireE2eNonce(options?.nonce);
  const runRoot = await assertE2eSentinel(options?.runRoot, nonce);
  const url = requireIsolatedLoopbackUrl(options?.url);
  const timeoutMs = requireTimeout(options?.timeoutMs);

  const dbPath = await assertRegularCanonicalFile(expectedPosDbPath(runRoot), 'POS E2E database');
  if (!samePath(dbPath, expectedPosDbPath(runRoot))) {
    throw new Error('POS E2E database must be the canonical pos.db below the run root');
  }
  await assertNoPosSidecars(dbPath);
  const dbSha256Before = await sha256File(dbPath);
  await assertFixtureManifest(runRoot, nonce, dbSha256Before);

  const suppliedTokenPath = path.resolve(String(options?.tokenPath || ''));
  const isolatedTokenPath = expectedTokenPath(runRoot);
  if (!options?.tokenPath || !samePath(suppliedTokenPath, isolatedTokenPath)) {
    throw new Error('Token path must be the isolated E2E token below the run root');
  }

  const verifyPackaged = dependencies.verifyPackagedPosClient
    ?? verifyPackagedPosClient;
  const packaged = await verifyPackaged({
    posRoot: options?.posRoot,
    expectedPosCommit: options?.expectedPosCommit,
    expectedPosTree: options?.expectedPosTree,
    clientPath: options?.clientPath,
  });

  await waitForBridgeE2eReadiness({ runRoot, nonce, url, timeoutMs });

  const tokenPath = await assertRegularCanonicalFile(suppliedTokenPath, 'E2E bridge token');

  const loadPackagedModule = dependencies.loadPackagedModule ?? requireFromScript;
  const clientModule = loadPackagedModule(packaged.clientPath);
  const tokenModule = loadPackagedModule(packaged.tokenHelperPath);
  assertPackagedExports(clientModule, tokenModule);

  const tokenProvider = tokenModule.createZiraInvoiceBridgeFileTokenProvider({ tokenPath });
  const transport = new clientModule.LocalInvoiceGatewayWebSocketTransport({
    tokenProvider,
    url,
    timeoutMs,
  });
  const client = new clientModule.ZiraInvoiceBridgeClient(transport);
  const input = {
    idempotencyKey: E2E_IDEMPOTENCY_KEY,
    channelId: E2E_CHANNEL_ID,
    posOrderId: E2E_ORDER_ID,
    companyNip: E2E_COMPANY_NIP,
  };

  const capabilities = await within(client.capabilities(), timeoutMs + 1_000, 'capabilities');
  assert.deepEqual(capabilities, {
    contractVersion: 1,
    ready: true,
    companyNip: E2E_COMPANY_NIP,
    supportedIntents: ['FISCALISED_RETAIL'],
    channels: [{ id: E2E_CHANNEL_ID, name: E2E_CHANNEL_NAME, enabled: true }],
  });

  const first = await within(client.syncPosOrder(input), timeoutMs + 1_000, 'first import');
  assert.equal(first?.importResult, 'IMPORTED');
  assert.equal(typeof first?.localOrderId, 'string');
  assert.notEqual(first.localOrderId.trim(), '');
  assert.equal(first?.orderState, 'NEW');
  assert.equal(first?.document, null);

  const second = await within(client.syncPosOrder(input), timeoutMs + 1_000, 'idempotent import');
  assert.equal(second?.importResult, 'ALREADY_IMPORTED');
  assert.equal(second?.localOrderId, first.localOrderId);
  assert.equal(second?.orderState, 'NEW');
  assert.equal(second?.document, null);

  const status = await within(client.getDocumentStatus(input), timeoutMs + 1_000, 'status lookup');
  assert.equal(status?.found, true);
  assert.equal(status?.localOrderId, first.localOrderId);
  assert.equal(status?.orderState, 'NEW');
  assert.equal(status?.document, null);

  const dbSha256After = await sha256File(dbPath);
  await assertNoPosSidecars(dbPath);
  assert.equal(
    dbSha256After,
    dbSha256Before,
    'Zira Invoice must not modify the POS fixture database',
  );
  await assertFixtureManifest(runRoot, nonce, dbSha256After);
  const invoiceDbCounts = await readInvoiceDbCounts(runRoot);
  assert.deepEqual(invoiceDbCounts, {
    orders: 1,
    orderItems: 1,
    invoices: 0,
  });

  return {
    ok: true,
    contractVersion: capabilities.contractVersion,
    channelId: E2E_CHANNEL_ID,
    posOrderId: E2E_ORDER_ID,
    localOrderId: first.localOrderId,
    firstImportResult: first.importResult,
    secondImportResult: second.importResult,
    statusFound: status.found,
    posDbSha256: dbSha256After,
    posCommit: packaged.commit,
    posTree: packaged.tree,
    packagedModuleSha256: packaged.moduleSha256,
    packagedWsVersion: packaged.provenance.ws.runtime.version,
    packagedWsTreeSha256: packaged.provenance.ws.runtime.treeSha256,
    invoiceDbCounts,
  };
}

function usage() {
  return [
    'Usage: node scripts/run-invoice-bridge-e2e.mjs',
    '  --run-root <isolated-dir> --nonce <32-128 alnum>',
    '  --pos-root <canonical POS worktree>',
    '  --expected-pos-commit <full Git SHA> --expected-pos-tree <full Git tree SHA>',
    '  --client-path <packaged dist/main/invoice-gateway/client.js>',
    '  --token-path <isolated pos-bridge-token>',
    '  --url ws://127.0.0.1:<non-reserved-port> [--timeout-ms 10000]',
  ].join('\n');
}

async function main() {
  const args = parseNamedArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runPackagedInvoiceBridgeE2e({
    runRoot: args['run-root'] || process.env.ZIRA_BRIDGE_E2E_RUN_ROOT,
    nonce: args.nonce || process.env.ZIRA_BRIDGE_E2E_NONCE,
    posRoot: args['pos-root'] || process.env.ZIRA_BRIDGE_E2E_POS_ROOT,
    expectedPosCommit: args['expected-pos-commit'] || process.env.ZIRA_BRIDGE_E2E_POS_COMMIT,
    expectedPosTree: args['expected-pos-tree'] || process.env.ZIRA_BRIDGE_E2E_POS_TREE,
    clientPath: args['client-path'] || process.env.ZIRA_BRIDGE_E2E_CLIENT_PATH,
    tokenPath: args['token-path'] || process.env.ZIRA_BRIDGE_E2E_TOKEN_PATH,
    url: args.url || process.env.ZIRA_BRIDGE_E2E_URL,
    timeoutMs: args['timeout-ms'] || process.env.ZIRA_BRIDGE_E2E_TIMEOUT_MS,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('POS invoice bridge E2E failed\n');
    process.exitCode = 1;
  });
}
