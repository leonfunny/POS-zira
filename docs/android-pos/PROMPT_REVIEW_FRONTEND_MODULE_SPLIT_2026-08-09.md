# Review packet — how the frontend is split between Windows and Android

Prepared 2026-08-09. This is a **review**, not an implementation task. Produce a
written comparison and a recommendation. Do not change product behaviour while
answering it.

---

## 1. The question being asked

The owner looked at the Android till and said it does not look like the Windows
POS. Before treating that as a bug, establish **what Android is supposed to be a
copy of** — because Windows is not one screen, it is five.

## 2. Ground truth measured on 2026-08-09

`vite.config.ts` builds **five separate renderer entries**, i.e. five Electron
windows, each its own React root:

| Entry | HTML | Root component | What it is |
|---|---|---|---|
| `main` | `src/renderer/index.html` | `App.tsx` (723 lines) | back-office shell: Sidebar + 21 modules |
| `pos` | `src/renderer/windows/pos/index.html` | `POSApp.tsx` → `POSLayout` | **the cashier screen** |
| `customer` | `windows/customer/` | — | customer-facing display |
| `selfCheckout` | `windows/self-checkout/` | — | self-checkout kiosk |
| `kitchenSelfOrder` | `windows/kitchen-self-order/` | — | kitchen self-order |

`vite.android.config.ts` builds **one** entry: `src/renderer/android-pos/index.html`
→ `AndroidBootApp.tsx` (379 lines) → `POSLayout` + `BilliardFloorPlan` +
`SettingsScreen`.

`POSApp.tsx` is a 6-line wrapper that renders `<POSLayout />` and nothing else,
so Android importing `POSLayout` directly is equivalent. Note the comment at
`vite.android.config.ts:6-8` claims the Android entry "mounts the REAL Windows
POS renderer (src/renderer/windows/pos/POSApp)" — that is stale; verify and
correct it as part of this review.

### Modules `App.tsx` mounts that Android has no counterpart for

```
AuthScreen        BooksySync        Chat              Debug
OrdersTab         RemoteIndicator   SelfCheckoutTab   Settings
Sidebar           Status            BookingsTodayScreen
CheckinWizard     ForecastOrderingTab   InvoicingTab  LabelModule
ProductModule     SecurityTab       TouchKeyboard     WarehouseModule
```

Android mounts 4 of the 21 (`POSLayout`, `BilliardFloorPlan`, plus its own
`LoginScreen` and `SettingsScreen`).

### Sizes, for a sense of what porting would cost

```
Settings.tsx            6298      POSLayout.tsx           2088
ProductModule.tsx       1048      WarehouseModule.tsx      994
App.tsx                  723      AndroidBootApp.tsx       379
```

### The layer below the UI, already audited

Windows exposes **412** `electronAPI` function paths; the Android shim
implements **208**. The 212-path gap is mostly deliberate and each entry is
justified in the registry inside `tests/android-preload-surface-parity.test.ts`.
Read that registry before proposing that anything be ported — most of it is
hardware, desktop-shell, or back-office by design.

## 3. What the review must answer

1. **Which Windows window is Android the counterpart of?** Argue it from the
   code, not from intent. If the answer is `pos`, say what in `AndroidBootApp`
   goes beyond that window (billiard tab, settings tab, storage banner) and
   whether each belongs there or is a shell concern that should be modelled
   differently.
2. **Where exactly do the two cashier screens diverge?** Both render the same
   `POSLayout`. Produce a concrete list of every visible difference and its
   cause, distinguishing:
   - config-driven (`posMode`, `posLanguage`, entitlements) — not a code
     difference at all;
   - prop-driven (`embedded`, `canResolveUncertainTender`, the billiard payment
     intent props);
   - capability-driven (a panel that silently hides because a shim method is
     absent or returns `'desktop-only'`);
   - genuine divergence (shared code that behaves differently per platform).
   The last category is the only one that is a defect. Name each instance.
3. **Is the current module split the right one?** The shared-renderer decision
   (`PARITY_PORT_PLAN_2026-07-18.md`) means every file under
   `src/renderer/components/**` ships to both platforms. Assess whether that is
   still serving the project, given `POSLayout` is 2088 lines carrying four
   templates and both platforms' branches. If you propose a different split,
   state the migration cost and what breaks during it.
4. **Which of the 17 unported modules actually belong on a till?** Most are
   back-office and belong on the counter PC. Rank the few that a cashier at a
   tablet genuinely needs, with a reason per item. `pos.loyalty.lookupCustomer`
   is a known live gap — a customer's loyalty card cannot be looked up on the
   tablet today.
5. **Name the traps** a future port would hit, from evidence in this repo.
   At minimum, check: the Chromium-83 WebView floor, the 1336×736 canvas, the
   `embedded` vs `100vh` split documented at `POSLayout.tsx:277-288`, and the
   fact that editing a shared component changes live Windows tills.

## 4. How to work

- Read-only. No behaviour changes. If you spot a defect, write it down with
  file:line; do not fix it in this pass.
- Correcting a stale comment or an inaccurate doc is in scope, and welcome.
- Every claim must cite file:line or a command whose output you paste. Do not
  assert that two screens "look the same" without saying what you compared.
- Where a number matters, measure it rather than estimate. The audits in §2 were
  produced by capturing both surfaces at runtime; the same technique is
  available to you in `tests/android-preload-surface-parity.test.ts`.
- Beware of name-parity: `pos.billiardCheckout` exists on both platforms yet all
  eight Android methods return `'desktop-only'` (`shim/index.ts:103-112`).
  Matching names prove nothing about behaviour.

## 5. Deliverable

A markdown document at `docs/android-pos/REVIEW_FRONTEND_MODULE_SPLIT_2026-08-09.md`:

1. **Verdict in three sentences** — is the split sound, and is "does not look
   like Windows" a defect or a configuration difference?
2. **The five-windows map**, corrected if §2 got anything wrong.
3. **Divergence table** for the cashier screen, in the four categories from
   §3.2, with file:line per row.
4. **Defects found**, ranked, each with the evidence that it is real.
5. **Recommendation** on the module split, with cost.
6. **What you did not check**, stated plainly.

Do not commit. Report the file path and a summary.

## 6. Repo facts

- Repo `/var/www/pos-zira` (github `leonfunny/POS-zira`) — a different repo from
  eNail. Worktree **outside** the eNail tree.
- Branch to read: `codex/android-settings-20260809` (latest Android work,
  includes the settings screen).
- `main` carries no Android code at all — do not use it as a baseline.
- Useful: `docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md`,
  `docs/android-pos/SHIM_CONTRACT_S1.md`,
  `tests/android-preload-surface-parity.test.ts`,
  `tests/android-shell-props-parity.test.tsx`.
