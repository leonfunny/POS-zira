# Self-Checkout Frontend PR Notes

Date: 2026-05-20
Scope: customer-facing self-checkout frontend, operator readiness display, kiosk preload contract, QA notes.

## PR Summary

This PR refactors the customer self-checkout into a modern hybrid kiosk flow. Barcode scan remains the fastest path for grocery items, while the customer can also browse a menu for kitchen/no-barcode products. The cart and total stay visible, assisted demo payment is separated from unattended production behavior, production mode fails closed until backend/hardware readiness contracts exist, and receipt/finalizing no longer completes the session when fiscal printing fails.

The operator tab now reads payment readiness from the same runtime model as the kiosk. Fake payment no longer makes the production payment pill look ready.

## Customer UX Changes

- Welcome and shopping support scan-first plus menu fallback.
- Kitchen menu products can be added without a barcode.
- Sold-out and no-price products are disabled with clear badges.
- Search no-result state offers recovery actions: keep scanning or call staff.
- Cart rows, total, and pay CTA remain visible in compact POS2 layout.
- Scan prompt becomes compact after the cart has an item, preventing menu tiles from being clipped.
- Receipt screen shows explicit finalizing steps: payment confirmed, order saved, fiscal receipt, receipt pickup.
- Receipt print failure locks the flow to staff assistance instead of offering a continue/thank-you path.
- Production unavailable screen keeps Call staff visible in the header.

## Production Boundary

Unattended production checkout is intentionally blocked in this frontend PR. The client now fails closed for:

- `no_terminal`
- `no_fiscal_printer`
- `order_creation_unverified`

Production unattended payment should not be implemented as a client-only workaround. It needs the server/main-process contracts documented in `docs/server-change-requests/2026-05-20-self-checkout-production-readiness.md`.

## Files To Include In This PR

Core self-checkout:

- `src/preload/preload-self-checkout.ts`
- `src/main/windows/window-manager.ts`
- `src/shared/electron.d.ts`
- `src/renderer/components/SelfCheckoutTab.tsx`
- `src/renderer/windows/self-checkout/SelfCheckoutApp.tsx`
- `src/renderer/windows/self-checkout/i18n.ts`
- `src/renderer/windows/self-checkout/self-checkout-model.ts`
- `src/renderer/windows/self-checkout/types.ts`
- `src/renderer/windows/self-checkout/catalog-model.ts`
- `src/renderer/windows/self-checkout/useScannerCapture.ts`
- `src/renderer/windows/self-checkout/components/`
- `src/renderer/windows/self-checkout/screens/PaymentScreen.tsx`
- `src/renderer/windows/self-checkout/screens/ReceiptScreen.tsx`
- `src/renderer/windows/self-checkout/screens/ScanScreen.tsx`
- `src/renderer/windows/self-checkout/screens/UnavailableScreen.tsx`
- `src/renderer/windows/self-checkout/screens/WelcomeScreen.tsx`

Docs:

- `docs/SELF_CHECKOUT_FRONTEND_UX_RESEARCH_2026.md`
- `docs/SELF_CHECKOUT_CUSTOMER_REFACTOR_PLAN_2026.md`
- `docs/SELF_CHECKOUT_DESIGN_BRIEF.md`
- `docs/server-change-requests/2026-05-20-self-checkout-production-readiness.md`
- `docs/SELF_CHECKOUT_FRONTEND_PR_NOTES_2026-05-20.md`

Tests:

- `tests/e2e/self-checkout-prd-smoke.mjs`
- `tests/ipc-contracts.test.ts`
- `tests/self-checkout-catalog-model.test.ts`
- `tests/self-checkout-model.test.ts`
- `tests/self-checkout-tab-i18n.test.ts`
- `tests/self-checkout-receipt-screen.test.ts`

## Do Not Include In This PR Unless Separately Intended

The current worktree also contains unrelated changes for product/admin, warehouse, forecast, printer routing, settings, database modules, and other tests. Keep those out of the self-checkout PR unless they are intentionally part of a separate changeset.

Examples of unrelated areas currently dirty:

- `src/renderer/components/products/`
- `src/renderer/components/warehouse/`
- `src/renderer/components/forecast/`
- `src/main/forecast/`
- `src/main/modules/warehouse.module.ts`
- `src/main/modules/forecast.module.ts`
- product/warehouse/forecast docs and tests

## Verification Run

Automated checks:

```powershell
npm test -- --run tests/self-checkout-catalog-model.test.ts tests/self-checkout-model.test.ts tests/self-checkout-tab-i18n.test.ts tests/self-checkout-receipt-screen.test.ts tests/self-checkout-build-sale.test.ts tests/scanner-routing-prd.test.ts tests/ipc-contracts.test.ts
node tests/e2e/self-checkout-prd-smoke.mjs
npm run build
git diff --check
```

Latest results:

- Unit/contract self-checkout set: 235 tests passed.
- PRD smoke: passed.
- Production build: passed.
- Diff whitespace check: passed, with CRLF warnings only.
- Vite warning remains: `main` chunk is larger than 500 kB after minification. This is not caused by this PR scope.

## Visual QA

Visual QA screenshots were generated here:

`C:\Users\pc\AppData\Local\Temp\zira-self-checkout-qa-1779302369338`

Checked screens:

- `menu-cart-1280x800.png`
- `payment-1280x800.png`
- `receipt-1280x800.png`
- `compact-cart-1280x720.png`
- `compact-payment-1280x720.png`
- `production-closed-1280x800.png`

Visual QA assertions passed:

- No horizontal overflow.
- No vertical overflow.
- No visible control clipped outside viewport.
- Compact cart keeps at least three cart rows visible.
- Production closed screen keeps Call staff visible.

## Suggested Commit Message

```text
feat: modernize self-checkout customer kiosk
```

## PR Test Plan Text

```text
Tested with:
- npm test -- --run tests/self-checkout-catalog-model.test.ts tests/self-checkout-model.test.ts tests/self-checkout-tab-i18n.test.ts tests/self-checkout-receipt-screen.test.ts tests/self-checkout-build-sale.test.ts tests/scanner-routing-prd.test.ts tests/ipc-contracts.test.ts
- node tests/e2e/self-checkout-prd-smoke.mjs
- npm run build
- git diff --check

Manual/visual QA:
- 1280x800 menu/cart, payment, receipt, production closed
- 1280x720 compact cart and payment
- no overflow or clipped controls
- production mode fail-closed with terminal, fiscal printer, and order readiness blockers
```
