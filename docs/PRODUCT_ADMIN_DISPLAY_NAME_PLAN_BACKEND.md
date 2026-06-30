# Plan P1 (Backend) — Product Admin per-language Display Name

> **Implementation plan — backend only. Ships and is verified BEFORE the app plan (P2) starts.**
> Spec: [`PRODUCT_ADMIN_DISPLAY_NAME_CONTRACT.md`](./PRODUCT_ADMIN_DISPLAY_NAME_CONTRACT.md) — **§A is authoritative.**
> Repo `/var/www/www/enail` · branch `feat/product-admin-create-product` · module `backend/src/modules/product-admin`.
> Goal: let `PATCH /api/v1/warehouse/product-admin/variants/:variantId` persist `name_translations` (per-locale **merge** into the template) **without touching canonical `name`**, with atomic concurrency, full sibling-variant sync propagation, async best-effort reindex, and a version-gated capability.

## 0. Guardrails
- **No schema migration** — `products.name_translations` already exists (`jsonb NOT NULL DEFAULT '{}'`).
- **Never** modify `products.name` / `product_variants.name` from a translations edit.
- Build on **Netcup**, deploy compiled `dist` to **Contabo** (live `api.enail.pro`) per the `deploy-contabo` flow — verify capabilities + a real PATCH on Contabo.

## 1. Tasks (ordered)

### T1 — DTO: accept `nameTranslations`
File: `product-admin/dto/product-admin.dto.ts`
- Add to **`UpdateProductAdminVariantDto`**:
  ```ts
  @ApiPropertyOptional({ description: "Per-language display names (merged into the template). Empty/null value for a locale deletes that key. Does NOT change canonical name." })
  @IsOptional()
  @IsObject()
  @Validate(NameTranslationsValidator)   // custom: see below
  nameTranslations?: Record<string, string | null>;
  ```
- Custom `NameTranslationsValidator` (new file `product-admin/dto/name-translations.validator.ts`):
  - value is a plain object (not array), ≤ **16** keys.
  - each key ∈ supported locales `{pl,en,de,uk,vi,ru,zh,tr}` (lower-cased before check) → else `INVALID_LOCALE`.
  - each value is `string | null`; if string, length ≤ **255** → else `INVALID_TRANSLATIONS`.
- (Optional, T1b) mirror the field on `CreateProductAdminProductDto` (stored verbatim into the new template's `name_translations`). Lower priority than the edit path.

### T2 — Service: atomic merge + no-name-touch
File: `product-admin/services/product-admin.service.ts` → `updateVariant` (inside the existing `dataSource.transaction`).
- Keep the existing variant-field path and `assertNotStale(variant.updatedAt, dto.expectedUpdatedAt)` unchanged.
- When `dto.nameTranslations !== undefined`, after resolving `variant.template` (templateId), run an **atomic JSONB merge** (raw SQL via `manager.query(...)`, **not** entity read-modify-write):
  ```ts
  const incoming = lowercaseKeys(dto.nameTranslations);
  const patch = pickNonEmpty(incoming);             // { vi: "Đầu vai", ... }
  const keysToDelete = keysWithEmptyValue(incoming);// ["en", ...]
  await manager.query(
    `UPDATE products
        SET name_translations = (COALESCE(name_translations,'{}'::jsonb) || $1::jsonb) - $2::text[],
            updated_at = now()
      WHERE id = $3 AND salon_id = $4`,
    [JSON.stringify(patch), keysToDelete, variant.templateId, salonId],
  );
  ```
  - `||` merges per key (concurrent writers to different locales both survive); `- keys[]` removes cleared locales. Race-free at row level → resolves contract §A.2.2. **No `@VersionColumn` added.**
  - Do **not** set `template.name` / `variant.name` here.

### T3 — Sibling propagation (sync)
Still inside the transaction, after T2:
- Bump every sibling variant so the incremental `since` feed re-emits them:
  ```ts
  await manager.query(
    `UPDATE product_variants SET updated_at = now() WHERE template_id = $1 AND salon_id = $2`,
    [variant.templateId, salonId],
  );
  const siblingIds: string[] = (await manager.query(
    `SELECT id FROM product_variants WHERE template_id = $1 AND salon_id = $2`,
    [variant.templateId, salonId],
  )).map(r => r.id);
  ```
- After commit, emit `product.updated` for **each** `siblingId` (extend/loop the existing `emitProductUpdated`), not just the PATCHed one → contract §A.2.3.

### T4 — Response echoes translations
`mapVariant` (`service:940-964`): add
```ts
nameTranslations: v.template?.nameTranslations ?? {},
```
so the PATCH response carries the merged map (read type `ProductAdminVariant.nameTranslations?` already exists) → app updates its local row immediately (no resync needed).
- Ensure the `fresh` reload (`service:191-194`) loads `relations:["template"]` (it does) so `v.template.nameTranslations` reflects the just-merged value.

### T5 — Capability bump + gate
`getCapabilities` (`service:80-105`): `version: 1 → 2`; add `canEditDisplayName: canAdminProducts`. (Endpoint is already `@Roles(OWNER, MANAGER)`; STAFF stays 403 regardless.) → contract §A.2.5.

### T6 — Async best-effort reindex
After the transaction **commits** (not awaited in the request path):
```ts
this.productSearchService.indexProducts(siblingIds).catch(e =>
  this.logger.warn(`[display-name] reindex failed template=${variant.templateId}: ${e?.message}`));
```
- Inject `ProductSearchService` into `ProductAdminModule` (verify it is exported/available; if not, wire it). Reindex failure **must not** fail the PATCH (jsonb already committed); `reindexSalon` is the backstop → contract §A.2.4.

## 2. Errors
Reuse the existing envelope (`ProductAdminErrorEnvelope`). `STALE_PRODUCT` (409) unchanged for the variant-field path. Validation failures → `400` with `field:"nameTranslations"`, `code` `INVALID_LOCALE` / `INVALID_TRANSLATIONS` (or a plain 400 if we choose not to grow the enum — app already surfaces `error.message`).

## 3. Tests (extend `product-admin/__tests__`, currently 31 passing)
1. Merge keeps other locales: existing `{pl,en}` + PATCH `{vi}` → all three present.
2. Empty/null value deletes that locale; stored object has no empty values.
3. `nameTranslations`-only PATCH leaves `products.name` **and** `product_variants.name` unchanged.
4. Validation: bad locale → `INVALID_LOCALE`; non-string / >255 / >16 keys / non-object → `INVALID_TRANSLATIONS`.
5. `nameTranslations` no longer 400s under `forbidNonWhitelisted`.
6. **Concurrency:** two parallel PATCHes to two variants of the **same** template, each setting a **different** locale → both locales present afterwards (no lost update). Same-locale → deterministic last-write on that key only.
7. **Sibling propagation:** PATCH on variant A of a 2-variant template bumps `updated_at` on variant B and emits `product.updated` for both ids.
8. Response echoes merged `nameTranslations`.
9. Reindex failure is swallowed (mock `indexProducts` to throw) → PATCH still `200`, warning logged.
10. Capability: `version===2`, `canEditDisplayName===true` for OWNER/MANAGER, STAFF PATCH → 403.
11. **Regression:** a freshly created order line still snapshots base `name` (assert a translations edit does not change `b2b_order_items.product_name` / `order_items.product_name`).
12. Salon isolation: cannot PATCH another salon's variant.

## 4. Rollout / verify (Netcup → Contabo)
1. `npx jest product-admin` green on Netcup.
2. Build dist on Netcup; deploy dist to Contabo (`deploy-contabo`).
3. On Contabo verify: `GET …/product-admin/capabilities` → `{version:2, canEditDisplayName:true,…}`; PATCH a test variant `{nameTranslations:{vi:"x"}}` → 200, `name_translations.vi="x"`, canonical `name` unchanged; `public/products?since=` re-emits the row; health endpoints green.
4. Smoke: confirm fiscal/order snapshot still prints canonical `name`.

## 5. Acceptance criteria (P1 done when)
- PATCH persists per-locale merged translations to `products.name_translations`, never altering `name`.
- Concurrent same-template edits do not lose updates (atomic `||`).
- All sibling variants re-emit on the incremental feed + get a `product.updated` event.
- Capability `version:2` + `canEditDisplayName` live on Contabo.
- Reindex is async/non-fatal; tests 1–12 pass; no regression to invoices/orders/fiscal.

## 6. Out of scope (P1)
Canonical-name editing (A.1.c = NO), storefront `product_translations` mirroring (A.1.b = NO), per-variant `name_translations` column (Phase 2), any app/UI change (that is **P2**).
