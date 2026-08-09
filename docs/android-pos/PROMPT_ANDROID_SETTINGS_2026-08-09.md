# Work packet — a settings screen for the Android till

Prepared 2026-08-09 for a Codex agent. Read all of it before writing code.

---

## 1. Why this exists

The Android POS has **no settings screen at all**. `AndroidBootApp.tsx` imports
exactly three things — `LoginScreen`, `POSLayout`, `BilliardFloorPlan` — and the
shared `POSLayout` never opens `Settings`. Windows opens it from
`src/renderer/App.tsx:698`.

The visible consequence: `Settings.tsx:593` defaults `posMode` to `'retail'`,
while `POSLayout.tsx:337` defaults to `'salon'` when no config exists. A Windows
till always passes through Settings and lands on retail; an Android till has no
Settings, so it boots into salon mode and looks like a different product. Today
the only way to change any setting on an Android till is the remote
`SETTINGS_PATCH` device command, which needs a superadmin with 2FA.

## 2. The scope decision — read before proposing a plan

**Do not port `Settings.tsx` wholesale.** That was the original request; the
audit below says it is the wrong shape, and the reviewer will reject a
1:1 port.

Measured on 2026-08-09 by capturing both surfaces at runtime (the Windows
preload with `electron` mocked, the Android shim via `installShim()`):

| | |
|---|---|
| Function paths Windows exposes | 412 |
| Function paths the Android shim implements | 208 |
| `electronAPI` paths `Settings.tsx` + its 3 sub-panels touch | 63 |
| **Of those, absent on Android** | **46** |

Those 46 are not oversights. They are Posnet/fiscal driver installs, serial
port scans, printer calibration, SSH tunnel, Electron auto-updater, OS folder
pickers, auto-start, `shell.openExternal`, TV-ad video picking, LAN kitchen
pairing, `changeSalon`, remote PIN. Every one already carries a written waiver
in `tests/android-preload-surface-parity.test.ts` explaining why the tablet does
not have it. A wholesale port produces a settings screen where roughly
three-quarters of the controls are dead or lie.

**Build a tablet settings screen instead**, covering only what the shim can
actually honour.

### The 17 `Settings.tsx` dependencies Android already has

```
getConfig                                  scale.getNetworkInfo
pos.categories.getAll                      scale.readWeight
pos.kitchenCategories.getAll               testPrint
pos.kitchenCategories.setPrintEnabled      window.open
pos.kitchenCategories.updateOrder
pos.productAdmin.updateCategoryOrder
pos.products.getAll
pos.staff.create / update / setActive
pos.sync.products / staff / onStaffUpdated
```

### The settings the shim already persists

`src/renderer/android-pos/shim/config-store.ts`, and the same keys the remote
`SETTINGS_PATCH` allowlist accepts (`shim/device-command.ts:44-52`):

```
posMode          'salon' | 'retail'
language / posLanguage   pl en vi de cs sk uk
allowOversell            showNonFiscalOrders
customerDisplayEnabled   selfCheckoutEnabled
kitchenSelfOrderEnabled  tvAdEnabled
remoteAccessEnabled      moduleOverrides
```

Treat that allowlist as the contract. If you believe a setting outside it
belongs on the tablet, say so in the plan with a reason — do not widen it
silently, and do not widen the remote allowlist to match.

## 3. What to build

1. **`src/renderer/android-pos/SettingsScreen.tsx`** — new, Android-only. Not a
   copy of `Settings.tsx`. Sections, in this order:
   - **Chế độ bán** — `posMode` salon/retail. The single most important control;
     it is why this packet exists.
   - **Ngôn ngữ** — `posLanguage`, the 7 allowed values.
   - **Bán hàng** — `allowOversell`, `showNonFiscalOrders`.
   - **Thiết bị** — `customerDisplayEnabled`, `selfCheckoutEnabled`,
     `kitchenSelfOrderEnabled`, `tvAdEnabled`, `remoteAccessEnabled`.
   - **Thông tin máy** — read-only: app version from
     `Capacitor.Plugins.AppUpdater.getInfo()`, `machineId`, `agentId`,
     `salonName`, `salonCode`, online state. An operator standing at the till
     must be able to read the same identity the remote panel shows.
2. **An entry point in the Android shell**, i.e. in `AndroidBootApp.tsx`
   chrome — the row that already owns the storage banner and the POS/Bi-a tabs.
   **Do not add it to `POSLayout.tsx`**: that file is shared byte-for-byte with
   Windows, so a button there appears on every Windows till too. The shell/embedded
   split already exists for exactly this reason (`POSLayoutProps.embedded`,
   documented at `POSLayout.tsx:277-288`).
3. **Role gate** — OWNER/MANAGER only, consistent with how the app already
   treats owner-only actions (`AndroidBootApp` computes `isOwner`). A STAFF
   login must not see the entry point.
4. **Tests**, see §5.

Out of scope, do not attempt: printer/fiscal hardware, SSH tunnel, updater UI,
folder pickers, auto-start, TV-ad video picking, LAN kitchen pairing, salon
switching, AI keys, remote PIN.

## 4. Hard rails

- **Repo** `/var/www/pos-zira` (github `leonfunny/POS-zira`) — a different repo
  from eNail. Create your worktree **outside** the eNail tree, e.g.
  `git -C /var/www/pos-zira worktree add /var/www/pos-zira-wt/<task> -b <branch>`.
- **Base branch** `feat/android-remote-mgmt-build-20260809`. Do **not** branch
  off `main` — main carries no Android code at all (58 commits behind, not even
  the INTERNET manifest permission). Do **not** merge anything to `main`.
- **Do not touch `src/main/**`** (the Windows Electron main process) or
  `src/preload/**`.
- **Changing anything under `src/renderer/components/**` changes Windows too.**
  If you believe a shared file must change, stop and put it in the plan first.
- **Chromium 83.** The SUNMI WebView is version 83 and cannot be updated. No
  flex `gap` (use CSS grid `gap`), no `:has()`, no container queries, no
  optional chaining assumptions in emitted CSS. `npm run test:css-baseline`
  guards this — see `docs/superpowers/plans/2026-08-07-pos-redesign-dotykacka-brief.md`
  §0.2 for the measured list.
- **Canvas is 1336×736 CSS px** on the real device. The screen must work
  without vertical scrolling for the primary controls.
- No new npm dependencies without asking.
- No `git reset --hard`, no force-push, no rebasing shared branches.

## 5. Tests — and the standard they are held to

Every test you write will be **mutation-tested** by the reviewer: your fix will
be reverted and the suite re-run. A test that stays green against the reverted
code is a failed deliverable, not a passing one. Two real examples from this
codebase, both of which shipped and both of which were caught this way:

- `pos-device-command.service.spec.ts` built its oversized payload from the very
  constant it was testing (`"x".repeat(MAX_RESULT_BYTES)`), so raising the cap
  to 32 MiB kept it green.
- `products-v2-bridge-stock.spec.ts` mocked `repo.create` as
  `(v) => v`, which cannot observe TypeORM dropping unmapped keys — the exact
  bug that made every created product save at price 0.00.

Required:

1. Unit tests for the settings screen: each control reads its current value from
   the config store and writes exactly the expected key, with an assertion on
   the persisted value — not merely that a setter was called.
2. A test proving the entry point is **absent for STAFF** and present for
   OWNER/MANAGER.
3. A test proving a value written on the screen and a value delivered by the
   remote `SETTINGS_PATCH` end up in the same place, so the two paths cannot
   drift apart.
4. These existing guards must stay green — run them, do not edit them to pass:
   ```
   npm run test:android:boundaries      # cross-platform boundary verifier
   npm run test:android:parity          # preload-surface + shell-props + order-DTO parity
   npm run test:css-baseline            # Chromium 83
   npx vitest run tests/android-shim.test.ts tests/android-agent-connect.test.ts
   ```
   If `android-preload-surface-parity` fails because you added a shim method,
   register it in that file's registry **with a reason** — the registry is
   two-way, so a stale waiver fails too.

## 6. Verification before you hand back

```bash
npm run test:android:boundaries
npm run test:android:parity
npm run test:css-baseline
npx vitest run
ZIRA_ANDROID_BUILD_NUMBER=<monotonic> npm run android:build:verify
```

The build gate has two lanes. Without `ZIRA_ANDROID_KEYSTORE` set it requires an
**unsigned** release APK; the signed lane is owner-approved and pinned to one
certificate (`docs/android-pos/SIDELOAD_SIGNING_DECISION_2026-08-09.md`). You do
not need the signing key — build the unsigned lane.

Hand back: branch name, commit SHAs, the exact commands you ran with their
output, and an honest list of anything you could not finish. Do not report
"done" on the strength of a green suite alone; say what you actually verified
and how.

## 7. Useful reading

| File | Why |
|---|---|
| `src/renderer/android-pos/AndroidBootApp.tsx` | the shell you are extending |
| `src/renderer/android-pos/shim/config-store.ts` | where settings live |
| `src/renderer/android-pos/shim/device-command.ts` | the remote allowlist you must match |
| `src/renderer/components/Settings.tsx` | the Windows screen — reference only, do not copy |
| `tests/android-preload-surface-parity.test.ts` | what is deliberately not on Android, and why |
| `docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md` | the parity rules this port follows |
| `docs/android-pos/SHIM_CONTRACT_S1.md` | the shim contract, §2.A–§2.N |
