# Billiard (Bi-a) Android Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution note (this project):** each Task below = one `claude-glm` headless chunk. The supervisor (Claude) reviews between chunks.

**Goal:** Make the Android POS app (Capacitor build in this repo) able to run the billiard (Bi-a) floor-plan/tab UI online-only against the eNail backend, gated by the `billiard` entitlement.

**Architecture:** The Android app mounts the unmodified Windows renderer through a shim (`src/renderer/android-pos/shim/`) that replaces `window.electronAPI`. Windows serves billiard reads from a local SQLite cache filled by `BilliardSync` and queues writes; Android P1 skips the local cache/queue entirely — reads hit the backend directly with a small in-memory cache + 10s polling, writes (`billiard.mutate`) go straight to the backend and surface errors. Hardware (receipt print / cash drawer) returns the same "no printer connected" result Windows returns.

**Tech Stack:** TypeScript, React, Vite (`vite.android.config.ts`), Capacitor + Gradle (`android-pos/`), vitest, existing shim infra (`PosApiClient` in `src/renderer/android-pos/port/api-client.ts`, `TokenStore`, `ShimTransport`).

## Global Constraints

- **Repo:** `/var/www/pos-zira` (branch work only; never push to `main` directly).
- **Client-only.** Zero backend/server changes. If a backend gap is found (401/403/missing route), STOP the task and draft a Server Change Request per `CLAUDE.md` template instead of working around it.
- **Money path:** never fake success. `billiard.mutate` failures must throw/return the real error; no silent catch, no optimistic "paid". (Incident history: billiard estimateCharge pause bug — server is the source of truth for charges.)
- **POSApp and all files under `src/renderer/components/billiard/`, `src/renderer/windows/`, `src/renderer/App.tsx` are the SHARED Windows renderer — do not edit them** unless a task explicitly says so. All Android work lives under `src/renderer/android-pos/` + `tests/`.
- **Shim contract discipline:** changing a stub default = contract change → update `docs/android-pos/SHIM_CONTRACT_S1.md` + `tests/android-shim.test.ts` together (see `stubs.ts` header).
- **Build commands:** `npm run build` (typecheck + main + renderer), `npm run build:android:web`, boundary verifier `npm run test:android:boundaries:source` and `:bundle`. Tests: `npx vitest run tests/android-*.test.ts` (android set), full `npm test` only in Task 7 (Windows-main baseline has ~13 flaky files — compare against baseline, don't chase them).
- **Known blocker to fix first:** `npm run build` fails on this branch with TS2352 at `src/renderer/android-pos/shim/config-store.ts:153`.
- **Test creds (dev backend on this box, `http://127.0.0.1:3003`):** demo billiard salon owner `demo@bia` / `Bia2026!`, staff `anna@demo-bia` / `Staff123!` — pass via env `BILLIARD_TEST_EMAIL` / `BILLIARD_TEST_PASSWORD`, never hardcode in committed files.
- Commit style: `feat(android-billiard): …` / `fix(android-billiard): …`, one commit per task minimum.

## File Structure (locked in)

| File | Responsibility |
|---|---|
| `src/renderer/android-pos/shim/transport.ts` | + optional `billiard*` / `apiCall` methods on `ShimTransport` (Task 3) |
| `src/renderer/android-pos/shim/stubs.ts` | + `buildBilliardNamespace` synthetic defaults + `apiCall` stub (Task 3) |
| `src/renderer/android-pos/shim/index.ts` | wire `billiard`, `apiCall` (+`entitlements` already wired) into `installShim` (Task 3) |
| `src/renderer/android-pos/shim/billiard-transport.ts` | NEW — real online-only implementation (Task 4) |
| `src/renderer/android-pos/shim/real-transport.ts` | attach billiard methods from billiard-transport (Task 4) |
| `src/renderer/android-pos/AndroidBootApp.tsx` | entitlement-gated mode tabs POS ⟷ Bi-a (Task 6) |
| `tests/android-billiard-shim.test.ts` | NEW — stub-default contract tests (Task 3) |
| `tests/android-billiard-transport.test.ts` | NEW — real transport unit tests, mocked fetch (Task 4/5) |
| `scripts/android/billiard-contract-check.mjs` | NEW — manual backend contract spike (Task 2) |
| `docs/android-pos/SHIM_CONTRACT_S1.md` | contract amendment §billiard (Task 3) |
| `docs/android-pos/EXPANSION_PLAN_2026-07-19.md` | amendment: billiard becomes wave B-1 (Task 8) |

**Reference files (read, never edit):**
- `src/main/modules/sync.module.ts:179-420` — the 13 Windows billiard IPC handlers (authoritative behavior + return shapes, incl. the "no receipt printer connected" return).
- `src/main/sync/billiard-sync.ts` — `fullSync` (endpoints: GET `/billiard/dashboard`, `/billiard/floor-plans`, `/billiard/combos`, `/restaurant/combos`), `getLocalFloorOverview()` (:483 — the exact overview shape the UI consumes), `executeMutation` (:176), `getSyncStatus` (:606), dashboard poll interval 10s (:163).
- `src/shared/electron.d.ts:655-680` — the `billiard` + `apiCall` renderer surface to satisfy.
- `src/renderer/hooks/useBilliardApi.ts`, `src/renderer/hooks/useBilliardData.ts` — how the UI calls it (note: aux namespaces `reservation`/`happyHour`/`kds`/`stock`/`sessionHistory`/`billiardGuest`/`dailyReport` are all called with `?.` optional chaining → leaving them `undefined` on Android is safe and is the P1 decision).
- `src/renderer/App.tsx:517-519` — exact mount JSX: `<BilliardFloorPlan language={(config?.language as Language) || 'en'} />` gated by `isTabAvailable('billiard')`.

---

### Task 1: Work branch + sync with main + fix the build blocker

**Files:**
- Modify: `src/renderer/android-pos/shim/config-store.ts:153` (TS2352 fix)
- Merge: `origin/main` (tip ≥ `35444f1`, carries the 20–21/07 billiard waves: pause fix, VOID UI, Unsettled panel, qty steppers, transfer fixes)

**Interfaces:**
- Produces: branch `codex/android-billiard-port` where `npm run build` is green and the renderer billiard code equals origin/main's.

- [ ] **Step 1: Create the work branch**

```bash
cd /var/www/pos-zira
git fetch origin
git checkout codex/android-pos-build-ci
git checkout -b codex/android-billiard-port
```

- [ ] **Step 2: Merge origin/main**

```bash
git merge origin/main
```

Conflict resolution rules (mechanical):
- Any path under `src/renderer/components/`, `src/renderer/hooks/`, `src/renderer/windows/`, `src/main/`, `src/preload/`, `src/shared/` → take **origin/main**'s side (`git checkout --theirs -- <path>`), UNLESS the branch side contains an `android`-marked change (grep the conflicting hunk for `android`/`E-PARITY`/`shim`) — then merge by hand keeping both.
- Any path under `src/renderer/android-pos/`, `android-pos/`, `tests/android-*`, `docs/android-pos/`, `vite.android.config.ts`, `tsconfig.android.json` → take **the branch** side (`git checkout --ours -- <path>`).
- If `src/shared/types.ts` or `electron.d.ts` conflict: keep main's channels/types and re-apply the branch's android-only additions on top.

- [ ] **Step 3: Fix the known TS2352**

Open `src/renderer/android-pos/shim/config-store.ts:153`. The failing cast is a direct `as` between insufficiently-overlapping types; fix by going through `unknown` **only if the value is genuinely opaque**, otherwise narrow properly. Expected shape of fix:

```typescript
// before (fails TS2352)
const parsed = raw as StoredShimConfig;
// after
const parsed = raw as unknown as StoredShimConfig;
```

(If merge already resolved line numbers differently, locate it by running the build and reading the error.)

- [ ] **Step 4: Green build + android test set**

```bash
npm run build                       # expect exit 0
npm run build:android:web           # expect exit 0
npx vitest run tests/android-*.test.ts   # expect all pass (0 fail)
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(android-billiard): branch off build-ci, merge main (billiard waves), fix config-store TS2352"
```

---

### Task 2: Backend contract spike (gate — fail fast)

**Files:**
- Create: `scripts/android/billiard-contract-check.mjs`

**Interfaces:**
- Produces: captured JSON fixtures `tests/fixtures/billiard/dashboard.json`, `floor-plans.json`, `combos.json` (used by Task 4 tests), and a written GO/NO-GO line in the task report.

- [ ] **Step 1: Write the spike script**

```javascript
// scripts/android/billiard-contract-check.mjs
// Manual spike: does a staff/owner JWT reach the billiard read endpoints?
// Usage: BILLIARD_TEST_EMAIL=... BILLIARD_TEST_PASSWORD=... node scripts/android/billiard-contract-check.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BILLIARD_API_BASE || 'http://127.0.0.1:3003';
const email = process.env.BILLIARD_TEST_EMAIL;
const password = process.env.BILLIARD_TEST_PASSWORD;
if (!email || !password) { console.error('Set BILLIARD_TEST_EMAIL / BILLIARD_TEST_PASSWORD'); process.exit(2); }

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ emailOrPhone: email, password }),
});
if (!login.ok) { console.error(`LOGIN ${login.status}`); process.exit(1); }
const token = (await login.json())?.accessToken ?? (await Promise.resolve(null));
if (!token) { console.error('No accessToken in login response — inspect response shape'); process.exit(1); }

mkdirSync('tests/fixtures/billiard', { recursive: true });
let failed = 0;
for (const [name, path] of [
  ['dashboard', '/api/v1/billiard/dashboard'],
  ['floor-plans', '/api/v1/billiard/floor-plans'],
  ['combos', '/api/v1/billiard/combos'],
]) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  console.log(`${res.status} GET ${path}`);
  if (res.ok) writeFileSync(`tests/fixtures/billiard/${name}.json`, JSON.stringify(await res.json(), null, 2));
  else failed++;
}
process.exit(failed ? 1 : 0);
```

Note: if the login response nests the token differently (e.g. `data.accessToken`), adapt the extraction — print the raw body on failure to see it. Login DTO field is `emailOrPhone` (project memory).

- [ ] **Step 2: Run it against the dev backend**

```bash
BILLIARD_TEST_EMAIL='demo@bia' BILLIARD_TEST_PASSWORD='Bia2026!' node scripts/android/billiard-contract-check.mjs
```

Expected: `200 GET` for all three, fixtures written.
**If 401/403/404:** STOP. Do not code around it. Write a Server Change Request (CLAUDE.md template) into `docs/android-pos/SERVER_REQUEST_BILLIARD_JWT.md` and end the task reporting NO-GO.

- [ ] **Step 3: Sanity-read the fixtures**

Record in the task report: does `dashboard.json` already contain `tables` (or `resources`) each with embedded `layout` and `session` objects matching the shape of `getLocalFloorOverview()` (`src/main/sync/billiard-sync.ts:483`)? This decides Task 4's `getFloorOverview` strategy (pass-through vs assembly).

- [ ] **Step 4: Commit (script + fixtures; fixtures are dev-clone data, safe)**

```bash
git add scripts/android/billiard-contract-check.mjs tests/fixtures/billiard/
git commit -m "feat(android-billiard): backend contract spike + captured fixtures"
```

---

### Task 3: Shim surface — transport interface, synthetic stubs, contract doc

**Files:**
- Modify: `src/renderer/android-pos/shim/transport.ts`
- Modify: `src/renderer/android-pos/shim/stubs.ts`
- Modify: `src/renderer/android-pos/shim/index.ts`
- Modify: `docs/android-pos/SHIM_CONTRACT_S1.md` (append §billiard)
- Test: `tests/android-billiard-shim.test.ts`

**Interfaces:**
- Produces (consumed by Task 4/6):
  - `ShimTransport` gains OPTIONAL members:
    ```typescript
    billiardGetOverview?: () => Promise<any>;
    billiardGetSession?: (id: string) => Promise<any>;
    billiardGetCombos?: (activeOnly?: boolean) => Promise<any[]>;
    billiardGetFloorPlans?: () => Promise<any[]>;
    billiardGetFnbProducts?: (search?: string, categoryId?: string) => Promise<any[]>;
    billiardGetFnbCategories?: () => Promise<any[]>;
    billiardGetResourceType?: (code: string) => Promise<any>;
    billiardGetRestaurantCombos?: () => Promise<any[]>;
    billiardMutate?: (op: string, method: string, path: string, body?: any) => Promise<any>;
    billiardSyncStatus?: () => Promise<{ pending: number; lastSync: string | null; online: boolean }>;
    billiardOnDataUpdated?: (cb: (d: { type: string }) => void) => () => void;
    billiardPrintReceipt?: (sessionId: string, payment: { method: string; amount: number }) => Promise<{ success: boolean; receiptPrinted: boolean }>;
    apiCall?: (method: string, path: string, body?: any) => Promise<any>;
    ```
  - `stubs.ts` exports `buildBilliardNamespace(deps: StubDeps)` returning the full `window.electronAPI.billiard` object (electron.d.ts:655-673) + `buildApiCall(deps: StubDeps)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/android-billiard-shim.test.ts
import { describe, it, expect } from 'vitest';
import { buildBilliardNamespace, buildApiCall } from '../src/renderer/android-pos/shim/stubs';

const deps = { configStore: fakeConfigStore(), transport: {} } as any; // reuse the fakeConfigStore helper pattern from tests/android-shim.test.ts

describe('billiard shim stub defaults (contract S1 §billiard)', () => {
  it('getFloorOverview returns empty overview', async () => {
    const b = buildBilliardNamespace(deps);
    await expect(b.getFloorOverview()).resolves.toEqual({ tables: [], floorPlans: [], layouts: [], sessions: [], _fromCache: true });
  });
  it('getSyncStatus reports offline with no transport', async () => {
    const b = buildBilliardNamespace(deps);
    await expect(b.getSyncStatus()).resolves.toEqual({ pending: 0, lastSync: null, online: false });
  });
  it('mutate without transport rejects (money path must not fake success)', async () => {
    const b = buildBilliardNamespace(deps);
    await expect(b.mutate('update_floor_plan', 'PATCH', '/billiard/floor-plans/x', {})).rejects.toThrow();
  });
  it('printReceipt mirrors Windows no-printer result', async () => {
    const b = buildBilliardNamespace(deps);
    await expect(b.printReceipt('s1', { method: 'CASH', amount: 100 })).resolves.toEqual(NO_PRINTER_RESULT); // copy the literal Windows returns at src/main/modules/sync.module.ts:~389
  });
  it('onDataUpdated returns a no-op unsubscribe', () => {
    const b = buildBilliardNamespace(deps);
    expect(typeof b.onDataUpdated(() => {})()).toBe('undefined');
  });
  it('apiCall without transport rejects with offline error', async () => {
    const api = buildApiCall(deps);
    await expect(api('GET', '/billiard/floor-plans')).rejects.toThrow();
  });
});
```

Replace `NO_PRINTER_RESULT` with the exact literal from `sync.module.ts` (read it — the Windows handler's return when no receipt printer is connected) and `fakeConfigStore` with the existing helper pattern in `tests/android-shim.test.ts`.

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/android-billiard-shim.test.ts
```
Expected: FAIL — `buildBilliardNamespace` not exported.

- [ ] **Step 3: Implement**

In `stubs.ts` (follow the existing `buildAuthNamespace` style — synthetic default when the transport method is absent, delegate when present):

```typescript
/** Billiard namespace (P1 online-only; reads degrade to empty, writes reject). */
export function buildBilliardNamespace({ transport }: StubDeps) {
  const EMPTY_OVERVIEW = { tables: [], floorPlans: [], layouts: [], sessions: [], _fromCache: true };
  return {
    getFloorOverview: () => withTransport(transport.billiardGetOverview, [], () => EMPTY_OVERVIEW),
    getSession: (id: string) => withTransport(transport.billiardGetSession, [id], () => null),
    getCombos: (activeOnly?: boolean) => withTransport(transport.billiardGetCombos, [activeOnly], () => []),
    getFloorPlans: () => withTransport(transport.billiardGetFloorPlans, [], () => []),
    getFnbProducts: (search?: string, categoryId?: string) => withTransport(transport.billiardGetFnbProducts, [search, categoryId], () => []),
    getFnbCategories: () => withTransport(transport.billiardGetFnbCategories, [], () => []),
    getResourceType: (code: string) => withTransport(transport.billiardGetResourceType, [code], () => null),
    getRestaurantCombos: () => withTransport(transport.billiardGetRestaurantCombos, [], () => []),
    mutate: (op: string, method: string, path: string, body?: any) => {
      if (!transport.billiardMutate) return Promise.reject(new Error('Billiard requires a network connection.'));
      return transport.billiardMutate(op, method, path, body);
    },
    getSyncStatus: () => withTransport(transport.billiardSyncStatus, [], () => ({ pending: 0, lastSync: null, online: false })),
    onDataUpdated: (cb: (d: { type: string }) => void) => transport.billiardOnDataUpdated ? transport.billiardOnDataUpdated(cb) : noopUnsubscribe(),
    printReceipt: (sessionId: string, payment: { method: string; amount: number }) =>
      withTransport(transport.billiardPrintReceipt, [sessionId, payment], () => NO_PRINTER_RESULT),
    openCashDrawer: async () => ({ success: false }),
  };
}

export function buildApiCall({ transport }: StubDeps) {
  return (method: string, path: string, body?: any) => {
    if (!transport.apiCall) return Promise.reject(new Error('This operation requires a network connection.'));
    return transport.apiCall(method, path, body);
  };
}
```

Wire in `index.ts` next to the existing namespaces (`entitlements` is at index.ts:124 for reference):

```typescript
billiard: buildBilliardNamespace(stubDeps),
apiCall: buildApiCall(stubDeps),
```

Append to `SHIM_CONTRACT_S1.md` a `§2.N billiard` section listing every method above with its benign default and the mutate/apiCall reject rule.

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run tests/android-billiard-shim.test.ts tests/android-shim.test.ts
```
Expected: PASS (android-shim.test.ts guards the untouched existing literals).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/android-pos/shim/ tests/android-billiard-shim.test.ts docs/android-pos/SHIM_CONTRACT_S1.md
git commit -m "feat(android-billiard): shim surface + synthetic defaults for billiard namespace and apiCall"
```

---

### Task 4: Real online-only billiard transport

**Files:**
- Create: `src/renderer/android-pos/shim/billiard-transport.ts`
- Modify: `src/renderer/android-pos/shim/real-transport.ts` (attach the methods)
- Test: `tests/android-billiard-transport.test.ts`

**Interfaces:**
- Consumes: `ShimTransport` optional members from Task 3; `PosApiClient` from `src/renderer/android-pos/port/api-client.ts` (reuse the same client instance `createRealTransport` builds — read how existing calls go through it; if it lacks a generic `request(method, path, body)` passthrough, add one THERE with a unit test rather than duplicating auth/refresh logic).
- Produces: `createBilliardTransport({ request }): BilliardTransportMethods` — an object with exactly the `billiard*`/`apiCall` members of Task 3, plus `dispose()` to stop the poll timer.

- [ ] **Step 1: Write the failing tests** (mock `request`, use Task 2 fixtures)

```typescript
// tests/android-billiard-transport.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createBilliardTransport } from '../src/renderer/android-pos/shim/billiard-transport';
import dashboard from './fixtures/billiard/dashboard.json';
import floorPlans from './fixtures/billiard/floor-plans.json';

function makeRequest(map: Record<string, any>) {
  return vi.fn(async (method: string, path: string, _body?: any) => {
    const hit = map[`${method} ${path}`];
    if (hit instanceof Error) throw hit;
    if (hit === undefined) throw new Error(`unexpected ${method} ${path}`);
    return hit;
  });
}

describe('billiard online-only transport', () => {
  it('getFloorOverview returns tables with embedded layout+session', async () => {
    const request = makeRequest({ 'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans });
    const t = createBilliardTransport({ request });
    const overview = await t.billiardGetOverview();
    expect(Array.isArray(overview.tables)).toBe(true);
    // shape contract with BilliardFloorPlan — DECIDED BY TASK-2 FIXTURES:
    // server dashboard = bare array of { resource, status, layout, session },
    // identical per-table shape to getLocalFloorOverview().tables[] (now at
    // billiard-sync.ts:633 post-merge). Fields nest under table.resource.*
    for (const table of overview.tables) {
      expect(table).toHaveProperty('resource.id');
      expect(table).toHaveProperty('resource.name');
      expect(table).toHaveProperty('resource.pricingRules');
      expect(table).toHaveProperty('status');
      expect(table).toHaveProperty('layout');
    }
    t.dispose();
  });

  it('mutate does a direct call and refreshes the cache', async () => {
    const request = makeRequest({
      'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans,
      'PATCH /billiard/floor-plans/fp1': { ok: true },
    });
    const t = createBilliardTransport({ request });
    await expect(t.billiardMutate('update_floor_plan', 'PATCH', '/billiard/floor-plans/fp1', { name: 'x' })).resolves.toEqual({ ok: true });
    t.dispose();
  });

  it('mutate failure propagates — never fakes success', async () => {
    const request = makeRequest({ 'POST /billiard/sessions/s1/pay': new Error('HTTP 400 already-paid') });
    const t = createBilliardTransport({ request });
    await expect(t.billiardMutate('pay', 'POST', '/billiard/sessions/s1/pay', {})).rejects.toThrow('already-paid');
    t.dispose();
  });

  it('sync status flips online after a successful read, offline after a failed one', async () => {
    const request = makeRequest({ 'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans });
    const t = createBilliardTransport({ request });
    await t.billiardGetOverview();
    await expect(t.billiardSyncStatus()).resolves.toMatchObject({ pending: 0, online: true });
    t.dispose();
  });

  it('onDataUpdated fires after a mutate-triggered refresh', async () => {
    const request = makeRequest({
      'GET /billiard/dashboard': dashboard, 'GET /billiard/floor-plans': floorPlans,
      'PATCH /billiard/floor-plans/fp1': { ok: true },
    });
    const t = createBilliardTransport({ request });
    const cb = vi.fn();
    t.billiardOnDataUpdated(cb);
    await t.billiardMutate('update_floor_plan', 'PATCH', '/billiard/floor-plans/fp1', {});
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith({ type: 'dashboard' }));
    t.dispose();
  });

  it('apiCall allowlists billiard/resources/restaurant paths only', async () => {
    const request = makeRequest({ 'GET /billiard/combos': [] });
    const t = createBilliardTransport({ request });
    await expect(t.apiCall('GET', '/billiard/combos')).resolves.toEqual([]);
    await expect(t.apiCall('GET', '/admin/users')).rejects.toThrow(/not allowed/);
    await expect(t.apiCall('GET', '/billiard/../auth')).rejects.toThrow(/Invalid/);
    t.dispose();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run tests/android-billiard-transport.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `billiard-transport.ts`**

```typescript
/**
 * Billiard online-only transport (P1). No local DB, no offline queue —
 * the Windows counterpart caches in SQLite (src/main/sync/billiard-sync.ts);
 * here reads hit the backend with a 10s-poll in-memory cache and writes go
 * straight through. Server is the source of truth for all charges.
 */
export interface BilliardTransportDeps {
  /** Authenticated JSON request — same normalization as PosApiClient:
   *  path '/billiard/x' → '<base>/api/v1/billiard/x', Bearer staff-JWT. */
  request: (method: string, path: string, body?: any) => Promise<any>;
  pollMs?: number; // default 10_000 to match Windows (billiard-sync.ts:163)
}

const API_ALLOWED_PREFIXES = ['/billiard/', '/resources/', '/restaurant/', '/resources'];

export function createBilliardTransport({ request, pollMs = 10_000 }: BilliardTransportDeps) {
  let cache: { overview: any | null; fetchedAt: number } = { overview: null, fetchedAt: 0 };
  let lastSync: string | null = null;
  let online = false;
  const listeners = new Set<(d: { type: string }) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const emit = (type: string) => { for (const cb of listeners) { try { cb({ type }); } catch { /* listener errors are the listener's problem */ } } };

  async function refreshOverview(): Promise<any> {
    const [dash, plans] = await Promise.all([
      request('GET', '/billiard/dashboard'),
      request('GET', '/billiard/floor-plans').catch(() => []),
    ]);
    // Strategy DECIDED by Task-2 fixtures (tests/fixtures/billiard/):
    // GET /billiard/dashboard returns a BARE ARRAY of { resource, status,
    // layout, session } — per-table shape already identical to
    // getLocalFloorOverview().tables[] (billiard-sync.ts:633 post-merge).
    // assembleOverview therefore: tables = dash (pass-through),
    // floorPlans = plans (each embeds its layouts[]), sessions/pendingPayments
    // derived from tables where session != null, _fromCache omitted/false.
    const overview = assembleOverview(dash, plans); // keep output keys IDENTICAL to billiard-sync.ts:633
    cache = { overview, fetchedAt: Date.now() };
    lastSync = new Date().toISOString();
    online = true;
    return overview;
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(() => { refreshOverview().then(() => emit('dashboard')).catch(() => { online = false; }); }, pollMs);
  }

  return {
    billiardGetOverview: async () => {
      try { const o = await refreshOverview(); startPolling(); return o; }
      catch (e) { online = false; if (cache.overview) return { ...cache.overview, _fromCache: true }; throw e; }
    },
    billiardGetSession: (id: string) => request('GET', `/billiard/sessions/${encodeURIComponent(id)}`),
    billiardGetCombos: async (activeOnly?: boolean) => {
      const combos = await request('GET', '/billiard/combos');
      const list = Array.isArray(combos) ? combos : combos?.data ?? [];
      return activeOnly ? list.filter((c: any) => c.isActive !== false) : list;
    },
    billiardGetFloorPlans: () => request('GET', '/billiard/floor-plans'),
    billiardGetFnbProducts: (search?: string, categoryId?: string) => {
      const q = new URLSearchParams();
      if (search) q.set('search', search);
      if (categoryId) q.set('categoryId', categoryId);
      // Windows serves these from the synced product cache filtered to F&B —
      // read sync.module.ts:245-263 for the source and mirror the backend
      // route the sync fills it from (fall back to the shim catalog DB
      // product-repo if a direct route does not exist).
      return request('GET', `/billiard/fnb/products${q.toString() ? `?${q}` : ''}`);
    },
    billiardGetFnbCategories: () => request('GET', '/billiard/fnb/categories'),
    billiardGetResourceType: async (code: string) => {
      const o = cache.overview ?? await refreshOverview();
      const table = (o.tables ?? []).find((t: any) => t.typeName === code || t.typeCode === code);
      return table ? { id: table.typeId, code, name: table.typeName } : null; // mirrors sync.module.ts:266-279 derivation
    },
    billiardGetRestaurantCombos: () => request('GET', '/restaurant/combos').catch(() => []),
    billiardMutate: async (op: string, method: string, path: string, body?: any) => {
      const result = await request(method, path, body); // throws on failure — MONEY PATH, no catch
      refreshOverview().then(() => emit('dashboard')).catch(() => { /* post-mutation refresh best-effort */ });
      return result;
    },
    billiardSyncStatus: async () => ({ pending: 0, lastSync, online }),
    billiardOnDataUpdated: (cb: (d: { type: string }) => void) => { listeners.add(cb); startPolling(); return () => { listeners.delete(cb); }; },
    billiardPrintReceipt: async (_sessionId: string, _payment: { method: string; amount: number }) => NO_PRINTER_RESULT, // Task 5 revisits
    apiCall: (method: string, path: string, body?: any) => {
      const m = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) return Promise.reject(new Error(`Invalid HTTP method: ${method}`));
      if (path.includes('..') || path.includes('//')) return Promise.reject(new Error('Invalid API path'));
      if (!API_ALLOWED_PREFIXES.some((p) => path.startsWith(p))) return Promise.reject(new Error(`API path not allowed: ${path}`));
      return request(m, path, body);
    },
    dispose: () => { if (timer) clearInterval(timer); timer = null; listeners.clear(); },
  };
}
```

`assembleOverview` + `NO_PRINTER_RESULT` must be written against the real fixture/Windows literal (Task 2 / sync.module.ts) — output keys IDENTICAL to `getLocalFloorOverview()`. If the fixture shows an endpoint doesn't exist (e.g. `/billiard/fnb/*` 404s), have that read return `[]` and log once — the add-item modal then shows an empty product list, which is a P2 follow-up, not a crash.

- [ ] **Step 4: Attach in `real-transport.ts`** — inside `createRealTransport`, after the client is built: create the billiard transport with a `request` bound to the same `PosApiClient` (add the generic passthrough there if missing), spread its methods into the returned transport object, and call `dispose()` wherever the transport tears down (auth-expired/logout path).

- [ ] **Step 5: Run tests** — `npx vitest run tests/android-billiard-transport.test.ts tests/android-real-transport.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/android-pos/shim/ tests/android-billiard-transport.test.ts
git commit -m "feat(android-billiard): online-only billiard transport (reads+poll, direct mutate, allowlisted apiCall)"
```

---

### Task 5: Payment-adjacent hardware behavior (print / drawer) — verify, don't guess

**Files:**
- Modify: `src/renderer/android-pos/shim/billiard-transport.ts` (only if Step 1 findings demand it)
- Test: extend `tests/android-billiard-transport.test.ts`

- [ ] **Step 1: Read the two `printReceipt` call sites** (`grep -rn "billiard.printReceipt" src/renderer/components/billiard/`) — confirm the UI treats `{ success, receiptPrinted: false }` as "payment done, receipt skipped" (toast/warning) and NOT as payment failure. Read `PaymentDialog.tsx` around the call.
- [ ] **Step 2: Write a test pinning that contract** — assert the stub/transport return equals the exact literal the Windows no-printer path returns (`sync.module.ts` billiard:print:receipt handler), so payment settle on Android never blocks on printing.
- [ ] **Step 3: (Only if the UI hard-fails without a printed receipt)** wire `billiardPrintReceipt` through the existing remote-print shim (`src/renderer/android-pos/shim/remote-print.ts`, E-FISCAL path) to send the receipt job to the salon's Windows agent; otherwise leave the benign return.
- [ ] **Step 4: Run android test set** — `npx vitest run tests/android-*.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(android-billiard): pin payment-vs-print contract for Android (no local printer)"`

---

### Task 6: Mount the Bi-a UI on Android (entitlement-gated mode tabs)

**Files:**
- Modify: `src/renderer/android-pos/AndroidBootApp.tsx`
- Test: `tests/android-billiard-boot.test.tsx` (create; follow the mounting-test pattern of the existing android boot/LoginScreen tests if one exists, else a light render test with the shim installed)

**Interfaces:**
- Consumes: `window.electronAPI.entitlements.get()` (already wired, index.ts:124), `window.electronAPI.getConfig()`, `BilliardFloorPlan` from `../components/billiard/BilliardFloorPlan` with prop `language` (App.tsx:518).

- [ ] **Step 1: Failing test** — render AndroidBootApp with a shim whose entitlements return `features.billiard.enabled=true`; expect a "Bi-a" tab button to appear; with `enabled=false` expect no tab and plain POSApp.

- [ ] **Step 2: Implement**

```tsx
// inside AndroidBootApp — additions only, keep existing boot logic untouched
import BilliardFloorPlan from '../components/billiard/BilliardFloorPlan';
import type { Language } from '../i18n/translations'; // match App.tsx's import path for Language

const [mode, setMode] = useState<'pos' | 'billiard'>(() =>
  (localStorage.getItem('android.pos.mode') as 'pos' | 'billiard') || 'pos');
const [billiardEnabled, setBilliardEnabled] = useState(false);
const [language, setLanguage] = useState<Language>('en');

useEffect(() => {
  if (state !== 'pos') return;
  const api = (window as any).electronAPI;
  api.entitlements.get()
    .then((e: any) => setBilliardEnabled(!!e?.features?.billiard?.enabled))
    .catch(() => setBilliardEnabled(false));
  api.getConfig?.().then((c: any) => c?.language && setLanguage(c.language)).catch(() => {});
}, [state]);

const switchMode = (m: 'pos' | 'billiard') => { localStorage.setItem('android.pos.mode', m); setMode(m); };

// in the state === 'pos' return branch:
return (
  <div className="h-screen flex flex-col">
    {billiardEnabled && (
      <nav className="flex shrink-0 border-b bg-white">
        <button className={`flex-1 py-3 text-sm font-semibold ${mode === 'pos' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`} onClick={() => switchMode('pos')}>POS</button>
        <button className={`flex-1 py-3 text-sm font-semibold ${mode === 'billiard' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`} onClick={() => switchMode('billiard')}>Bi-a</button>
      </nav>
    )}
    <div className="flex-1 min-h-0">
      {billiardEnabled && mode === 'billiard' ? <BilliardFloorPlan language={language} /> : <POSApp />}
    </div>
  </div>
);
```

If `state !== 'pos'` fall through to the existing checking/login branches unchanged. If unmounting POSApp on tab switch breaks its in-memory cart, keep both mounted and toggle `hidden` via CSS instead — decide by reading how POSApp holds cart state (shim pos-store is a module singleton, so remount is likely safe; verify).

- [ ] **Step 3: Boundary check** — `npm run test:android:boundaries:source` must stay green: pulling `BilliardFloorPlan` into the android graph may drag imports the verifier rejects; if it flags something, fix by lazy `React.lazy` import or add the finding to the task report — do NOT add exemptions silently.

- [ ] **Step 4: Tests + build** — `npx vitest run tests/android-*.test.ts && npm run build:android:web` → PASS/exit 0.

- [ ] **Step 5: Commit** — `git commit -am "feat(android-billiard): entitlement-gated POS/Bi-a mode tabs in AndroidBootApp"`

---

### Task 7: Full verification + APK

- [ ] **Step 1: Full builds**

```bash
npm run build && npm run build:android:web
npm run test:android:boundaries:source && npm run test:android:boundaries:bundle
```
All exit 0.

- [ ] **Step 2: Full test suite vs baseline**

```bash
npm test 2>&1 | tail -30
```
Expected: android tests 100% pass; Windows-main failures only within the known flaky baseline (~13 files at fork point `2250624` — list any NEW failing file as a finding).

- [ ] **Step 3: Copy web bundle into Capacitor + assemble debug APK**

```bash
npx cap sync android 2>/dev/null || node scripts/copy-android-assets.mjs 2>/dev/null || cp -r dist/android-web/* android-pos/app/src/main/assets/public/
npm run test:android:boundaries:native-assets
cd android-pos && ./gradlew assembleDebug && cd ..
ls -la android-pos/app/build/outputs/apk/debug/app-debug.apk
```
(Use whichever asset-copy mechanism the repo actually has — check `capacitor.config.ts` `webDir` first; the fallbacks above are in preference order.)

- [ ] **Step 4: Live smoke against dev backend** — serve `dist/android-web` (`npx vite preview --config vite.android.config.ts`) in a desktop browser, log in with `BILLIARD_TEST_EMAIL`, switch to Bi-a tab, verify: floor plan renders tables from the dev DB, opening a table session works, adding an item works, error toast appears when the backend is stopped (kill switch test), and NO console errors referencing `undefined` electronAPI members.

- [ ] **Step 5: Commit + report** — commit any fixes; final report lists: commands run + exit codes, screenshot paths if taken, new-vs-baseline test failures, APK path + size.

---

### Task 8: Docs + readiness register

- [ ] **Step 1:** Amend `docs/android-pos/EXPANSION_PLAN_2026-07-19.md`: move billiard from "Explicitly NOT planned" to a new "Wave B-1 (billiard, online-only)" section describing exactly what shipped (this plan) and what stays out (offline queue, local printer, aux namespaces reservation/happyHour/kds/stock/sessionHistory/billiardGuest/dailyReport — listed as Wave B-2 candidates).
- [ ] **Step 2:** Add an entry to `docs/android-pos/production-readiness-register.json` following its existing schema: billiard-online-only, owner-decision required before any live salon use (P1 has no offline mode — network loss = read-only cached floor view).
- [ ] **Step 3:** Update `docs/android-pos/SHIM_CONTRACT_S1.md` cross-references if Task 3 left any TODO.
- [ ] **Step 4:** Commit — `git commit -am "docs(android-billiard): wave B-1 scope, readiness register entry, contract cross-refs"`

---

## Self-Review (done at plan time)

- **Coverage:** locate app ✓ (recon done pre-plan), branch hygiene (T1), backend contract gate (T2), shim surface (T3), real transport (T4), money/print safety (T5), UI mount (T6), verification+APK (T7), docs (T8). Aux namespaces explicitly deferred (safe via `?.` — verified in recon). Offline queue explicitly out of P1 scope.
- **Types:** `buildBilliardNamespace`/`buildApiCall` names consistent across T3 tests/impl/wiring; `billiard*` transport member names identical in T3 interface and T4 impl; `createBilliardTransport({ request })` consistent T4 test/impl; `NO_PRINTER_RESULT` deliberately a named constant resolved from Windows source in T3 Step 1 and reused in T4/T5.
- **Known unknowns made explicit (gated, not guessed):** login token shape (T2 prints raw body), dashboard response shape (T2 fixtures decide T4 strategy), `/billiard/fnb/*` existence (T4 fallback to `[]`), PosApiClient generic request (T4 Step 4), printReceipt UI contract (T5 Step 1), POSApp remount safety (T6 Step 2), asset-copy mechanism (T7 Step 3).
