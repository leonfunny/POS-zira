# POS Retail UI Redesign Context

Date: 2026-04-17
Baseline commit: `0b5fa94`
Scope: POS Retail tab first. This is a context handoff for a future Codex session.

## Current State

The repo is at the rollback baseline `0b5fa94`.

Fresh checks from the audit session:
- `git status --short` was clean.
- `npm run typecheck:renderer` passed.
- No project `DESIGN.md` existed at the time of audit.

Important: this audit was source-level. Existing screenshots in the repo were not POS UI screenshots, so the implementation session must run the app and capture real before/after screenshots.

## Skills And Direction

Use both skills, but with different jobs:
- `$design-md`: choose or create the project visual contract. For this Windows desktop POS app, start from an IBM-like operational light UI, not a marketing/e-commerce aesthetic.
- `$ui-ux-pro-max`: turn that direction into concrete screen structure, interaction states, accessibility, density, and React/Tailwind implementation guidance.

The `ui-ux-pro-max` query for generic "retail" drifted toward e-commerce/landing patterns. Reject that for this project. This is retail POS, not retail marketing.

Useful `ui-ux-pro-max` findings:
- Touch targets should be at least 44x44px.
- Adjacent touch targets need at least 8px spacing.
- Keyboard navigation must follow visual order.
- Long product lists may need virtualization later if product counts become large.

Recommended visual direction:
- Light operational UI.
- Neutral surfaces with restrained brand accents.
- Clear hierarchy, compact but not tiny controls.
- High-contrast status colors for online/offline, shift state, sync conflicts, stock warnings, and payment state.
- Avoid cinematic dark UI, neon gradients, decorative bento/landing patterns, and brand-heavy visual mood.

Candidate `design-md` preset:
- Default: `ibm`
- Alternative for a softer modern feel: `linear.app`
- Alternative for inventory/catalog-heavy screens: `airtable`

## POS Architecture Observed

Main POS shell:
- `src/renderer/components/pos/POSLayout.tsx`
- Shared header, scanner capture, language selector, shift open/close, online/offline status.
- Mode-specific templates: retail, salon, b2b, restaurant.

Retail flow:
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx`
- Left product area with search, category pills, product grid.
- Bottom quick action bar.
- Right cart sidebar.
- Payment and order history are modal-driven.

Shared Retail components:
- `src/renderer/components/pos/SearchBar.tsx`
- `src/renderer/components/pos/ProductGrid.tsx`
- `src/renderer/components/pos/ProductCard.tsx`
- `src/renderer/components/pos/Cart.tsx`
- `src/renderer/components/pos/CartItem.tsx`
- `src/renderer/components/pos/templates/retail/QuickActions.tsx`
- `src/renderer/components/pos/PaymentModal.tsx`
- `src/renderer/components/pos/OrderHistoryModal.tsx`
- `src/renderer/components/pos/SyncConflictBanner.tsx`

## Findings

### 1. The POS design system is split between light and dark fragments

Retail and Salon are mostly light UI. B2B and Restaurant contain dark slate sections. Shared `Cart` is white, so it clashes when embedded into dark B2B/Restaurant sidebars.

Examples:
- `src/renderer/components/pos/templates/b2b/B2BTemplate.tsx`
- `src/renderer/components/pos/templates/restaurant/RestaurantTemplate.tsx`
- `src/renderer/components/pos/Cart.tsx`

For the Retail redesign, do not redesign all modes. But establish a light operational direction so later modes can converge instead of becoming separate skins.

### 2. There are design-token problems

Observed issues:
- `bg-slate-850` is used but is not defined in `tailwind.config.js`.
- `var(--color-brand-500)` is used in Salon but that CSS variable is not defined.
- Tailwind `purple` is mapped to orange/brand values, which makes class names semantically misleading.
- Global CSS has warm sand/orange tokens and rounded `panel` styles that feel softer than a dense POS operations tool.

Do not perform a broad token refactor in the Retail pass unless the class directly affects Retail. Note the issue and keep changes focused.

### 3. Retail shell is structurally good

The current Retail layout is a reasonable POS foundation:
- Product discovery on the left.
- Current cart on the right.
- Payment CTA anchored in the cart.
- Quick actions at the bottom.

Keep this mental model. The redesign should improve hierarchy, density, touch safety, and consistency, not invent a brand-new navigation model.

### 4. Quick actions are too small for POS use

`QuickActions.tsx` uses many `text-xs` and `py-1.5` controls for actions like Hold, Recall, Discount, History, Customer Display, and promo toggle.

These are operational controls. They should be easier to hit, grouped by job, and should not compete visually with the Pay CTA.

### 5. Product grid is fixed to four columns

`ProductGrid.tsx` currently uses `grid-cols-4`.

For a Windows desktop POS, use stable responsive constraints such as `grid-template-columns: repeat(auto-fill, minmax(...))` or Tailwind arbitrary grid classes. Cards should not resize unpredictably, and product names/prices/add buttons must remain stable.

### 6. Product cards are functional but visually soft

`ProductCard.tsx` has good basics: fixed image ratio, stock/sale badges, anchored price/add button.

Improve:
- stronger clickable affordance for the whole card or add action
- clearer low-stock/sale status
- better no-image placeholder consistency
- min dimensions for touch reliability
- scan-friendly product name/price hierarchy

### 7. Cart and cart items are close, but need operational hierarchy

`Cart.tsx` and `CartItem.tsx` already support quantity, edit price, notes, totals, and pay state.

Improve:
- make item rows denser without shrinking controls below touch-safe size
- make remove/edit actions less visually noisy but discoverable
- make total/pay area stronger and more stable
- preserve shift-open warning and disabled payment behavior

### 8. Payment modal is too small for a critical workflow

`PaymentModal.tsx` is `max-w-md` with cash/card/BLIK/transfer/invoice, split payment, quick cash amounts, errors, and completion.

Do not fully redesign payment in the Retail shell pass unless necessary. If touched, keep behavior intact and avoid a massive rewrite. Payment deserves a separate pass.

### 9. Order history is too cramped for future growth

`OrderHistoryModal.tsx` is `max-w-lg` and includes filters, list, detail/refund/reprint flows.

Do not redesign it in the Retail shell pass. Later it should probably become a larger panel or full tab if refund/search/reporting grows.

### 10. Sync conflict banner bypasses the design system

`SyncConflictBanner.tsx` uses inline styles and raw colors. It should eventually be normalized into the POS status system.

Do not make it the main task in the Retail pass, but avoid making new UI that conflicts with it.

## Display On Future Scope

The current Retail quick action includes Customer Display / Display On controls. The current customer display experience is too salon/nail/hair-specific and is not suitable as the only display mode for restaurant or shop use.

Future plan from the user:
- Add two new display pages/views.
- Make Display On configurable by purpose/type.
- Add settings for what the customer display should show.

For the Retail redesign:
- Preserve the existing customer display toggle behavior.
- Do not redesign the customer display architecture yet.
- You may rename/group the Retail quick action visually if needed, but do not change backend behavior or add settings in this pass.

## Recommended First Implementation Slice

Do the Retail POS shell first:
- Create or use `DESIGN.md` with an operational light UI direction.
- Redesign Retail layout hierarchy.
- Improve product toolbar, category pills, product grid, product cards, quick actions, cart, and cart item rows.
- Keep behavior intact.
- Do not redesign PaymentModal or OrderHistoryModal beyond integration polish.
- Do not touch B2B/Restaurant/Salon except for shared components that Retail already uses.

## Paste Prompt For Next Codex Session

```text
Use $design-md and $ui-ux-pro-max.

We are starting a large POS UI/UX redesign, but the first implementation slice must be only the POS Retail sale flow in C:\print-agent-master.

Read this handoff first:
- docs/POS_RETAIL_UI_REDESIGN_CONTEXT.md

Baseline:
- Rollback commit is 0b5fa94.
- Do not reset or revert user changes.
- Do not touch server/main-process behavior unless required for type correctness.
- Keep business behavior intact.

Goal:
Redesign the Retail POS shell for Windows desktop cashier use. This is operational POS UI, not retail e-commerce, not a marketing dashboard, and not a dark cinematic AI UI.

Visual direction:
- Use an IBM-like operational light UI as the default direction.
- If DESIGN.md is missing, create one with a concise POS-specific design contract. You may use getdesign `ibm` as inspiration, but adapt it to POS needs instead of blindly copying brand style.
- Prefer neutral light surfaces, clear borders, restrained shadows, strong hierarchy, high contrast status colors, and compact but touch-safe controls.
- Minimum touch target for important controls: 44x44px.
- Adjacent touch controls need at least 8px spacing.
- Avoid neon gradients, landing-page bento patterns, decorative effects, and tiny text-only action chips for important operations.

Files to inspect before editing:
- src/renderer/components/pos/POSLayout.tsx
- src/renderer/components/pos/templates/retail/RetailTemplate.tsx
- src/renderer/components/pos/templates/retail/QuickActions.tsx
- src/renderer/components/pos/SearchBar.tsx
- src/renderer/components/pos/ProductGrid.tsx
- src/renderer/components/pos/ProductCard.tsx
- src/renderer/components/pos/Cart.tsx
- src/renderer/components/pos/CartItem.tsx
- src/renderer/components/pos/PaymentModal.tsx
- src/renderer/components/pos/OrderHistoryModal.tsx
- src/renderer/components/pos/SyncConflictBanner.tsx
- src/renderer/index.css
- tailwind.config.js

Scope:
1. Retail toolbar: search, category pills, scanner-friendly flow.
2. Product grid: replace fixed 4-column assumptions with stable responsive constraints; keep product cards scannable.
3. Product cards: improve hierarchy, status badges, add affordance, no-image state, and touch reliability.
4. Quick actions: make Hold, Recall, Discount, History, Customer Display controls POS-grade, better grouped, and less tiny.
5. Cart sidebar: improve item row density, quantity/edit affordances, totals/pay section, and disabled/shift warning states.
6. Preserve existing behavior: scanner capture, search, category filtering, add to cart, hold/recall, discount, customer display toggle, payment modal opening, order history opening.

Out of scope:
- Do not redesign all POS modes.
- Do not redesign B2B, Restaurant, or Salon templates except where a shared component must remain compatible.
- Do not redesign PaymentModal deeply; only adjust integration if necessary.
- Do not redesign OrderHistoryModal deeply; only adjust integration if necessary.
- Do not implement the future Customer Display / Display On architecture yet. Preserve the current toggle behavior. The future plan is to add configurable display pages later.
- Do not add new server APIs or change backend contracts.
- Do not do broad unrelated refactors.

Before coding:
- State a concise design plan and success criteria.
- Call out any assumptions.

Implementation constraints:
- Use React + Tailwind patterns already in the project.
- Prefer surgical edits to the listed files.
- Keep TypeScript types intact.
- Avoid new dependencies unless there is a strong reason.
- Keep text from overflowing in buttons/cards in PL/VI/EN-like longer labels.
- Preserve accessibility labels and improve focus states where practical.

Verification:
- Run npm run typecheck:renderer.
- Start the app or renderer if practical and capture screenshots of the Retail POS flow before/after.
- Check at least 1280x720 and a wider desktop viewport if possible.
- Verify no obvious overlap, clipped button text, unusable small controls, or broken cart/payment entry behavior.

Deliver:
- Summary of changed files.
- What visual/UX problems were fixed.
- Any remaining risks or next recommended slice.
```
