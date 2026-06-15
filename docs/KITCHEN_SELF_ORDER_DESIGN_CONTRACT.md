# Kitchen Self-Order Design Contract

Status: approved implementation contract  
Owner surface: customer-facing Kitchen Self-Order window  
Design base: root `DESIGN.md`  
Last updated: 2026-06-15

This contract is the source of truth for the restaurant/customer ordering kiosk. It replaces the UI, product-option, and checkout-flow assumptions in `KITCHEN_SELF_ORDER_MVP_PLAN.md`. The MVP document remains useful for the original printing and order-number architecture.

## 1. Product Rules

- This is a customer ordering kiosk, not a cashier POS, dashboard, or marketing page.
- Grocery self-checkout and kitchen self-order remain separate flows.
- The server catalog owns product prices, kiosk media, modifier groups, availability, and checkout policy.
- The renderer must never invent sugar, ice, topping, food-note, or other product options.
- Every screen has one dominant next action.
- Technical printer and routing status belongs in operator diagnostics and logs, not on customer completion screens.
- Production terminal flows fail closed until a real terminal contract is available.

## 2. Visual Direction

The interface inherits the operational IBM-like base from `DESIGN.md`, adapted for customer-facing food and drink selection.

| Token | Default | Use |
| --- | --- | --- |
| Canvas | `#F7F8F6` | Main background |
| Surface | `#FFFFFF` | Product cards, cart, modal |
| Surface muted | `#EEF1EE` | Media fallback, disabled areas |
| Border | `#D8DED6` | Structural separation |
| Ink | `#202421` | Primary text |
| Muted | `#687069` | Secondary text |
| Accent fallback | `#DA7756` | Selected state and primary action |
| Success | `#15803D` | Completed order |
| Danger | `#B42318` | Blocking error |

Tenant branding is limited to:

- display name
- optional logo URL
- one six-digit accent color

The application validates the accent and falls back to Zira orange when it is malformed. Page structure, status colors, typography, spacing, and accessibility are not tenant-customizable.

Avoid gradients, glass surfaces, bento layouts, decorative blobs, promotional hero sections, nested cards, and hover-only controls.

## 3. Viewport And Geometry

Supported kiosk baselines:

- `1920x1080`
- `1600x900`
- `1280x800`

Layout:

- page padding: 12-16px
- structural gap: 12px
- cart width: 320px, acceptable range 300-328px
- header height: approximately 64px
- category/search toolbar: approximately 52px
- customer touch targets: minimum 48px, preferred 56px
- primary CTA: minimum 64px high

Product grid:

- width >= 1600px: exactly 4 columns
- width 1280-1599px: exactly 3 columns
- below 1280px: 2 columns as a defensive fallback

Product card:

- fixed row height within each viewport
- media stage consumes approximately 65-70% of the card
- product name reserves exactly two lines
- price and add affordance use a fixed footer rail
- all price and add controls align across the row
- the whole card is the touch target; the plus icon is only an affordance

## 4. Product Media Contract

Preferred server media shape:

```ts
type KitchenSelfOrderProductMedia = {
  url: string | null;
  fit: 'COVER' | 'CONTAIN';
  focalPoint: { x: number; y: number } | null; // normalized 0..1
  zoom: number; // clamped to 1..2
};
```

Rules:

- Curated customer thumbnails use a 4:3 presentation and may use `COVER`.
- `focalPoint` and `zoom` preserve the important product region.
- Legacy `thumbnail_url` / `image_url` uses `CONTAIN`.
- Missing or failed images use a neutral image placeholder.
- The kiosk must not apply `object-cover` to all legacy images because vertical bottles and cups will be clipped.
- Asset files with internal whitespace must be corrected through customer crop metadata, not one-off CSS selectors.

## 5. Screen State Machine

```text
MENU
  -> CONFIGURATOR (only when the selected product has modifier groups)
  -> MENU + CART
  -> REVIEW
  -> CHECKOUT_ROUTER
       -> SUBMITTING -> COMPLETE
       -> TERMINAL_REQUIRED (fail closed until integration exists)
  -> AUTO_RESET -> MENU
```

### Menu

- Compact brand header on the left.
- Fulfillment and language segmented controls on the right.
- Categories and compact search share one toolbar.
- Product grid occupies the largest visual area.
- Cart remains visible on the right.

### Configurator

- Opens only for products with attached modifier groups.
- Single-select groups use radio/segmented tiles.
- Multi-select groups use checkbox tiles.
- Options that allow quantity expose a stepper.
- Required groups are visually identified.
- Add CTA remains disabled until all groups validate.
- Validation scrolls/focuses the first invalid group.
- Editing a cart line reopens the same configurator with its current selections.

### Cart

- Product name, modifier summary, quantity, and line total are always visible.
- Edit appears only when the line has modifiers or permits a note.
- Quantity controls remain fixed and touch-safe.
- Empty cart has no enabled Review action.

### Review

- Full separate screen, not a small modal.
- Shows fulfillment, image thumbnail, product name, structured modifiers, note, quantity, and line total.
- Every line has an Edit action.
- Shows subtotal and one dominant continue/place-order action.
- Back returns to Menu without clearing the cart.

### Checkout Router

Supported policies:

```ts
type KitchenSelfOrderCheckoutMode =
  | 'PAY_AT_COUNTER'
  | 'KIOSK_TERMINAL'
  | 'ORDER_ONLY';

type KitchenSelfOrderReleasePolicy =
  | 'ON_SUBMIT'
  | 'ON_PAYMENT_CONFIRMED';
```

- `PAY_AT_COUNTER`: submit the request, print according to release policy, then tell the customer to pay at the counter.
- `ORDER_ONLY`: submit the request and show pickup instructions.
- `KIOSK_TERMINAL`: require the real terminal integration. Until available, show a customer-safe unavailable message and allow return to Review.
- `ON_PAYMENT_CONFIRMED` must never print/release an unpaid kitchen order.

### Complete

- Large order number.
- Short instruction derived from checkout mode.
- No route names, printer errors, or debug status.
- Operator logs retain kitchen/customer-slip failures.
- Reset automatically after 20 seconds, with a visible New order action.

## 6. Modifier Catalog Contract

Modifier groups are reusable server catalog entities attached to categories and/or products. A product-level group with the same ID overrides the inherited category group.

```ts
type KitchenSelfOrderModifierGroup = {
  attachmentId: string; // view-model attachment key
  id: string;
  name: string;
  nameTranslations?: string | null;
  selectionMode: 'SINGLE' | 'MULTIPLE';
  minSelections: number;
  maxSelections: number;
  displayOrder: number;
  allowOptionQuantity?: boolean;
  options: Array<{
    id: string;
    name: string;
    nameTranslations?: string | null;
    priceDeltaGrosze: number;
    isDefault: boolean;
    isAvailable: boolean;
    maxQuantity?: number | null;
  }>;
};
```

`attachmentId` is unique for the category/product attachment in the menu view model.
`id` remains the server catalog group ID and is the value persisted in modifier
snapshots. Product-level attachments replace inherited category attachments with
the same catalog `id` only for that product.

Required behavior:

- selection limits are validated in the main process against the cached server menu
- unavailable or unknown option IDs are rejected
- names and prices submitted by the renderer are replaced with catalog snapshots
- prices use integer grosze
- modifier groups and options support localized display names
- defaults are server data, not renderer constants
- free text note appears only when the product enables it

Bubble-tea examples such as sweetness `0/30/50/70/100`, ice `none/less/standard/extra`, and topping limits are tenant data examples only.

## 7. Menu IPC And Order Shapes

Renderer reads one dedicated menu view model:

```ts
window.electronAPI.kitchenSelfOrder.getMenu(): Promise<KitchenSelfOrderMenu>
```

The menu contains:

- validated tenant brand
- checkout and release policies
- tenant-enabled fulfillment modes
- customer categories
- customer products and media metadata
- reusable modifier groups
- product/group attachments

Structured order snapshot:

```ts
type KitchenSelfOrderModifierSnapshot = {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  quantity: number;
  priceDeltaGrosze: number;
};
```

Persistence:

- new data is stored in `options_json` as `{ version: 1, modifiers: [...] }`
- old `string[]` option arrays remain readable
- kitchen tickets and compact QR payloads flatten structured modifiers into readable labels
- POS recall remains compatible with old QR payloads

The renderer may display totals from the returned server snapshots, but it is not the price authority. Main/server validation must rebuild accepted modifier snapshots before persistence.

## 8. Server Change Request

The backend must expose a tenant/channel-specific kitchen menu contract or include equivalent fields in the existing catalog sync.

Required backend capabilities:

1. CRUD reusable modifier groups and options.
2. Attach groups to categories and products with product override.
3. Enforce min/max selection, availability, defaults, quantity limit, and price delta.
4. Store localized group and option names.
5. Store kiosk media URL, focal point, fit, and zoom.
6. Store product `noteEnabled`.
7. Return tenant brand name, logo, validated accent, checkout mode, release policy, and fulfillment options.
8. Revalidate product price and modifier selections when creating a paid/terminal order.
9. Emit catalog/sync updates when any kiosk field changes.

Until these capabilities exist:

- generic products are returned with empty modifier groups
- legacy images use `CONTAIN`
- notes remain hidden unless explicitly enabled
- `KIOSK_TERMINAL` remains unavailable
- the client must not create local default option sets

## 9. Accessibility And Interaction

- PL, VI, and EN strings must fit without overlapping controls.
- Product names wrap to two lines; cart and review names wrap rather than truncate critical information.
- Keyboard focus remains visible for development and accessibility.
- Disabled controls use native `disabled`.
- Blocking errors include a recovery action.
- Press feedback uses color/transform within 100-200ms.
- Motion uses opacity/transform only and respects reduced motion.

## 10. Acceptance Tests

Visual:

- 4 columns at 1920 and 1600, 3 columns at 1280.
- Product media is the dominant card content.
- Price and plus affordances align for one-line and two-line names.
- Cart remains usable in Polish at all target widths.
- Crop metadata, legacy media, missing images, and failed images render safely.

Behavior:

- simple product adds directly
- configured product opens Configurator
- required/single/multiple/default/quantity/price-delta rules validate
- editing preserves the line instead of creating a duplicate
- Review displays all order information and returns to Menu without loss
- `PAY_AT_COUNTER` and `ORDER_ONLY` submit
- `KIOSK_TERMINAL` fails closed without integration
- customer completion hides printer/debug details

Regression:

- existing kitchen ticket, customer slip, QR recall, printer routing, and grocery self-checkout tests pass
- renderer typecheck and full production build pass

## 11. Research Basis

- Square Catalog modifiers: https://developer.squareup.com/docs/catalog-api/enable-modifiers-on-items
- Toast modifier groups: https://doc.toasttab.com/doc/platformguide/adminAddingModifierGroupsAndModifiers.html
- Gong Cha customization examples: https://www.gong-cha.com/usa/us-en/the-secret-to-customizing-your-gong-cha-order-like-a-pro
