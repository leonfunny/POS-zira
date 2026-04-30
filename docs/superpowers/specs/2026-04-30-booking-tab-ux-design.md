# Booking Tab UX Design

## Goal

Redesign the Booking tab UI without changing booking logic.

This spec covers the dashboard-synced Booking tab in the Print Agent app:

- `src/renderer/components/booking/BookingsTodayScreen.tsx`
- `src/renderer/components/booking/BookingCreateForm.tsx`
- `src/renderer/components/booking/BookingEditForm.tsx`

It does not cover Booksy Sync UI, Booksy import, customer-display booking search, or backend booking behavior.

## Source Inputs

- Existing project `DESIGN.md`: IBM-like light operational POS interface.
- `design-md` POS preset guidance:
  - Primary direction: `ibm` for operational structure.
  - Secondary influence: `cal` for appointment and scheduling clarity.
  - Avoid marketing, cinematic, gradient, bento, and dark dashboard styles.
- `ui-ux-pro-max` searches:
  - Useful guidance: data-dense operational UI, labeled form controls, visible submit feedback, keyboard access, color contrast, error messages with `role="alert"`, stable list keys.
  - Rejected guidance: horizontal journey / product discovery patterns. That is a bad fit for a POS booking operations screen.
- Current code behavior:
  - Renderer uses `window.electronAPI.bookings.*`; it does not call backend directly.
  - Create/edit/cancel/check-in/complete logic is already wired and must be preserved.
  - Staff picker uses `user_id || id`; keep that contract.
  - Service create supports service base duration/price when no `service_rules` exist; keep that behavior.

## Locked Decisions

- Direction: operational light scheduling UI, not a marketing dashboard.
- Keep the screen focused on today's bookings for this pass.
- Keep modal-based create/edit/cancel flows for this pass.
- Keep all existing IPC method names and booking state transitions.
- Use `lucide-react` icons where icons are needed.
- Do not add full calendar/week/month views in this pass.
- Do not add Booksy Sync UI changes in this pass.
- Do not add backend API changes in this pass unless implementation uncovers a real blocker.

## Considered Approaches

### A. Operational Today List Polish - Selected

Keep the current Today list model, but redesign hierarchy, rows, actions, modals, validation, empty/loading/error states, and accessibility. This is the right first pass because it improves the real workflow without touching sync logic or expanding scope.

### B. Calendar Timeline

Render appointments on a vertical time grid. This can be useful later, but it raises scope: overlapping appointments, date navigation, time scale, staff lanes, scroll positioning, and conflict visibility. Do not start here.

### C. Rich Booking Workbench

Add a detail drawer, filters, staff schedules, customer search, service edit, and full lifecycle controls. This is too large for the current goal. It risks mixing UX cleanup with product expansion.

## Page Layout

Use one full-height operational screen with three stable areas:

1. Header toolbar
   - Left: title `Bookings`, date context `Today`, appointment count.
   - Optional small sync hint if already available from existing state; do not invent a new backend status source.
   - Right: primary `New walk-in`, secondary icon button `Refresh`.
   - If `onBack` exists, show a secondary `Back` control after Refresh.

2. Status summary strip
   - Compact counts from already-loaded rows:
     - Total
     - Booked/Pending
     - Checked in/In service
     - Completed/Paid
     - Cancelled/No show
   - These are derived values only. Do not add new data fetching.
   - Keep this strip shallow and utilitarian; no large KPI cards.

3. Booking list
   - Full-width list with stable row height.
   - Each row should be scan-friendly and action-safe:
     - Time rail: start time strong, end time/duration secondary.
     - Main identity: customer name, phone, service, staff.
     - Notes preview: one line max, muted, only when present.
     - Price: tabular number, right aligned.
     - Status: text badge with icon or label; color is not the only signal.
     - Actions: stable right action group.

Avoid nested cards. Rows may be individual bordered surfaces, but the page itself should not become card-in-card.

## Booking Row Rules

Each row must support fast scanning under cashier pressure:

- Start time uses the strongest typography in the row.
- Customer name is more important than service name.
- Service and staff are grouped together, but staff must remain visible.
- Phone should be visible if available; it helps confirm identity.
- Status label must be readable text, not only color.
- Price uses tabular numerals when possible.
- Long customer/service/notes text truncates with a tooltip or title attribute.
- Busy actions must not resize the row.

Recommended row action visibility:

- `PENDING` or `BOOKED`:
  - Edit
  - Check in
  - Cancel
- `CHECKED_IN` or `IN_SERVICE`:
  - Complete
  - Cancel
- `COMPLETED`, `PAID`, `CANCELLED`, `NO_SHOW`:
  - No destructive primary actions.
  - Keep row readable and muted for terminal states.

## Create Booking Modal

The create modal should feel like a small operational form, not a generic browser prompt replacement.

Structure:

1. Header
   - Title: `New walk-in booking`
   - Close icon button with accessible name.
   - Optional short subtitle only if it adds concrete context, e.g. selected date/time.

2. Appointment section
   - Service select.
   - Pricing/duration select only when there are multiple rules.
   - Service-default duration/price hint when no rules exist.
   - Staff select.
   - Start time.

3. Customer section
   - Phone.
   - Customer name.
   - Email optional.

4. Notes section
   - Customer notes optional.

5. Footer
   - Secondary Cancel.
   - Primary Create booking.
   - Submit button keeps stable width while submitting.

Phone input requirements:

- It must not accept alphabetic characters from keyboard or paste.
- Use `type="tel"` and an explicit mobile/virtual keyboard hint.
- Allow digits plus practical phone formatting characters: `+`, space, `-`, `(`, `)`.
- Normalize or sanitize before storing in state.
- If the product owner later wants strict digits only, that is a separate decision; do not silently break `+48` style numbers while the placeholder still suggests them.

Form feedback requirements:

- Required fields must have clear labels.
- Disabled Create button should not be mysterious:
  - Prefer inline required-field hints or section-level helper text.
  - At minimum, keep visible validation/error feedback when submit fails.
- Errors use `role="alert"` or an equivalent live announcement.
- Master-data load errors are shown inside the modal with a retry path if practical.
- Closing is disabled while submit is in flight, matching current behavior.

## Edit Booking Modal

Keep edit scope narrow:

- Staff
- Start time / reschedule
- Customer notes
- Internal notes

Do not add service edit or customer identity edit in this pass. That changes business behavior and should be a separate product decision.

Recommended layout:

- Header shows customer, service, current status.
- Appointment section contains staff and start time.
- Notes section contains customer/internal notes.
- Footer has Cancel and Save changes.
- Save is disabled when there are no changes.
- Invalid time and update failure appear as accessible alert text.

## Cancel Modal

The cancel modal already replaces unsupported `window.prompt`; keep it but make it more deliberate:

- Header: `Cancel booking`
- Body: show customer, service, start time if available.
- Reason textarea:
  - Optional.
  - Placeholder explains default reason.
- Footer:
  - Secondary Close.
  - Destructive Cancel booking.
- Destructive action must be visually distinct but not oversized.
- Backdrop click may close only when no action is in flight.

## Empty, Loading, Error, and Offline States

Empty:

- Show a compact empty state, not a decorative illustration.
- Text: no appointments for today.
- Primary action: New walk-in.

Loading:

- Initial load can use skeleton/list placeholder.
- Refresh should not blank the list if existing rows are present.

Error:

- Error banner sits below the header.
- It must include readable text and `role="alert"`.
- Keep Refresh available.

API unavailable:

- Show a blocking operational error.
- Do not render controls that cannot work.

## Visual Contract

Use the existing app contract:

- Background: light neutral canvas.
- Surfaces: white or very light gray with 1px neutral borders.
- Radius: 6-8px.
- Shadow: subtle only for modals and actionable elevated surfaces.
- Typography: existing app stack; do not introduce external fonts.
- Accent: existing indigo/brand accent for primary actions only.
- Status colors:
  - Pending: amber.
  - Booked: blue.
  - Checked in / in service: indigo or violet.
  - Completed / paid: emerald or green.
  - Cancelled / no show: rose or neutral gray.
- Buttons and inputs:
  - Minimum 44px height for primary touch targets.
  - 8px minimum gap between adjacent actions.
  - Clear focus ring.
  - No layout shift on hover or busy state.

Avoid:

- Gradients, blobs, glassmorphism, oversized hero sections.
- Decorative empty-state art.
- Tiny text-only destructive actions.
- Cards inside cards.
- Color-only status signaling.
- Replacing the screen with a marketing-style dashboard.

## Component Boundaries

Keep the implementation surgical:

- `BookingsTodayScreen.tsx`
  - Owns fetching, refresh, current modal state, derived counts, row rendering.
  - May extract tiny local helper components if the file becomes hard to read:
    - `StatusBadge`
    - `BookingRow`
    - `SummaryStrip`
  - Do not move sync logic here.

- `BookingCreateForm.tsx`
  - Owns create form state and validation.
  - Add phone sanitization here.
  - Keep ruleless-service fallback intact.
  - Keep double-submit guard intact.

- `BookingEditForm.tsx`
  - Owns edit form state and changed-field patch generation.
  - Keep current patch-only behavior intact.

Any shared UI helper must be small and local to the booking folder unless it is already clearly reusable elsewhere.

## Accessibility Requirements

- Every input has a visible label.
- Icon-only buttons have `aria-label`.
- Error messages use `role="alert"` or `aria-live`.
- Dialogs keep `role="dialog"` and `aria-modal="true"`.
- Keyboard tab order follows visual order.
- Primary and destructive actions are reachable by keyboard.
- Focus should land in the first useful modal field when opened.
- Escape-to-close can be added only if it does not conflict with in-flight submit protection.

## Testing Plan

Automated tests should cover:

- Booking UI does not use `window.prompt`.
- Create form allows ruleless services when service base duration/price exists.
- Create form prevents stale rule submission after service change.
- Phone input rejects or sanitizes letters from typing and paste.
- Submit button remains disabled for genuinely missing required fields.
- Edit form only sends changed fields.
- Terminal statuses do not show invalid actions.

Manual smoke test after implementation:

- Create a walk-in booking.
- Edit/reschedule it.
- Cancel it.
- Create another booking and check it in.
- Complete a checked-in booking.
- Refresh list and confirm rows remain stable.
- Restart app and confirm created booking persistence.
- Confirm phone field cannot retain letters.
- Double-click Create and confirm no duplicate booking appears.

## Success Criteria

- Booking logic remains unchanged and still passes existing booking tests.
- The Booking tab is visually consistent with the POS retail design contract.
- Cashier can scan today's appointments faster than in the current UI.
- Create/edit/cancel/check-in/complete flows remain usable from the UI.
- Phone field no longer keeps alphabetic input.
- Error, empty, loading, and busy states are explicit and accessible.
- No Booksy Sync UI/import changes are included.
- The spec is plain Markdown and readable by any agent, including Claude backend bot.
