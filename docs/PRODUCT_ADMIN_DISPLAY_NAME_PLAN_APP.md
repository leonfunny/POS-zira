# Plan P2 (App / POS-zira) — Edit per-language Display Name

> **Implementation plan — desktop app only. Starts ONLY after backend Plan P1 is live on Contabo** (`GET …/product-admin/capabilities` returns `version: 2` + `canEditDisplayName: true`).
> Spec: [`PRODUCT_ADMIN_DISPLAY_NAME_CONTRACT.md`](./PRODUCT_ADMIN_DISPLAY_NAME_CONTRACT.md) — **§A authoritative.**
> Repo: `winpc` (`DESKTOP-50SCDJT`) `C:\POS-zira` (Electron; `src/{main,preload,renderer,shared}`).
> Goal: add a per-language **Display name** editor to Products → Edit, sending `nameTranslations` on `PATCH /warehouse/product-admin/variants/:id`, while the existing field is relabeled as the canonical/fiscal name. Capability-gated; merge-friendly; never sends to an old backend.

## 0. Hard gate
- Read `canEditDisplayName` from `getProductAdminCapabilities` at session start. **If `version < 2` OR `canEditDisplayName !== true` (or field absent): hide the editor AND never put `nameTranslations` in any payload** — old backends reject unknown fields with `400` (`forbidNonWhitelisted`). (Contract §A.2.5.)

## 1. Tasks (ordered)

### T1 — Types
File: `src/shared/types.ts`
- `ProductAdminUpdateVariantInput` (~:2982): add
  ```ts
  nameTranslations?: Record<string, string | null>; // per-locale; "" / null clears that locale
  ```
- `ProductAdminCapabilities` (~:2892): add `canEditDisplayName: boolean;` (and the parse in `api-client.ts getProductAdminCapabilities` → `raw?.canEditDisplayName === true`).
- `ProductAdminVariant` already has `nameTranslations?` (:2950) — used to apply the response.

### T2 — Edit form
File: `src/renderer/components/products/ProductEditForm.tsx`
- **Relabel** the existing name field: `products.drawer.canonicalName` → keep value but make the label/hint explicit, e.g. *"Canonical name — printed on receipts / invoices / fiscal"*. (No behavior change; it still maps to `payload.name`.)
- **New "Display name (per language)" section**, rendered only when `capabilities.canEditDisplayName === true`:
  - State `displayNames: Record<string,string>` initialized from `parseTranslations(product.name_translations)` (use the existing `shared/catalog-names.ts` helpers).
  - Inputs: show the **current UI `language`** and **`pl`** (the label-relevant locale) by default; an expander reveals the other supported locales `{en,de,uk,vi,ru,zh,tr}`. Placeholder for each = canonical `name` (signals the fallback).
  - Helper text when the product/template has **>1 variant**: *"Applies to all variants of this product"* (contract §A.2.1).
  - Include display-name changes in `productDirty`.
- **Payload (merge-friendly diff):** build `nameTranslations` containing **only changed locales** — a locale the user cleared is sent as `""` (backend deletes the key); unchanged locales are **omitted** (backend merges). Add to the existing `ProductAdminUpdateVariantInput` payload only when non-empty and the capability is on. Do **not** touch `payload.name` from this section.
- **On success:** apply `result.data.variant.nameTranslations` to the local product row/state so the card re-renders immediately (no wait for sync).

### T3 — Local cache / sync
- The local SQLite `name_translations` column already exists (`product-repo.ts`, `migrations.ts`). After a successful PATCH, write the echoed `nameTranslations` to the local row (so `resolveName` reflects it before the next pull).
- **Keep the poison guard** (`api-client.ts:1944-1975`) unchanged — a single-product edit never produces a map shared across differently-named rows, so it won't be dropped. The incremental `since` pull will also re-emit all sibling variants (backend P1/T3) and confirm the value.

### T4 — i18n
File: `src/renderer/i18n/translations.ts` (hook `useTranslation`).
- Add keys (all 8 locales, fallback to a sensible default): `products.edit.displayName`, `products.edit.displayNameHint`, `products.edit.displayNameAllVariants`, `products.drawer.canonicalName` hint update, `products.edit.moreLanguages`.

## 2. Tests (vitest)
1. Payload builds `nameTranslations` with **only** changed locales; a cleared locale → `""`; unchanged omitted.
2. Gating: when `canEditDisplayName` false / `version<2` / absent → section hidden **and** no `nameTranslations` key in the payload.
3. On success, local row’s `name_translations` updated from the response; `resolveName` returns the new value.
4. Poison guard still drops a map shared across differently-named rows; a normal single edit is retained.
5. Canonical field still maps to `payload.name`; editing display name does not change `payload.name`.

## 3. Manual QA (per POS-zira dev workflow)
- Real typecheck + vitest on Alienware; run dev Electron (`schtasks ZiraDevElectron`).
- With a chesaigon-like product (canonical "Đầu vai giòn", vi "Đầu vai"): edit vi → card updates instantly; ring it up → receipt still prints canonical "Đầu vai giòn"; clear vi → card falls back to canonical.
- Point at an **old** backend (or force `canEditDisplayName:false`) → editor hidden, normal edit still works, no 400.

## 4. Acceptance criteria (P2 done when)
- Cashier (OWNER/MANAGER) can set/clear per-language display names; canonical name + receipts unaffected.
- Editor is fully hidden + inert against a pre-P1 backend.
- Local card reflects the edit immediately and survives the next sync; multi-variant note shown when relevant.

## 5. Dependencies
- **Blocked on P1** (backend `version:2` + `canEditDisplayName` live on Contabo). Do not start UI wiring against an unshipped backend.
