// scripts/android/billiard-contract-check.mjs
// Manual spike: does a staff/owner JWT reach the billiard read endpoints?
// Captures JSON fixtures for the Task 4 transport tests and prints status
// codes for the F&B routes (which Windows serves from a local cache, not a
// backend billiard route — see src/main/modules/sync.module.ts:245-263).
//
// Usage:
//   BILLIARD_TEST_EMAIL=... BILLIARD_TEST_PASSWORD=... \
//   node scripts/android/billiard-contract-check.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BILLIARD_API_BASE || 'http://127.0.0.1:3003';
const email = process.env.BILLIARD_TEST_EMAIL;
const password = process.env.BILLIARD_TEST_PASSWORD;
if (!email || !password) {
  console.error('Set BILLIARD_TEST_EMAIL / BILLIARD_TEST_PASSWORD');
  process.exit(2);
}

const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ emailOrPhone: email, password }),
});
if (!loginRes.ok) {
  console.error(`LOGIN ${loginRes.status}`);
  console.error(await loginRes.text().catch(() => '<no body>'));
  process.exit(1);
}
const loginBody = await loginRes.json();
// Tolerant of several NestJS response shapes; print the raw body on failure so
// the real shape is visible rather than guessed (login DTO field is emailOrPhone).
const token =
  loginBody?.accessToken ??
  loginBody?.access_token ??
  loginBody?.data?.accessToken ??
  loginBody?.data?.access_token ??
  null;
if (!token) {
  // Never dump the raw body — it can contain accessToken/refreshToken and this
  // output lands in shell history / CI logs. Shape (keys) is enough to debug.
  console.error('No accessToken in login response — top-level keys:', Object.keys(loginBody ?? {}).join(', '));
  process.exit(1);
}

mkdirSync('tests/fixtures/billiard', { recursive: true });
let failed = 0;
for (const [name, path] of [
  ['dashboard', '/api/v1/billiard/dashboard'],
  ['floor-plans', '/api/v1/billiard/floor-plans'],
  ['combos', '/api/v1/billiard/combos'],
]) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  console.log(`${res.status} GET ${path}`);
  if (res.ok) {
    writeFileSync(`tests/fixtures/billiard/${name}.json`, JSON.stringify(await res.json(), null, 2));
  } else {
    failed++;
  }
}

// Additional contract probe — reporting only, writes no fixtures.
// Windows serves F&B products/categories from the local ProductSync cache
// (productRepo in sync.module.ts:245-263); probing to confirm whether a direct
// backend route exists for the Android online-only path.
console.log('--- fnb route probe (status codes only) ---');
for (const path of [
  '/api/v1/billiard/fnb/products',
  '/api/v1/billiard/fnb/categories',
]) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  console.log(`${res.status} GET ${path}`);
}

process.exit(failed ? 1 : 0);
