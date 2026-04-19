# Display On Flow Audit

Date: 2026-04-19

Status: audit/spec only. No production code changes are included in this session.

## Summary

Display On is currently a customer-facing second window, not a retail self-checkout kiosk. It can show idle/promo content, the POS cart, a thank-you screen, and salon-oriented check-in/service-browsing flows. The problem is that those flows are selected through implicit salon heuristics instead of an explicit display profile. That is brittle and unsafe for retail, restaurant, and shop installs.

The smallest sane next slice is to add an explicit customer display profile setting and implement a read-only `retail_assisted` display first. Full self-checkout should stay out of scope until scanner, payment, fiscal/receipt, staff-assist, blocked-item, and unavailable-state requirements are specified.

Recommended live profile names:

| Profile | User-facing label | Purpose |
| --- | --- | --- |
| `retail_assisted` | Retail assisted customer display | Cashier runs the sale; customer sees cart, total, payment status, thank-you, and promo/idle. |
| `salon_checkin` | Salon check-in | Existing booking lookup, phone lookup, walk-in check-in, service browse, and upsell flow. |
| `promo_only` | Promo only | Passive second screen for promos/brand/closed state, with no cart or customer action surface. |

Reserved profile names, not recommended for the first slice:

| Profile | User-facing label | Why it should not ship first |
| --- | --- | --- |
| `retail_self_checkout` | Retail self-checkout kiosk | Requires customer-controlled cart, payment, staff assistance, item exceptions, anti-tamper, and device/error handling. |
| `restaurant_table_display` | Restaurant customer/table display | Needs table/order context, course/grouping rules, service charge/tip decisions, and restaurant-specific payment states. |

## Audited Files

- `src/main/pos/pos-store.ts`
- `src/main/modules/pos.module.ts`
- `src/main/windows/window-manager.ts`
- `src/preload/preload-display.ts`
- `src/renderer/windows/customer/CustomerApp.tsx`
- `src/renderer/windows/customer/customer-display-model.ts`
- `src/renderer/windows/customer/views/IdleView.tsx`
- `src/renderer/windows/customer/views/PromoView.tsx`
- `src/renderer/windows/customer/views/CartView.tsx`
- `src/renderer/windows/customer/views/CheckInView.tsx`
- `src/renderer/windows/customer/views/SalonInteractiveView.tsx`
- `src/renderer/windows/customer/components/CustomerDisplayShell.tsx`
- `src/renderer/windows/customer/components/CustomerDisplayPrimitives.tsx`
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx`
- `src/renderer/components/pos/templates/retail/QuickActions.tsx`
- `src/renderer/components/pos/PaymentModal.tsx`
- `src/renderer/components/Settings.tsx`
- `src/renderer/hooks/usePosStore.ts`
- `src/shared/types.ts`
- `src/main/config/store.ts`
- `docs/CUSTOMER_DISPLAY_API_SPEC.md`
- `DESIGN.md`

## Current Flow

```mermaid
stateDiagram-v2
  [*] --> NoCartIdle: PosStore initial display.mode = idle

  NoCartIdle: no cart / idle
  Promo: promo carousel
  CartHasItems: cart has items
  PaymentInProgress: payment in progress
  ThankYou: thank you
  CheckIn: salon check-in hub
  Interactive: salon service browsing

  NoCartIdle --> Promo: idle timeout and promo images exist
  NoCartIdle --> NoCartIdle: idle timeout and no promo images
  Promo --> Promo: carousel interval

  NoCartIdle --> CheckIn: customer touch and salonName or serviceCategories exist
  Promo --> CheckIn: customer touch and salonName or serviceCategories exist
  NoCartIdle --> Interactive: customer touch with no salon data
  Promo --> Interactive: customer touch with no salon data

  CheckIn --> Interactive: browse services
  Interactive --> CheckIn: back to check-in
  CheckIn --> Promo: interaction timeout or home/back
  CheckIn --> NoCartIdle: interaction timeout or home/back with no promos
  Interactive --> Promo: interaction timeout or home/back
  Interactive --> NoCartIdle: interaction timeout or home/back with no promos

  NoCartIdle --> CartHasItems: cashier adds item
  Promo --> CartHasItems: cashier adds item
  CartHasItems --> CartHasItems: add/remove/update while items remain
  CartHasItems --> NoCartIdle: cart emptied

  CheckIn --> CheckIn: cashier adds item; current code preserves check-in mode
  Interactive --> Interactive: cashier adds item; current code preserves interactive mode

  CartHasItems --> PaymentInProgress: cashier opens payment and terminal sends status
  PaymentInProgress --> CartHasItems: payment fails or is cancelled
  PaymentInProgress --> ThankYou: payment completes
  CartHasItems --> ThankYou: non-card payment completes

  ThankYou --> Promo: 8s timer and promo images exist
  ThankYou --> NoCartIdle: 8s timer and no promo images
```

### Current State Notes

- `DisplayState.mode` is only `cart | idle | thankyou | promo | interactive | checkin`. There is no first-class `payment` mode; payment progress is a `paymentStatus` string overlaid on `cart`.
- `cart/addItem` forces the display to `cart` unless the current mode is `checkin` or `interactive`.
- `cart/removeItem`, `cart/updateQuantity`, and `cart/clear` return the display to `idle` when the cart becomes empty.
- `PaymentModal` sets `display.mode = thankyou` and then clears the cart after successful payment.
- `PosStore.handleDisplayTransitions` moves `thankyou` to promo/idle after 8 seconds.
- `PosStore.resetIdleTimer` starts the idle-to-promo timer only when mode is `idle` or cart mode has an empty cart.
- `CustomerApp` routes `idle`, `promo`, `checkin`, `interactive`, `cart`, and `thankyou` directly to view components.
- `WindowManager` already treats the customer display as kiosk-capable: separate monitor selection, fullscreen/kiosk, heartbeat, blocked shortcuts, escape close, and hidden staff close gesture.

## Salon Bias And Retail Risk

The current behavior is salon-biased in ways that are not just cosmetic.

1. Touching idle or promo routes through salon logic.

   `display:touch` calls `PosStore.handleTouch`, which loads product categories into `serviceCategories` and then chooses `checkin` when either `salonName` or categories exist. In practice, most retail installs have a configured business name and product categories, so a customer touching the screen can land in a salon check-in flow.

2. Product categories are treated as service categories.

   `loadServiceCategories` maps all local product categories/products into `serviceCategories`, with fields like `duration`. That makes sense for salon services, but it is wrong for normal retail products, grocery items, restaurant menu items, or shop inventory.

3. Customer actions can mutate operational state.

   `display:check-in` persists a check-in, can print a check-in confirmation, notifies the POS window, and can add upsells to the active cart. That is acceptable for a salon check-in profile, but unsafe if accidentally exposed in retail or restaurant mode.

4. Payment state is too weak for kiosk semantics.

   The display has a raw `paymentStatus` string, not a payment state model. It does not know method, amount due, amount paid, remaining amount, cancellation, retry, BLIK code state, terminal unavailable, or staff intervention state. That is enough for assisted display messaging, not for self-checkout.

5. Retail copy and states are missing.

   Current customer copy says things like "Touch to explore our services", "Complete your look", "Add to my visit", and "Book your next visit". Retail references like Zabka/Biedronka/Carrefour need different concepts: scan/touch product to start, card-only/cash-card notice, large total, scan prompt, pay status, language selector, and closed/out-of-service state such as "Kasa zamknieta".

6. Cart rendering contains salon assumptions.

   `CartView` shows `staffName`, service upsells, and a nail emoji fallback. It also hardcodes PLN formatting in places. Retail assisted can reuse some cart concepts, but should not inherit salon upsell language or decorative fallback assets.

7. Idle/promo metadata is not stable.

   `transitionToPromoOrIdle` replaces the whole `display` object with only promo or idle fields. That can drop metadata like `salonName`, `bookingUrl`, service data, customer requests, and payment status. That replacement is fragile once multiple display profiles exist.

8. The current shell conflicts with the retail design contract.

   `CustomerDisplayShell` and older idle/cart surfaces use soft gradients, decorative blobs, high radii, and beauty-oriented warmth. `DESIGN.md` explicitly calls for an IBM-like operational light interface, stable layout, neutral surfaces, restrained shadows, and no decorative blobs. Customer-facing retail screens can be warmer and larger than cashier UI, but they should not be a decorative salon shell.

9. No closed/out-of-service model exists.

   Kiosk-like presentation exists at the window level, but the display app has no explicit unavailable state, no staff-assistance call state, and no safe "display closed" customer-facing message. That matters for self-checkout and still matters for retail assisted displays on a public second monitor.

## Proposed Profile Model

### `retail_assisted`

Cashier-controlled customer display. This is not self-checkout.

Required UX:

- Idle/start: clear brand/store name, assisted-service copy such as "Staff will scan your items" and "Your items will appear here", language selector, and payment availability notice such as "Cash/card" or "Card only" if configured.
- Cart: item list, quantities, discounts, large total, assisted-service prompt such as "Staff will continue adding your items" or "Staff will take payment when ready", and no customer remove/pay controls.
- Payment: amount due, staff/terminal status, card/BLIK/cash wording if POS exposes it, and clear waiting/success/failure states.
- Thank-you: total paid, optional receipt/loyalty/booking QR only when appropriate for the business profile.
- Closed/out-of-service: documented future/safe-state requirement unless it fits naturally without expanding the first slice; when added, it must show an explicit unavailable state with language selector and staff-facing escape still available.
- Accessibility: 44px minimum touch targets for any customer controls, high contrast, stable layout at 1280x720 and 1600x900.

Non-requirements:

- Customer-controlled product add/remove.
- Customer pay button.
- Staff assistance workflow.
- Age/weight/security exceptions.

### `retail_self_checkout`

Customer-operated kiosk. This is a separate product surface, not a variant of the current display.

Required UX:

- Start: scan/touch product to start, language selector, card-only/cash-card notice, unavailable state.
- Cart: customer item list, add/scan prompt, remove/quantity controls where allowed, large total, pay button.
- Payment: card/BLIK/cash options if supported, amount due, remaining amount, retries, terminal states, receipt choice.
- Exceptions: staff assistance for age-restricted products, unknown barcode, voids, coupons, scale/weight mismatch, payment failure, and hardware failure.
- Operations: staff override, attendant mode, fraud/anti-tamper, fiscal receipt handling, and kiosk health monitoring.

This should remain out of scope for the first Display On slice.

### `restaurant_table_display`

Customer/table-facing display for restaurant POS.

Required UX:

- Idle/table: restaurant/table identity, server/table number if available, language selector if customer-facing.
- Cart/order: grouped items by course or seat if supported, modifiers/notes only if customer-safe, subtotal/tax/service charge/tip/total.
- Payment: "staff is processing payment" or table payment states when implemented.
- Thank-you: table/order confirmation and receipt prompt if appropriate.
- Closed/out-of-service: table/display unavailable state.

This needs restaurant-specific order context before implementation. The current cart model has `course`, but the customer display does not render restaurant semantics.

### `salon_checkin`

Existing salon customer check-in and service browsing profile.

Required UX:

- Idle/promo touch enters check-in, not retail cart controls.
- Booking lookup, phone lookup, walk-in name entry, service selection, upsells, confirmation receipt, language selector.
- Service browsing can hand off to check-in and notify staff.
- Inactivity returns to promo/idle.
- POS cart updates should not interrupt an active customer check-in unless a future explicit handoff requires it.

Implementation note: this profile should preserve current behavior, but it should be selected explicitly instead of inferred from `salonName` or local categories.

### `promo_only`

Passive customer-facing display.

Required UX:

- Promo carousel and/or idle brand screen.
- Optional closed/out-of-service message.
- Optional language selector only if idle copy is localized.
- No cart, no check-in, no service browse, no customer actions that mutate POS state.

First-slice definition: promo-only suppresses cart entirely. Use `retail_assisted` when cart display is desired.

## Approaches Considered

### Recommended: explicit profile router, retail assisted first

Add a profile setting, route customer display behavior through it, and build the `retail_assisted` screen as a read-only display. Keep existing salon flow behind `salon_checkin`.

Why this is best:

- Smallest change that fixes the actual risk.
- Easy to review and roll back.
- Does not pretend self-checkout exists.
- Preserves existing salon value.
- Creates a stable place for restaurant and self-checkout later.

Tradeoff:

- Some profile names are documented before their screens exist. Do not expose unimplemented profiles as selectable UI options unless they render a safe unavailable state.

### Alternative: infer behavior from `posMode`

Use `posMode` to decide display behavior without adding a profile setting.

Why it is weaker:

- It hides an operational decision inside a POS mode.
- Real businesses can want retail POS with promo-only display, salon POS with no customer check-in, or restaurant POS with a passive display.
- It repeats the current mistake: behavior depends on indirect signals.

This can be used only as a migration default, not as the long-term model.

### Bad first slice: build full self-checkout

Jump straight to a Zabka/Biedronka/Carrefour-like self-checkout.

Why this is a bad idea now:

- The current app has no customer-owned cart flow.
- Payment is cashier-owned and modal-driven.
- Staff assistance, blocked items, fiscal device behavior, unavailable state, and hardware errors are unspecified.
- It would mix new kiosk logic with existing salon display code, making regressions likely.

Self-checkout should start only after a separate product spec is accepted.

## Smallest First Implementation Slice

Implement `retail_assisted` and profile routing only.

Recommended scope:

1. Add `customerDisplayProfile` to config/types with values:
   - Live in first slice: `retail_assisted`, `salon_checkin`, `promo_only`.
   - Reserved in this audit only: `retail_self_checkout`, `restaurant_table_display`. Do not expose them in Settings until they render real, safe screens.
2. Add a Settings control for "Customer display profile".
3. Pick migration/default behavior conservatively:
   - If `customerDisplayProfile` is unset and `posMode === 'salon'`, use `salon_checkin`.
   - If unset and `posMode === 'retail'` or `posMode === 'b2b'`, use `retail_assisted`.
   - If unset and `posMode === 'restaurant'`, use `retail_assisted` temporarily as a read-only cart/total display; do not show table-specific claims until `restaurant_table_display` exists.
4. In `CustomerApp`, route by profile before routing by mode.
5. For `retail_assisted`, render:
   - Retail idle/promo-safe screen.
   - Retail cart screen.
   - Retail payment status overlay/screen using existing `cart` plus `display.paymentStatus`.
   - Retail thank-you screen.
6. Disable touch-to-check-in for `retail_assisted` and `promo_only`.
7. Keep current check-in/interactive flow only for `salon_checkin`.
8. Preserve current QuickActions "Display On" and "Ads" behavior unless a profile-specific issue is found during implementation.

Rollback plan:

- The slice should be reversible by switching profile back to `salon_checkin` or by removing the new profile branch.
- Avoid changing payment creation, order persistence, printer behavior, cart math, or kiosk window behavior in the first slice.

## Files Likely Touched In The First Slice

Likely required:

- `src/shared/types.ts` - add `customerDisplayProfile` type.
- `src/main/config/store.ts` - add config schema/default.
- `src/renderer/components/Settings.tsx` - profile selector.
- `src/renderer/i18n/translations.ts` - profile labels and retail display copy.
- `src/renderer/hooks/usePosStore.ts` - display/profile typing if the profile is carried in state.
- `src/main/pos/pos-store.ts` - route `handleTouch`, preserve display metadata, and avoid salon transition for retail/profile-only modes.
- `src/renderer/windows/customer/CustomerApp.tsx` - profile-aware rendering.
- `src/renderer/windows/customer/customer-display-model.ts` - profile resolver/helper if shared between views.
- `src/renderer/windows/customer/views/CartView.tsx` or new retail-specific view - avoid salon copy in retail.
- `src/renderer/windows/customer/views/IdleView.tsx` or new retail-specific view - retail idle/start requirements.
- `src/renderer/windows/customer/views/ThankYouView.tsx` or new retail-specific view - profile-safe thank-you.

Maybe touched:

- `src/preload/preload-display.ts` - only if the profile needs a new safe IPC surface.
- `src/main/modules/pos.module.ts` - only if payment status needs structured data rather than raw string.
- `src/renderer/components/pos/templates/retail/QuickActions.tsx` - only if "Ads" needs profile-specific wording or safe behavior.
- `docs/CUSTOMER_DISPLAY_API_SPEC.md` - later, if server-driven display content needs profile-specific API fields.

Do not touch in the first slice unless a test proves it is necessary:

- Payment order creation.
- Receipt printing.
- Cash drawer behavior.
- Window kiosk/monitor management.
- Product database schema.
- Booksy/check-in persistence logic.

## Explicit Out Of Scope

- Full self-checkout.
- Customer-controlled add/remove/quantity cart editing.
- Customer pay button.
- BLIK code entry on customer display.
- Cash handling on customer display.
- Staff assistance/service-call workflow for self-checkout.
- Age-restricted item handling.
- Scale/weight/item security handling.
- Coupon/loyalty/fiscal receipt redesign.
- Server-side API changes.
- Restaurant table display implementation.
- Broad visual redesign of existing salon check-in.
- Replacing kiosk/window-management behavior.

## UX Requirements By Profile

| Requirement | retail_assisted | retail_self_checkout | restaurant_table_display | salon_checkin | promo_only |
| --- | --- | --- | --- | --- | --- |
| Customer can mutate cart | No | Yes | No, unless future table ordering | Check-in upsells only | No |
| Shows POS cart | Yes | Yes | Yes, table-aware | Only if cashier flow takes over | No by default |
| Shows payment state | Assisted status only | Full payment flow | Assisted/table payment status | Optional assisted status | No |
| Shows language selector | Idle/cart/payment if interactive copy exists | Always | Optional/likely | Existing shell | Optional |
| Shows promo/idle | Yes | Yes | Yes | Yes | Yes |
| Supports closed/out-of-service | Future/safe-state requirement | Required | Required | Future/safe-state requirement | Future/safe-state requirement |
| Touch starts check-in | No | No | No | Yes | No |
| Touch starts self-checkout | No | Yes | No | No | No |
| Staff assistance | Not in first slice | Required | Future | Existing staff notification for services | No |

## Retail Assisted Screen Requirements

The first retail screen should use `DESIGN.md` as the visual contract:

- Light neutral canvas.
- White/light gray panels with 1px neutral borders.
- 6-8px radius.
- Subtle shadows only.
- Segoe/Bahnschrift stack.
- Stable dimensions for item list, totals, and status areas.
- No decorative blobs, heavy gradients, emoji icons, glassmorphism, or salon/beauty imagery.

Minimum views:

1. No cart
   - Store/brand name.
   - Large prompt: "Staff will scan your items" or "Your items will appear here".
   - Payment availability notice if known.
   - Language control if language is customer-selectable.
   - Optional promo fallback when images are configured.

2. Cart has items
   - Dense but distance-readable item list.
   - Quantity and line totals.
   - Discount line when present.
   - Large total.
   - Secondary prompt: "Staff will continue adding your items" or "Staff will take payment when ready".
   - No remove/pay buttons.

3. Payment in progress
   - Amount due or total.
   - Status: waiting for terminal, processing, approved, declined, cash received/change if exposed.
   - Do not show fake BLIK/card buttons until the display owns those actions.

4. Thank you
   - Clear success state.
   - Total paid if available.
   - Short return-to-idle timer.
   - Optional QR only if relevant to the selected business profile.

5. Closed/out-of-service future/safe-state
   - Explicit "Display unavailable" / localized "Kasa zamknieta" style message.
   - No ambiguous blank screen.
   - Language selector remains reachable.
   - Do not force this into the first slice if it expands routing, settings, or test scope beyond profile selection and retail-assisted display.

## Verification Plan

Automated/static checks:

- Run `npm run build`.
- Confirm `git diff` contains only the intended profile/display files for the implementation slice.
- Confirm no payment, order persistence, printer, or cash drawer behavior changed.

Manual/customer-window checks:

1. Configure `customerDisplayProfile = retail_assisted`.
2. Open Display On from Retail POS.
3. Capture screenshots at 1280x720 and 1600x900 for:
   - No cart / idle.
   - Cart with at least three items, quantity > 1, and a discount.
   - Payment in progress/status visible.
   - Thank-you.
   - Closed/out-of-service if implemented in the slice.
4. Touch/click the idle retail display and verify it does not enter check-in or service browsing.
5. Add an item while the display is idle/promo and verify it enters retail cart.
6. Empty the cart and verify it returns to retail idle/promo.
7. Complete a payment and verify thank-you appears, then returns to retail idle/promo after the configured timer.
8. Switch profile to `salon_checkin` and verify existing check-in, phone lookup, walk-in, browse services, upsell, and confirmation paths still render.
9. Switch profile to `promo_only` and verify cart/check-in actions are suppressed or safely unavailable according to the implemented definition.

Screenshot naming suggestion:

- `docs/screenshots/display-on-retail-assisted-idle-1280x720.png`
- `docs/screenshots/display-on-retail-assisted-cart-1280x720.png`
- `docs/screenshots/display-on-retail-assisted-payment-1280x720.png`
- `docs/screenshots/display-on-retail-assisted-thankyou-1280x720.png`
- Repeat the same states with `1600x900`.

## Acceptance Criteria For The Next Coding Slice

- `customerDisplayProfile` exists and is visible in Settings.
- Retail installs no longer route customer touch into salon check-in/service browsing.
- `retail_assisted` clearly reads as a customer-facing display, not self-checkout.
- Existing salon check-in remains available under `salon_checkin`.
- The diff is small enough to review and rollback.
- Screenshots at 1280x720 and 1600x900 show stable, non-overlapping layouts.
