# Android POS — what to do next (verified plan, 2026-08-03)

Written after re-reading the code, not from memory. Every claim below cites the
file it came from. Where an earlier plan already specifies work correctly, this
document points at it instead of repeating it.

---

## 0. What is actually true right now

| Fact | Evidence |
|---|---|
| 13 commits exist in exactly ONE place | `git branch -r --contains HEAD` → empty; branch upstream is `[gone]` |
| The tablet still cannot settle a table | `AndroidBootApp.tsx:187` passes no `onPayInPos`; `PaymentDialog.tsx:361` disables the only primary action |
| Nothing has been built into an APK this wave | no `android:build:verify` run since the wave started; all 315 android tests are unit tests |
| The local ledger can be deleted by the OS | `grep -r storage.persist src/renderer/android-pos` → **0 hits**; the whole DB is one IndexedDB blob (`db.ts:52-56`), `allowBackup="false"` in the manifest |
| L5 is 6/8 methods | done: preflight, prepare, markPaymentOpened, beginTender, complete, recover. missing: `resolveUncertainTender`, `beginRestoredTender` |
| A 15-task readiness plan already exists and is UNIMPLEMENTED | `docs/superpowers/plans/2026-07-25-android-pos-device-readiness-fixes.md`, 2907 lines, untracked, none of its files exist |

### The ordering argument, stated plainly

This wave built a durable ledger — journal, protected holds, tender boundaries,
crash recovery — and **that ledger lives in storage Android is allowed to
evict**. Turning the button on (L6) before Task 3 of the 25/07 plan ships means
shipping a money path whose safety net the OS can silently delete. That is the
reason storage comes first, not tidiness.

Second ordering constraint: `recover` (`bde8f65`) can now *produce*
`POS_TENDER_UNCERTAIN`, and the tablet has no way out of that state, because
`resolveUncertainTender` is not ported. Turning the button on before it lands
means one process kill mid-tender strands a table until someone walks to the
Windows counter.

---

## 1. Corrections to the 2026-07-25 plan (it was written against older code)

Do NOT execute that plan as-written. Verified drift:

| Its claim | Reality today | Fix |
|---|---|---|
| Task 4 adds `pos_snapshot` as the next schema version | schema is now **v7** (`schema.ts` ANDROID_SCHEMA_VERSION), not v4 | `pos_snapshot` becomes **v8** |
| Task 5 edits `pos-store.ts` state types | those types moved to `src/shared/pos/pos-state.ts` in L3 (`3e7dcd0`); pos-store re-exports them | write `CartHydration` against the shared types |
| Task 7 cites `real-transport.ts:1119-1182` / `:1154-1158` | line numbers shifted (the billiard catalog dep was inserted at ~line 540 in `759b0d2`) | re-locate by symbol, not by line |
| Task 10 rewrites the `AndroidBootApp` render block | **L6 rewrites the same block** | merge them into ONE task (§3.4) |
| Task 8 consumes `ShimTransport.posSnapshotClear` | that member does not exist yet; Task 5 creates it | keep the 5 → 8 order |
| Task 2 says the boot entry has no error surface | still true (`main.ts:53-58`) | unchanged |

Everything else in that plan re-verified as still accurate.

---

## 2. Step 0 — push, now

13 commits, no remote copy. The branch upstream is gone, so it needs an explicit
push:

```bash
git -C /var/www/pos-zira push -u origin HEAD
```

Nothing else in this plan matters if the disk dies. **~10 seconds.**

---

## 3. The ordered work

### 3.1 Storage durability — 25/07 plan Tasks 3, 4, 5, 6

Take them **as specified there** (they are correct and come with tests), with
the §1 corrections applied:

- **Task 3** — `navigator.storage.persist()` + an at-risk banner. Self-contained,
  no dependencies. *This is the one that makes everything already built real.*
- **Task 4** — `pos_snapshot` table (**as schema v8**) + repo.
- **Task 5** — persist/rehydrate the cart through it.
- **Task 6** — back-press becomes a decision instead of `finish()`
  (`MainActivity.java` currently only registers `SecureKVPlugin`; there is no
  `OnBackPressedCallback`).

**Why together:** 3 protects the ledger this wave depends on; 5 stops one Back
press from destroying a 30-line cart; 4 is 5's storage; 6 is the trigger that
loses it.

**Cost:** ~1 working session. **Gate:** the plan's own steps + full android
suite + boundaries.

### 3.2 `resolveUncertainTender` — the missing exit

Verified contract (`pos.module.ts:2657-2790`, BILLIARD branch only):

- OWNER role only → else `{ code: 'OWNER_REQUIRED' }`
- `reason` 3–500 chars; `confirmedNoPaymentRemains === true` required
- record must exist on this salon+register and be `POS_TENDER_UNCERTAIN`
- refuses when a local paid order exists → `{ paymentCommitted: true }`
- refuses when another cart is live and is not this frozen checkout
- validates the protected interrupted hold before adopting it
  (`samePosSalonRegister`)
- one transaction: `resolveUncertainTenderAsNoPayment(checkoutId, audit, scope)`
  + `holdOrderRepo.replaceProtected(...)` with `adoptPosCheckoutSnapshotScope`
- durability failure → rollback BOTH via `rollbackNoPaymentResolution` +
  restore the hold payload, then report `rollbackDurabilityError`
- auth changed after a durable save → report `resolved: true` with the
  "sign in as the original owner" message

**Already available:** every repo method it needs exists (`6c55952`), and
`adoptPosCheckoutSnapshotScope` / `samePosSalonRegister` are already shared
(`3e7dcd0`).

**Out of scope for this task:** the `RESTORED_CART` target branch — it belongs
with the restored-cart slice.

**Cost:** ~half a session. **Gate:** android suite + a test per refusal.

### 3.3 Wire the shim namespace

Three edits, all verified as missing today:

1. `shim/transport.ts` — `ShimTransport` has **no** billiardCheckout members
   (grep: zero hits). Add the 6 implemented ones.
2. `shim/index.ts:103-112` — this is where the `'desktop-only'` stubs live
   (**not** `stubs.ts`). Delegate to the transport when present, keep the
   refusals as the fallback.
3. `real-transport.ts` — construct `createBilliardHandoff(...)`.

**The seam that needs a decision.** `createBilliardHandoff` needs `posStore`,
but `createRealTransport({ configStore, tokenStore })` never receives one —
`installShim` creates it (`shim/index.ts:90`). Two options:

- **A.** `real-transport` exposes `attachPosStore(store)`; `installShim` calls it
  right after creating the store, and the handoff is built lazily on first use.
  *Keeps billiard/entitlements/handoff all constructed in one place.*
- **B.** `real-transport` publishes its three platform signals (`db`,
  `isFiscalPrinterAssigned`, `isPrintAgentConnected`) and `installShim` builds
  the handoff itself. *Puts the handoff where posStore already is.*

Recommend **A** for consistency with how `billiard` and `entitlements` are
already built inside `createRealTransport`. Decide at implementation time, in
one line of the commit message.

Also wire `handoff.invalidateAuth()` into `logout()` and the auth-expired path,
next to the existing `billiard.dispose()` / `entitlements.clear()` calls.

**Cost:** ~half a session.

### 3.4 L6 — turn the button on (merged with 25/07 Task 10)

Verified facts:

- `POSApp` is a 5-line wrapper taking **no props**
  (`src/renderer/windows/pos/POSApp.tsx`), used by Windows too
  (`windows/pos/main.tsx:3`). **Do not add props to it** — have
  `AndroidBootApp` render `POSLayout` directly.
- `POSLayout` accepts 9 optional props; Android needs 6:
  `billiardPaymentIntent`, `restoredCartReconciliation`,
  `onBilliardPaymentIntentConsumed`, `canResolveUncertainTender`,
  `onBilliardTenderResolved`, `onRestoredTenderResolved`.
- `BilliardFloorPlan` needs `onPreflightPos`, `onPayInPos` and (Task 10)
  `active`.
- The Windows shell logic to mirror is `App.tsx:160-215` (prepare/preflight
  handlers + the boot `recover()` effect) and `App.tsx:513-527` (the props).
- `canResolveUncertainTender` is `role === 'OWNER'` (`App.tsx:515`).

Deliverables: the merged render block (mounted-but-hidden panes from Task 10 +
the intent props), the two handoff callbacks, the boot `recover()` effect, and
**deleting both `KNOWN_SHELL_PROP_GAPS` entries** in
`tests/android-shell-props-parity.test.tsx` — that guard fails until they go.

**Cost:** ~1 session. **Gate:** parity guards go green with the registry
entries removed; android suite; `npm run build`.

### 3.5 First real APK + device verification

Nothing here has run on a device this wave. Minimum:

```bash
npm run android:build:verify      # boundaries + cap sync + gradle
npm run test:android:manifests
```

Then on a device/emulator, in this order:

1. **Migration over a REAL installed image.** Sideload the pre-wave APK
   (`/home/paul/apk/zira-pos-android-debug-dff711a.apk`, schema v4), log in, sell
   one item, then install the new build **over it** and confirm the DB upgrades
   v4 → v8 with the order still present. The additive guards in
   `applyAndroidSchema` are unit-tested on fresh DBs only.
2. F&B list on the Bi-a tab is no longer empty (`759b0d2`).
3. Full settle: open table → end session → pay → cart clears → table free.
4. Kill the app mid-tender (`adb shell am force-stop`) and reopen → expect the
   uncertain lane, and resolve it as OWNER.

**Cost:** ~1 session, needs hardware.

### 3.6 Deferred on purpose

`beginRestoredTender` + auto-restore of the parked cart. A parked cart is
already safe and recallable from Holds (`930f92f`); reinstating it without its
journal would hand back an unprotected cart. Land it after 3.5.

---

## 4. Risks

| Risk | Severity | Handling |
|---|---|---|
| v4 → v8 upgrade fails on a real installed image | HIGH | 3.5 step 1 tests exactly this before anything else |
| Storage evicted → journal + unsynced orders lost | HIGH | 3.1 Task 3 is first for this reason |
| Turning L6 on before 3.2 strands a table on any process kill | HIGH | 3.2 precedes 3.4 |
| The 25/07 plan executed as-written against drifted code | MED | §1 corrections; re-locate by symbol not line |
| Merge conflict between Task 10 and L6 | MED | merged into one task (3.4) |
| Work exists only on this disk | MED | §2, do it first |

---

## 5. Summary

```
0  push                      10 s      ← do this now
3.1 storage + cart + back    ~1 session ← makes the ledger real
3.2 resolveUncertainTender   ~½ session ← no dead ends
3.3 shim namespace wiring    ~½ session
3.4 L6 (+ Task 10)           ~1 session ← the button goes live
3.5 APK + device sweep       ~1 session ← needs hardware
3.6 restored-cart slice      later
```

Independently shippable today, not blocked by any of the above: the F&B catalog
fix (`759b0d2`) — it makes the Bi-a add-item list work and needs no UI wiring.
