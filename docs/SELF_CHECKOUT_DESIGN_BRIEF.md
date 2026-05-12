# Self-Checkout Design Brief

Status: brainstorming draft
Owner surface: POS > Self-Checkout tab, plus customer-facing kiosk window
Design base: project `DESIGN.md` using an IBM-like operational light interface, adapted for customer kiosk use

## 1. Design Decision

Use a serious retail-kiosk direction, not a marketing/product-page direction.

Reference hierarchy:
- First: real Polish self-checkout structure, especially Zabka for shopping layout.
- Second: project `DESIGN.md` for operational clarity and restrained UI.
- Third: `ui-ux-pro-max` for accessibility, touch target, error recovery, and anti-pattern checks.

Do not blindly accept generated design-system output. For this kiosk, `ui-ux-pro-max --design-system` suggested a "Feature-Rich Showcase" and "Vibrant & Block-based" style. That is a false positive for this product. It fits a landing page, not a production checkout kiosk.

The design direction is:
- operational, not decorative
- touch-first, not mouse-first
- scanner-first, not browsing-first
- high contrast, not subtle SaaS gray-on-gray
- warm Zira accent, not orange everywhere
- customer-simple, operator-diagnostic

## 2. Product Goal

Self-checkout must feel like a real retail kiosk, not a developer demo.

The hard goal: a customer can walk up, understand the machine in under 3 seconds, scan items, review the cart, pay, receive fiscal/receipt feedback, and leave without staff help unless something exceptional happens.

Borrow from proven flows:
- Zabka: open/welcome clarity, category fallback, cart panel, large checkout CTA.
- Lewiatan: scan-first discipline, minimal payment choice, low cognitive load.
- Carrefour: explicit closed/unavailable state.

## 3. Non-Goals

Do not turn this into a marketing page.

Do not expose operator configuration to the customer.

Do not make the customer choose settings before shopping.

Do not hide production blockers behind optimistic UI. If payment terminal, fiscal printer, or order creation is missing, production mode must show closed/unavailable.

Do not copy Zabka visually one-to-one. The structure is worth copying; the brand system must stay Zira.

Do not add a new design framework just because a design skill mentions it. No shadcn/Tailwind migration for this slice.

## 4. Branding Direction

Zira self-checkout should feel:
- trustworthy
- fast
- local retail friendly
- clean but not sterile
- Polish-market aware
- modern enough, but not startup-ish

It should not feel:
- like a SaaS dashboard
- like a crypto/payment startup
- like a decorative landing page
- like a raw Electron prototype
- like a supermarket ad screen with checkout hidden inside it

Brand voice:
- short commands
- direct verbs
- no developer language
- no feature explanations on customer screens
- blockers shown only to operators

Example tone:
- Good: "Zeskanuj produkt"
- Good: "Rozpocznij zakupy"
- Good: "Przejdz do podsumowania"
- Good: "Kasa chwilowo nieczynna"
- Bad: "Payment SDK is mocked"
- Bad: "Settings below auto-save and apply on next launch"
- Bad: "MVP limitation"

## 5. Color System

Use the existing Zira accent as the brand anchor, but keep it under control. The primary color should guide action, not flood the kiosk.

Recommended palette:

| Token | Hex | Role |
| --- | --- | --- |
| `--sc-canvas` | `#F7F8F6` | Main kiosk background. Neutral, light, not beige-heavy. |
| `--sc-surface` | `#FFFFFF` | Cart, summary, settings, payment panels. |
| `--sc-surface-muted` | `#EEF1EE` | Secondary bands, category zone, inactive surfaces. |
| `--sc-border` | `#D8DED6` | Panel/control borders. |
| `--sc-ink` | `#202421` | Primary text, totals, commands. |
| `--sc-muted` | `#687069` | Helper text, secondary labels. |
| `--sc-primary` | `#DA7756` | Zira primary CTA and selected states. Existing app primary. |
| `--sc-primary-hover` | `#C5684A` | Pressed/hover primary. Existing app primary-hover. |
| `--sc-primary-deep` | `#A9533A` | Strong brand text, focus ring, active state. Existing app primary-deep. |
| `--sc-primary-soft` | `#FBE8DF` | Subtle brand background, never as full-page wash. |
| `--sc-success` | `#15803D` | Open, paid, ready, item added. |
| `--sc-info` | `#2563EB` | Scanner/terminal guidance, not primary CTA. |
| `--sc-warning` | `#B7791F` | Demo mode, bag option, retry warnings. |
| `--sc-danger` | `#B42318` | Closed, error, staff lock, payment failure. |

Rules:
- Customer primary CTA uses `--sc-primary` or `--sc-success`, depending on context.
- Checkout/pay can use green when the action means "continue transaction"; brand orange stays for start/selection.
- Danger must be visually and textually explicit. Do not rely on red alone.
- Do not use blue as the main brand color just because the search tool suggested it.
- Do not use gradients as the primary identity. At most, use a very subtle top band in the welcome screen.
- Keep primary/accent color below roughly 10-15% of the visible customer screen.

## 6. Typography

Keep the app's existing system stack. Do not add Google Fonts for this slice.

Customer kiosk:
- command text: 32-48px depending on screen
- body/help text: 18-22px
- cart item name: 20-24px
- quantity/price: tabular numbers
- total amount: 44-64px
- buttons: 20-26px, semibold

Operator tab:
- title: 24-30px
- section heading: 14-16px semibold
- body/help text: 12-14px
- controls: compact but at least 44px high

Rules:
- Do not scale font size directly with viewport width.
- Use tabular figures for prices and timers.
- Prefer wrapping over truncation for product names in customer cart.
- Avoid tiny legal/help text on customer screens.

## 7. Two Different Interfaces

### Operator Self-Checkout Tab

This is for cashier/admin diagnostics and launch.

Purpose:
- show kiosk readiness
- choose demo vs production
- choose customer display monitor
- set default language, bag fee, idle timeout
- launch kiosk window
- explain blockers in plain operational language

Visual direction:
- compact, calm, admin-like
- status/readiness first
- launch action visible but not theatrical
- configuration below, grouped by operational meaning
- blockers shown as a serious readiness panel, not a footnote

Layout:
- top row: title, mode badge, last readiness state
- readiness band: demo available, production blocked, hardware missing
- launch panel: one primary launch action
- settings grid: language, bag fee, display, timeout
- dependency panel: payment terminal, fiscal printer, order creation

This tab should not look like the customer kiosk.

### Customer Kiosk Window

This is for the shopper.

Purpose:
- start shopping
- scan products
- recover via category buttons if scanning fails
- review basket
- choose bag option
- pay
- show fiscal/receipt progress
- thank the customer and reset

Visual direction:
- larger typography
- stronger action hierarchy
- high contrast
- stable panels
- touch-safe controls
- minimal copy

This screen should feel like a kiosk storefront, not an admin dashboard.

## 8. State Model

The customer kiosk should keep this exact high-level state model:

1. `unavailable`
   - Used when production dependencies are missing, kiosk is closed, printer/payment is unavailable, or staff disabled the terminal.
   - Primary message: checkout closed/unavailable.
   - No shopping CTA.

2. `welcome`
   - Open state before cart starts.
   - Primary CTA: start shopping.
   - Scanner input should also start shopping.
   - Language switch is allowed here.

3. `shopping`
   - Main scan/cart state.
   - Left/center: scan prompt and category fallback.
   - Right: cart list and running total.
   - Primary CTA: go to summary.

4. `summary`
   - Review basket, quantity, price, and bag option.
   - Customer confirms before payment.
   - This is where mistakes are corrected.

5. `payment`
   - Payment method selection and terminal status.
   - In demo mode, clearly label mocked payment.
   - In production mode, fail closed until terminal integration is real.

6. `receipt`
   - Fiscal/order/receipt progress.
   - Must not jump straight to thank-you before fiscal/order result is known in production.

7. `thankyou`
   - Short completion screen.
   - Auto-reset after a brief delay.

## 9. UX Rules

Every customer-facing screen needs exactly one obvious next action.

Cart total must always be visible from `shopping` onward.

Payment cannot be available when cart is empty.

Staff help locks the kiosk. The customer should not be able to self-unlock after requesting staff help.

Language changes on the kiosk are session-only. The customer must not mutate store configuration.

Idle reset returns to welcome and clears basket. Do not reset while payment or receipt processing is active unless a real terminal timeout is handled.

Scanning should be the fastest path. Category buttons are fallback, not the primary shopping method.

Unknown barcode errors must be recoverable:
- show what failed
- keep the cart intact
- offer scan again, enter code, category fallback, or ask staff

Payment and receipt actions need visible progress:
- selected payment method
- waiting for terminal
- processing
- approved/failed
- printing/saving receipt

## 10. Layout Direction

### Customer Welcome

Reference: Zabka welcome, with less advertising.

Recommended structure:
- top-left Zira/store identity
- top-right language switch
- central open-state panel
- very large "Start shopping" action
- scanner hint below CTA
- optional promo/media area only if it does not compete with start action

Version 1 recommendation: no promo media. Pure checkout first. Promo can come later after the core flow feels real.

### Customer Shopping

Reference: Zabka shopping screen.

Recommended structure:
- top utility bar: logo, current language, help
- main scan zone: large barcode icon/scan instruction/latest scanned item
- category fallback row/grid below scan zone
- cart panel on the right
- sticky total + summary CTA at bottom-right

Suggested desktop kiosk grid:
- left/main content: 60-65%
- cart panel: 35-40%
- bottom CTA bar: fixed inside cart panel

The cart should not be a tiny POS table. It needs:
- fewer columns
- larger product names
- quantity controls
- obvious remove affordance
- price aligned with tabular numbers

### Summary

Recommended structure:
- left: cart review
- right: transaction options and total due
- options: bag, language still visible
- actions: back to shopping, pay

Do not bury the bag option in a separate mandatory step. It is a checkout option, not a full screen.

### Payment

Reference: Lewiatan simplicity.

Recommended structure:
- amount due dominates
- two large payment buttons: card and BLIK
- terminal status below
- cancel/back only before terminal is active

Demo mode:
- show demo badge
- never look production-ready

Production mode:
- disabled/closed until real terminal path exists

### Receipt

Recommended structure:
- progress list: order, fiscal receipt, print/send
- visible success or failure
- no customer action unless failure needs staff/retry

### Thank You

Recommended structure:
- short confirmation
- optional receipt reminder
- auto-reset countdown

### Unavailable

Reference: Carrefour closed state.

Recommended structure:
- large closed symbol
- one direct message
- optional small "ask staff" line
- no shopping CTA

## 11. Interaction Requirements

Touch targets:
- operator controls: minimum 44px
- customer controls: prefer 56-72px
- payment/start/checkout CTAs: 72px+ height
- adjacent touch targets: at least 8px gap, prefer 12-16px on kiosk

Scanner:
- scanner input works from welcome and shopping
- successful scan gives immediate visual feedback
- unknown barcode shows recoverable error without losing cart
- avoid any flow that requires precise mouse-style interaction

Buttons:
- pressed feedback within 100ms
- disabled state must look disabled and be semantically disabled
- do not rely on hover for important affordances

Errors:
- use visible message near the failing area
- include a recovery action
- use `role="alert"` or equivalent for important errors
- do not show red border only

Motion:
- keep micro-interactions 150-250ms
- use opacity/transform only
- respect reduced motion
- no decorative animation during payment

## 12. Component Direction

Use Lucide icons for operator/admin controls and simple customer UI symbols. Do not use emoji as structural icons.

Customer components:
- `KioskActionButton`: large, high-contrast, icon + label, 56-80px high
- `KioskCartPanel`: stable width, sticky total, dense but touch-safe rows
- `ScanPrompt`: scan icon, latest scan feedback, unknown code state
- `CategoryTile`: product category fallback, image/icon optional
- `PaymentMethodButton`: card/BLIK, strong disabled/loading states
- `KioskStatusScreen`: unavailable/help/thank-you/receipt state

Operator components:
- `ReadinessPanel`
- `DependencyChecklist`
- `LaunchKioskPanel`
- `KioskSettingsGrid`

Avoid nested cards. Use panels and full-width bands for page structure; use cards only for repeated items or framed tools.

## 13. Visual References To Borrow

Borrow from Zabka:
- open/welcome state clarity
- category fallback
- cart panel + checkout button
- language toggle position

Borrow from Lewiatan:
- scan-first discipline
- payment choice simplicity
- low cognitive load

Borrow from Carrefour:
- explicit unavailable state
- multilingual readiness

Reject:
- tiny legacy desktop controls from Lewiatan
- over-advertising from Zabka if it hides shopping
- closed state that looks pretty but gives staff no operational signal
- marketing/showcase output from generic design tools

## 14. My Recommended V1

Ship V1 as pure checkout, no promo/media.

Use:
- PL and EN visible on kiosk; VI can remain supported if already useful for internal testing.
- Card and BLIK visible only in demo mode until real terminal integration exists.
- NIP/faktura is staff-only for V1; do not ask self-checkout customers for NIP.
- Bag fee as one summary option, not a separate screen.
- Production mode fail-closed until payment, fiscal, and order creation are real.

The customer shopping screen should be the main redesign investment. If that screen is weak, the rest of the flow will still feel fake.

## 15. Open Questions

These should be decided before visual implementation:

1. Should version 1 be pure checkout with no promotions? Recommendation: yes.
2. Which customer languages are required for launch: PL/EN only, or PL/EN/VI?
3. Is BLIK a launch requirement or later terminal integration?
4. What hardware status can the app actually know: printer, terminal, scale, scanner, cash drawer?
5. Should staff help pause the entire kiosk or only block payment? Recommendation: pause/lock the kiosk.
6. What is the production reset policy after failed payment?

## 16. Redesign Checklist

Before touching UI implementation:
- confirm which customer states ship in version 1
- confirm palette tokens above
- confirm no promo/media for V1
- confirm which payment methods are real vs demo
- sketch operator tab and customer kiosk separately

Implementation order:
1. Redesign operator tab readiness/settings.
2. Redesign customer welcome/unavailable.
3. Redesign shopping/cart.
4. Redesign summary/payment/receipt.
5. Run browser/manual visual checks on desktop kiosk viewport.

Final UI QA:
- touch targets pass 44px operator and 56px+ customer rules
- no hover-only critical controls
- contrast passes for text and status states
- errors include recovery path
- total remains visible from shopping onward
- payment cannot look real in production until integration is real
- text fits in PL and EN
