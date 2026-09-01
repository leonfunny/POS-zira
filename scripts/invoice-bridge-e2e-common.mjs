import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const E2E_APP_IDENTIFIER = 'com.zira.invoice.bridge-e2e';
export const E2E_SENTINEL_FILENAME = '.zira-bridge-e2e';
export const E2E_SENTINEL_PREFIX = 'ZIRA_BRIDGE_E2E_V1:';
export const E2E_POS_DB_FILENAME = 'pos.db';
export const E2E_TOKEN_FILENAME = 'pos-bridge-token';
export const E2E_INVOICE_DB_FILENAME = 'faktura.db';
export const E2E_READY_FILENAME = 'bridge-e2e-ready.json';
export const E2E_FIXTURE_MANIFEST_FILENAME = '.zira-bridge-e2e-fixture.json';
export const E2E_COMPANY_NIP = '5223103395';
export const E2E_CHANNEL_ID = 'zira-pos-bridge-e2e';
export const E2E_CHANNEL_NAME = 'Zira POS Bridge E2E';
export const E2E_ORDER_ID = 'pos-bridge-e2e-1';
export const E2E_IDEMPOTENCY_KEY = `pos-invoice:${E2E_ORDER_ID}:v1`;

const RESERVED_PORTS = new Set([9787, 9999, 17891, 17892, 17893, 19999]);
const NONCE_PATTERN = /^[A-Za-z0-9]{32,128}$/;

export function requireE2eNonce(value) {
  const nonce = String(value || '').trim();
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('E2E nonce must contain 32-128 ASCII letters or digits');
  }
  return nonce;
}

export function e2eSentinelContents(nonce) {
  return `${E2E_SENTINEL_PREFIX}${requireE2eNonce(nonce)}\n`;
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function canonicalTempDir() {
  const configured = path.resolve(tmpdir());
  const canonical = await realpath(configured);
  const stats = await lstat(canonical);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('OS temporary directory must be a real directory');
  }
  return canonical;
}

export async function canonicalRunRoot(value, { create = false } = {}) {
  const input = String(value || '').trim();
  if (!input) throw new Error('E2E run root is required');
  if (!path.isAbsolute(input)) throw new Error('E2E run root must be absolute');

  const resolved = path.resolve(input);
  const tempRoot = await canonicalTempDir();
  const inputParent = await realpath(path.dirname(resolved));
  if (!samePath(inputParent, tempRoot)) {
    throw new Error('E2E run root must be a direct child of the OS temporary directory');
  }
  const leaf = path.basename(resolved);
  if (!leaf || leaf === '.' || leaf === '..') {
    throw new Error('E2E run root must have a dedicated leaf name');
  }
  const candidate = path.join(tempRoot, leaf);

  if (create) {
    try {
      await lstat(candidate);
      throw new Error('E2E run root must not already exist');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await mkdir(candidate);
  }

  const stats = await lstat(candidate);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('E2E run root must be a real directory, not a link');
  }
  const canonical = await realpath(candidate);
  if (!samePath(path.dirname(canonical), tempRoot)) {
    throw new Error('E2E run root escaped the OS temporary directory');
  }
  return canonical;
}

export async function assertE2eSentinel(runRoot, nonce) {
  const canonicalRoot = await canonicalRunRoot(runRoot);
  const sentinelPath = path.join(canonicalRoot, E2E_SENTINEL_FILENAME);
  const stats = await lstat(sentinelPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error('E2E sentinel must be a single-link regular file');
  }
  const actual = await readFile(sentinelPath, 'utf8');
  if (actual !== e2eSentinelContents(nonce)) {
    throw new Error('E2E sentinel does not match this run');
  }
  return canonicalRoot;
}

export function expectedPosDbPath(runRoot) {
  return path.join(runRoot, E2E_POS_DB_FILENAME);
}

export function expectedTokenPath(runRoot) {
  return path.join(runRoot, E2E_APP_IDENTIFIER, E2E_TOKEN_FILENAME);
}

export function expectedInvoiceDbPath(runRoot) {
  return path.join(runRoot, E2E_APP_IDENTIFIER, E2E_INVOICE_DB_FILENAME);
}

export function expectedReadyPath(runRoot) {
  return path.join(runRoot, E2E_APP_IDENTIFIER, E2E_READY_FILENAME);
}

export function expectedFixtureManifestPath(runRoot) {
  return path.join(runRoot, E2E_FIXTURE_MANIFEST_FILENAME);
}

export function e2eFixtureManifestContents(nonce, posDbSha256) {
  const sha256 = String(posDbSha256 || '');
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('POS E2E database SHA-256 must be lowercase hexadecimal');
  }
  return JSON.stringify({
    version: 1,
    nonce: requireE2eNonce(nonce),
    posDbSha256: sha256,
    orderId: E2E_ORDER_ID,
    companyNip: E2E_COMPANY_NIP,
  });
}

export async function assertRegularCanonicalFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  const canonical = await realpath(resolved);
  if (!samePath(canonical, resolved)) {
    throw new Error(`${label} must use its canonical path`);
  }
  return canonical;
}

export function requireIsolatedLoopbackUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('An explicit E2E bridge URL is required');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('E2E bridge URL is invalid');
  }
  if (
    url.protocol !== 'ws:'
    || url.hostname !== '127.0.0.1'
    || !url.port
    || url.username
    || url.password
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search
    || url.hash
  ) {
    throw new Error('E2E bridge URL must be exactly ws://127.0.0.1:<port>');
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('E2E bridge port must be a valid explicit TCP port');
  }
  if (RESERVED_PORTS.has(port)) {
    throw new Error('E2E bridge port is reserved for production or diagnostics');
  }
  if (port < 49152) {
    throw new Error('E2E bridge port must be in the dynamic high-port range');
  }
  return `ws://127.0.0.1:${port}`;
}

export function parseNamedArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    if (name === '--help') {
      values.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    values[name.slice(2)] = value;
    index += 1;
  }
  return values;
}
