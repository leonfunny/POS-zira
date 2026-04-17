# Zira POS Retail Design Contract

Use an IBM-like operational light interface for cashier workflows. This is a Windows desktop POS, not e-commerce, not a marketing dashboard, and not a cinematic dark UI.

## Principles

- Optimize for checkout speed, scanability, and low error rates under cashier pressure.
- Keep the Retail sale flow visually quiet: neutral surfaces, clear borders, restrained shadows, and obvious action hierarchy.
- Use the existing brand accent sparingly for primary actions and selected states. Use status colors only for operational meaning: success, warning, danger, information, offline, shift state, stock, and payment state.
- Prefer compact layouts, but important touch controls must be at least 44px high/wide. Adjacent touch controls need at least 8px spacing.
- Use stable sizing for grids, cards, toolbars, cart rows, counters, and action bars so state changes do not shift the layout.

## Visual Rules

- Background: light neutral canvas.
- Panels: white or very light gray with 1px neutral borders.
- Radius: 6-8px for operational cards, controls, panels, and inputs.
- Shadows: subtle only, used to separate actionable surfaces.
- Typography: Segoe/Bahnschrift stack already configured; use weight and size hierarchy rather than decorative type.
- Product cards: image/no-image area, clear name, SKU, price, status badges, and a reliable add affordance.
- Cart: item rows should be dense but touch-safe; totals and payment should be visually stronger than secondary actions.

## Avoid

- Neon gradients, decorative blobs, bento/landing-page patterns, glassmorphism, heavy shadows, and dark cinematic surfaces.
- Tiny text-only chips for operational actions such as Hold, Recall, Discount, History, Display, Pay, quantity edit, or remove.
- Retail browsing patterns that slow down cashier checkout.
- Broad redesigns of non-Retail POS modes during the Retail sale-flow slice.
