# Display On Concierge Design

## Goal
- Redesign all customer-display screens after `Touch to explore` for salon mode.
- Keep the current warm palette and overall brand tone.
- Prioritize fast arrival flows over browse-heavy merchandising.
- Add a Display On language switch that persists independently from POS.

## Locked Decisions
- Direction: `A. Concierge Flow`
- `Touch to explore` remains unchanged.
- First screen after idle uses fast-arrival hierarchy:
  - Primary: `Check in with phone`, `I have booking`
  - Secondary: `Walk in`, `Browse service`
- `Browse service` is catalog-first and hands off into `Walk in`.
- Display language persists separately via `customerDisplayLanguage`.

## Experience Structure
- Use one shared kiosk shell across redesigned Display On screens.
- Shell owns:
  - salon name / context label
  - top-right language dropdown styled like POS
  - minimal back/home affordance
  - consistent spacing, surfaces, and action hierarchy
- Rebuild the post-idle flow into four purpose-built screens:
  - `Check in with phone`
    - large keypad
    - live booking matches
    - obvious fallback to walk-in
  - `I have booking`
    - fast search by name
    - short confirm path
    - no extra decorative panels
  - `Walk in`
    - minimal identity step first
    - clear continuation into service choice
    - one primary CTA at a time
  - `Browse service`
    - category-led catalog
    - price + duration clarity
    - CTA to continue into `Walk in`

## Visual Direction
- Preserve existing warm sand / terracotta palette from the app.
- Remove weak UI patterns:
  - no emoji icons
  - no equal-weight generic card pile
  - no decorative floating effects competing with the task
- Use stronger hierarchy:
  - large task titles
  - short support copy
  - tabular numbers for price / time
  - clear primary vs secondary actions
- Keep motion restrained:
  - 150–250ms state transitions
  - only use animation to reinforce navigation or feedback

## Technical Shape
- Keep current Display On IPC/data contracts where possible:
  - `display:touch`
  - `display:get-bookings`
  - `display:search-by-phone`
  - `display:check-in`
  - `display:browse-services`
  - `display:back-to-idle`
  - `display:request-service`
  - `display:interaction-ping`
- Extend config/schema/types only for `customerDisplayLanguage`.
- Expose config save from `preload-display.ts` so customer display can persist language without mutating POS language.
- Refactor the current large customer-display view logic into smaller screen components plus shared shell/helpers.

## Acceptance Criteria
- `Touch to explore` remains visually and behaviorally unchanged.
- All redesigned screens share one clear kiosk shell and feel like one system.
- Language switch appears on redesigned Display On screens and persists independently.
- `Check in with phone` and `I have booking` visually dominate the first post-idle screen.
- `Browse service` no longer behaves like an alternate main selection engine.
- No emoji icons remain in the redesigned Display On flow.
- Touch targets and text hierarchy remain kiosk-safe and readable.
