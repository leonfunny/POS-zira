# UI release foundation — implementation record

Date: 2026-09-07. Baseline: GitHub main `42dae0d4732c9f66ad1bff2ad2de67c0e8d10838` (tree `0ee9abfc55757c60ba2e0eba81db17f7119d7d8b`). The newer scale diagnostics change on main was preserved before editing UI code.

This change implements the independently verifiable UI foundation from the commercial-readiness plan. It is a review candidate, not a declaration that every screen or hardware integration is production-ready.

| Review | Implemented | Remaining evidence/work |
|---|---|---|
| R01 | Shared close guard for payment X/backdrop/Escape; fiscal-prompt and receipt-recovery behavior tests | Native printer/terminal scenarios |
| R02 | Concrete backend/receipt contract request in `ui-release-backend-request.md` | Merchant-scoped authorized configuration and receipt snapshot integration; fixed recipient remains unchanged |
| R03 | Renderer body is no longer a draggable region; existing native window chrome remains responsible for window movement | Windows mouse/touch and locked kiosk verification |
| R04–R05 | Shared keyboard ownership and focus restoration for Modal/ConfirmActionDialog; input handlers can consume Escape before dialog shortcuts | Complete native keyboard/scanner and complex overlay audit |
| R06 | Product images reset failure state on source changes; broken thumbnails fall back to original images | Visual sampling of all catalog surfaces |
| R07 | Darker shared primary/payment buttons and readable TextInput helpers/placeholders | Full theme/state contrast audit across every module |
| R08 | Touch sizes improved for retail quick actions and sidebar; independent icon controls labeled; unallowlisted 9–10px labels raised to 12px in floor/table, reservation, cart and history views | Device/DPI layout measurement across other controls |
| R09 | Removed the four hardcoded promotional banners and autoplay from check-in; actions remain | Merchant-editable check-in promotions, scheduling and visual review |
| R10 | Filled missing VI/PL keys in the main translation map; localized product badges and held-cart actions; key/interpolation coverage tests | Auth/kiosk maps, remaining literal strings and human-language review |
| R11 | Cancel/lost-capture/edit-mode exit/unmount clears temporary table positions without saving; ignores other pointers | Real touch interruption and keyboard position editing |
| R12 | Quick-action scroll affordance is no longer explicitly hidden | Full responsive cart/payment redesign requires rendered baselines and device evidence |
| R13 | Replaced all 13 audited native alert/confirm calls with queued in-app feedback; Escape/unmount cancels decisions; security initial-load failure has retry | Audit every operational error branch and printer behavior |
| R14–R15 | Preserved module entitlement/visibility and current font stack; reused shared controls | Role-oriented navigation/settings organization and final typography/layout review |
| R16 | Promo image failures skip bad sources and reach fallback; reduced-motion honored by promo autoplay and global animations | Merchant crop controls and visual audit of all image surfaces |

## Validation approach

- Behavior tests cover payment exit guards, stacked/busy/unsaved dialogs, focus restoration, input-consumed Escape, confirmation cancellation/queue/unmount, product-image recovery, promo fallback, security retry, neutral check-in, and drag cancellation.
- Main-language tests check VI/PL keys and interpolation variables against EN. This is coverage validation, not a certification of translated wording or tax guidance.
- Existing autosave and sync-conflict tests are retained and run with the changed UI tests.
- Existing class/source assertions affected by the intentional primary color and localized weight badge are updated; test gates are not weakened or skipped in CI.
- Full local suite attempted. This Linux workspace lacks the Electron binary and restricts network-interface inspection. Windows-path-sensitive backup tests also fail here. Full Windows CI is needed; local full-suite success is not claimed.
- The design guard now uses a cleaned-up regular temporary file instead of Bash process substitution, making it runnable in this sandbox. Its dark-variant detector distinguishes utilities from object keys such as `dark: { ... }`. Existing unallowlisted small-text and Android color violations were fixed. The guard passes, and a negative probe confirms `dark:bg-white` is still rejected. The allowlist is unchanged.
- Foundation local validation: 240 targeted tests passed across 21 suites; the production build and design guard passed. Full Windows/Android CI results are linked in the PR. Visual screenshots cannot be supplied from this environment: the earlier browser connection was blocked and native Electron is unavailable. Keep the PR as a draft until Windows visual/hardware evidence is attached.

## Follow-up after the second review

- Payment and fiscal-choice surfaces now register with the shared dialog interaction hook. The fiscal choice owns focus/Tab and leaves the payment panel inert until a choice completes. Existing Escape, payment-idempotency and receipt-recovery guards remain covered.
- Table dragging rejects additional pointerdown events while a drag is active and rejects non-primary touches. The initial pointer remains responsible for save/cancel.
- Delayed Booksy Chrome-launch failures remain visible after switching into Booksy settings.
- Security start/stop/configuration operations show failures and pending state and reject overlapping operations. A reported start is also checked against engine status. Confirmed camera configuration changes only after successful IPC completion.
- Global security settings now use an explicit Save action with a retained draft and saved/unsaved status. Failed saves keep edits for retry. Camera Save All and global Save are serialized, and global drafts do not overwrite newer saved cameras. This does not change the backend security configuration contract.
- Retail category and customer catalog images use source-keyed fallback rendering. Missing or failed images preserve item names/prices; new/reintroduced sources get another attempt.
- Remaining white-on-brand-600 buttons in Booksy, product-camera capture and camera setup now use brand-700 with brand-800 hover.
- Follow-up local validation: production build (including renderer typecheck), design guard, and 135 targeted tests across 20 suites passed. New regression cases cover fiscal focus/Tab, second-finger interference, delayed Booksy errors, security failure/retry/concurrent saves, and catalog fallback. New commit CI is tracked in PR #2 separately from the earlier foundation run.
- Native Windows DPI/touch/scanner/printer and installer evidence, wider typography/layout work, and the BLIK merchant/receipt contract remain outstanding. This follow-up is not a production release.

## Required before broad release

1. Resolve the BLIK merchant/snapshot backend contract and remove fixed recipient values through a separately tested change.
2. Inspect POS, payment, shared/confirmation dialogs, check-in and sidebar on supported Windows sizes and 100/125/150% scaling. Record the effective CSS viewport.
3. Verify keyboard, barcode scanner, virtual keyboard, native titlebar, touch drag/cancel and hardware receipt recovery.
4. Complete the remaining layout/navigation/typography work from W06/W12 with actual before/after renders.
5. Run a cashier pilot and preserve the existing Android readiness gates. Do not publish via a release tag merely because builds pass.

## Rollback

The implementation changes renderer behavior, components, translations and tests. It does not migrate the database, change monetary calculations, alter payment recipients, or modify release gates. Revert this UI commit to restore its previous renderer behavior if required. The BLIK request is documentation only.
