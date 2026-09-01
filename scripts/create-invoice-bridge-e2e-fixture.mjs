#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import {
  E2E_COMPANY_NIP,
  E2E_ORDER_ID,
  E2E_SENTINEL_FILENAME,
  canonicalRunRoot,
  assertRegularCanonicalFile,
  e2eFixtureManifestContents,
  e2eSentinelContents,
  expectedFixtureManifestPath,
  expectedPosDbPath,
  parseNamedArgs,
  requireE2eNonce,
} from './invoice-bridge-e2e-common.mjs';

const ORDER_NUMBER = 'E2E/1';
const ITEM_ID = 'pos-bridge-e2e-line-1';
const FISCAL_ATTEMPT_ID = 'pos-bridge-e2e-fiscal-1';
const CREATED_AT = '2026-09-01T10:00:00Z';
const CONFIRMED_AT = '2026-09-01T10:00:02Z';

export function createFiscalPayload() {
  return {
    orderId: E2E_ORDER_ID,
    orderNumber: ORDER_NUMBER,
    sellerNip: E2E_COMPANY_NIP,
    items: [{
      name: 'E2E manicure service',
      sku: 'E2E-SERVICE-1',
      quantity: 1,
      unitPrice: 1230,
      totalPrice: 1230,
      vatRate: 23,
      unit: 'szt.',
      allocatedDiscount: 0,
    }],
    payment: { method: 'CARD', amount: 1230 },
    subtotal: 1230,
    discount: 0,
    total: 1230,
  };
}

function oneRow(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    if (!statement.step()) return null;
    return statement.getAsObject();
  } finally {
    statement.free();
  }
}

function assertFixture(db, payloadJson, payloadHash) {
  const seller = oneRow(db, "SELECT nip FROM seller_settings WHERE id = 'default'");
  const order = oneRow(db, 'SELECT id, status, total FROM orders WHERE id = ?', [E2E_ORDER_ID]);
  const item = oneRow(db, 'SELECT order_id, total, vat_rate FROM order_items WHERE id = ?', [ITEM_ID]);
  const fiscal = oneRow(
    db,
    'SELECT order_id, status, payload_json, payload_hash FROM fiscal_attempts WHERE id = ?',
    [FISCAL_ATTEMPT_ID],
  );
  if (
    seller?.nip !== E2E_COMPANY_NIP
    || order?.id !== E2E_ORDER_ID
    || order?.status !== 'COMPLETED'
    || order?.total !== 1230
    || item?.order_id !== E2E_ORDER_ID
    || item?.total !== 1230
    || item?.vat_rate !== 23
    || fiscal?.order_id !== E2E_ORDER_ID
    || fiscal?.status !== 'SUCCESS_CONFIRMED'
    || fiscal?.payload_json !== payloadJson
    || fiscal?.payload_hash !== payloadHash
  ) {
    throw new Error('Generated POS E2E fixture failed its integrity check');
  }
}

export async function createInvoiceBridgeE2eFixture(options) {
  const nonce = requireE2eNonce(options?.nonce);
  const runRoot = await canonicalRunRoot(options?.runRoot, { create: true });
  const existing = await readdir(runRoot);
  if (existing.length !== 0) {
    throw new Error('E2E run root must be fresh and empty');
  }

  const sentinelPath = path.join(runRoot, E2E_SENTINEL_FILENAME);
  await writeFile(sentinelPath, e2eSentinelContents(nonce), { encoding: 'utf8', flag: 'wx' });

  const payloadJson = JSON.stringify(createFiscalPayload());
  const payloadHash = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run(`
      CREATE TABLE seller_settings (
        id TEXT PRIMARY KEY,
        nip TEXT
      );
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        order_number TEXT,
        status TEXT,
        subtotal INTEGER,
        total INTEGER,
        discount INTEGER,
        tax INTEGER,
        payment_method TEXT,
        payment_tenders TEXT,
        payment_amount INTEGER,
        change_amount INTEGER,
        tip INTEGER,
        customer_name TEXT,
        customer_nip TEXT,
        source TEXT,
        mode TEXT,
        order_type TEXT,
        created_at TEXT
      );
      CREATE TABLE order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        variant_id TEXT,
        name TEXT,
        sku TEXT,
        price INTEGER,
        quantity INTEGER,
        sale_quantity REAL,
        sale_unit TEXT,
        sell_by TEXT,
        total INTEGER,
        vat_rate INTEGER,
        allocated_discount INTEGER,
        payable_total INTEGER
      );
      CREATE TABLE fiscal_attempts (
        id TEXT PRIMARY KEY,
        order_id TEXT,
        attempt_no INTEGER,
        printer_type TEXT,
        status TEXT,
        fiskal_number TEXT,
        gross_total INTEGER,
        fiscalized_at TEXT,
        resolved_at TEXT,
        result_json TEXT,
        payload_json TEXT,
        payload_hash TEXT
      );
    `);
    db.run("INSERT INTO seller_settings (id, nip) VALUES ('default', ?)", [E2E_COMPANY_NIP]);
    db.run(`
      INSERT INTO orders (
        id, order_number, status, subtotal, total, discount, tax,
        payment_method, payment_tenders, payment_amount, change_amount, tip,
        customer_name, customer_nip, source, mode, order_type, created_at
      ) VALUES (?, ?, 'COMPLETED', 1230, 1230, 0, 230, 'CARD', NULL, 1230, 0, 0,
        NULL, NULL, 'POS', 'retail', 'standard', ?)
    `, [E2E_ORDER_ID, ORDER_NUMBER, CREATED_AT]);
    db.run(`
      INSERT INTO order_items (
        id, order_id, variant_id, name, sku, price, quantity, sale_quantity,
        sale_unit, sell_by, total, vat_rate, allocated_discount, payable_total
      ) VALUES (?, ?, NULL, 'E2E manicure service', 'E2E-SERVICE-1', 1230, 1, 1,
        'szt.', 'PIECE', 1230, 23, 0, 1230)
    `, [ITEM_ID, E2E_ORDER_ID]);
    db.run(`
      INSERT INTO fiscal_attempts (
        id, order_id, attempt_no, printer_type, status, fiskal_number,
        gross_total, fiscalized_at, resolved_at, result_json, payload_json, payload_hash
      ) VALUES (?, ?, 1, 'FISCAL', 'SUCCESS_CONFIRMED', ?, 1230, ?, ?, ?, ?, ?)
    `, [
      FISCAL_ATTEMPT_ID,
      E2E_ORDER_ID,
      ORDER_NUMBER,
      CONFIRMED_AT,
      CONFIRMED_AT,
      JSON.stringify({ ok: true, e2e: true }),
      payloadJson,
      payloadHash,
    ]);
    assertFixture(db, payloadJson, payloadHash);

    const dbPath = expectedPosDbPath(runRoot);
    await writeFile(dbPath, Buffer.from(db.export()), { flag: 'wx' });
    await assertRegularCanonicalFile(dbPath, 'POS E2E database');
    const posDbSha256 = createHash('sha256').update(await readFile(dbPath)).digest('hex');
    const fixtureManifestPath = expectedFixtureManifestPath(runRoot);
    await writeFile(
      fixtureManifestPath,
      e2eFixtureManifestContents(nonce, posDbSha256),
      { encoding: 'utf8', flag: 'wx' },
    );
    return {
      ok: true,
      runRoot,
      dbPath,
      fixtureManifestPath,
      posDbSha256,
      orderId: E2E_ORDER_ID,
      companyNip: E2E_COMPANY_NIP,
      payloadSha256: payloadHash,
    };
  } finally {
    db.close();
  }
}

function usage() {
  return 'Usage: node scripts/create-invoice-bridge-e2e-fixture.mjs --run-root <fresh-dir> --nonce <32-128 alnum>';
}

async function main() {
  const args = parseNamedArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await createInvoiceBridgeE2eFixture({
    runRoot: args['run-root'] || process.env.ZIRA_BRIDGE_E2E_RUN_ROOT,
    nonce: args.nonce || process.env.ZIRA_BRIDGE_E2E_NONCE,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('POS invoice bridge E2E fixture creation failed\n');
    process.exitCode = 1;
  });
}
