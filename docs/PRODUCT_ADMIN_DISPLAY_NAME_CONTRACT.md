# Product Admin — Display Name (per-language) Contract & Plan

> **Investigation + plan only. No code, schema, migration, commit or deploy.**
> **Status: app-bot reviewed 2026-06-30 — 3 open questions LOCKED + 5 hardening points resolved (see §A). Ready to split into two implementation plans (backend first, app second). NOT yet implemented.**
>
> Scope: let the POS-zira **Products tab → Edit product** flow edit a product's
> **per-language display name** (`name_translations`) *without* corrupting the
> canonical `name` used by invoices, fiscal receipts, orders, storefront and SQL search.

- **Backend repo:** `/var/www/www/enail` (this repo) — **Branch:** `feat/product-admin-create-product`
- **Desktop repo (NOT modified):** `winpc` (`DESKTOP-50SCDJT`) → `C:\POS-zira` (Electron; `src/{main,preload,renderer,shared}`)
- **Sibling doc:** [`PRODUCT_ADMIN_CREATE_CONTRACT.md`](./PRODUCT_ADMIN_CREATE_CONTRACT.md) (same endpoint family)
- **Sample row used throughout:** barcode `2653599000036`, `name = "Đầu vai giòn"`,
  `nameTranslations = {"en":"Pork Shoulder","pl":"Karkówka","vi":"Đầu vai"}` (a chesaigon product — `26535…` is chesaigon's internal EAN-13 prefix).

---

## 0. TL;DR

**VI:** App hiện chỉ sửa được **tên gốc/canonical** (`name`) — ô trong form Edit đúng nghĩa là *"Canonical name"*. **Tên hiển thị theo ngôn ngữ** (`name_translations`, ví dụ `.vi`) là thứ POS *render* ra thẻ/giỏ/biên lai paper, nhưng app **không có ô sửa** và backend **chặn** (HTTP 400) nếu gửi `nameTranslations`. Sửa `name_translations` **không** ảnh hưởng hóa đơn / fiscal / đơn cũ / storefront (tất cả đều snapshot hoặc đọc `name`); chỉ ảnh hưởng tìm-kiếm-theo-bản-dịch (Meilisearch, sau reindex) và dòng `.pl` trên tem nhãn. Vì vậy thêm tên hiển thị là **an toàn** nếu giữ nguyên `name`.

**EN:** Today the app can only edit the **canonical `name`** (the Edit field is literally labelled *"Canonical name"*). The **per-language display name** (`name_translations`, e.g. `.vi`) is what the POS renders on cards, cart rows and paper receipts, but the app has **no field for it** and the backend **rejects it (HTTP 400)** if sent. Editing `name_translations` is **inert** for invoices / fiscal / past orders / storefront (all snapshot or read `name`); it only affects translated-term search (Meilisearch, after reindex) and the **`.pl` line on the shelf label**. So adding a display-name editor is **safe** as long as canonical `name` is left untouched.

### The reported gap

| Symptom | Real cause | Side to fix |
|---|---|---|
| "App chỉ sửa được `name`, không sửa được tên hiển thị" | `ProductEditForm.tsx` has one name input labelled **Canonical name**; the write types `ProductAdminUpdateVariantInput` / `ProductAdminCreateProductInput` carry **no** `nameTranslations` field; the backend `UpdateProductAdminVariantDto` does not whitelist it; global `ValidationPipe({forbidNonWhitelisted:true})` → **400** if sent. | **Both** — backend must accept+persist `nameTranslations` (merge into the template); app must add a per-language editor + send it. |
| "POS hiện 'Đầu vai' nhưng form sửa lại là 'Đầu vai giòn'" (name mismatch) | POS renders `name_translations.vi` ("Đầu vai") via `resolveName`, but the edit form shows/edits canonical `name` ("Đầu vai giòn"). Cashier cannot reconcile the displayed name. | **App UX** (surface both); **backend** (let display name be edited). |

**Principle upheld (already documented in the app):** `name` is canonical — order lines & fiscal payloads MUST keep this exact string; `name_translations` is *localized display data only* with fallback to `name`. Source: `C:\POS-zira\src\shared\catalog-names.ts:3-9`.

---

## A. Review outcome — LOCKED decisions & hardening (app-bot review, 2026-06-30)

> This section is **authoritative** and supersedes any earlier wording in §5/§6 where they differ. It records what the POS-zira app bot reviewed and the points that must be in the contract **before** it is split into two implementation plans.

### A.1 Three open questions — LOCKED

| # | Question | Decision | Rationale |
|---|---|---|---|
| a | Translations stored at **template-level**? | ✅ **YES** | Fits the schema (`name_translations` exists only on `products`) and the current ADR. No per-variant column; no migration. |
| b | Mirror to **web storefront** localized title? | ❌ **NO — out of scope** | Storefront uses the separate `product_translations` table (§4.6). A future Phase 2 sync, not this contract. |
| c | Also let the app edit the **canonical template name**? | ❌ **NO** | Keep current behavior (update only backfills an empty `template.name`, §3). The app only **relabels** its existing field for clarity. Canonical edits affect future invoices/orders/storefront and are deliberately excluded. |

### A.2 Five hardening points — resolved specs (must be in the contract)

**(1) Template-level write is a documented, intended behavior.**
Because `name_translations` lives on `products` (the template), editing it via **any** variant of that template changes the display name for **all variants of that template**. This is accepted (decision A.1.a). Requirements:
- The app UI must state this explicitly when a template has > 1 variant (e.g. *"Display name applies to all variants of this product"*).
- For the current POS catalogs (1 template : 1 variant — chesaigon/KaiPizz) this is effectively per-product and invisible.

**(2) Concurrency — atomic JSONB merge, NOT read-modify-write.** *(verified: no `@VersionColumn` exists on `products` or `product_variants`; concurrency today is only `assertNotStale(variant.updatedAt, dto.expectedUpdatedAt)` → `409 STALE_PRODUCT`, `product-admin.service.ts:727`. The existing `updateVariant` mutates `variant.template` in memory and `save()`s it — two variants of the same template would lose-update each other's translations.)*
- The translations merge MUST be a **single atomic SQL statement on the template row**, not an entity read-modify-write:
  ```sql
  UPDATE products
     SET name_translations = (COALESCE(name_translations,'{}'::jsonb) || $patch::jsonb) - $keysToDelete::text[],
         updated_at = now()
   WHERE id = $templateId AND salon_id = $salonId;
  ```
  `||` merges server-side (last value per key wins **per key**, not whole-object), so two concurrent writers touching **different** locales both survive; touching the **same** locale is a deterministic last-write-wins on that key only. `$keysToDelete` = locales whose incoming value was empty/null.
- The **variant-field** part of the same PATCH keeps the existing `assertNotStale(variant.updatedAt, expectedUpdatedAt)` optimistic guard (unchanged). A `nameTranslations`-only PATCH does **not** require `expectedUpdatedAt` to match for the merge to be safe (the `||` is race-free), but the endpoint still honors `expectedUpdatedAt` if sent.
- **No template version column is added** (decision: atomic JSONB is sufficient; a `@VersionColumn` on `products` is the documented *alternative* if a future requirement needs whole-object optimistic locking).

**(3) Sync must propagate to ALL variants sharing the template.** *(verified: the `product.updated` emitter sends only the single PATCHed `variantId` — `product-admin.service.ts:780-800`; the sync listener writes one outbox row for that id — `sync/services/sync-event-listener.ts:170-187`; the app pulls **incrementally** via `GET /warehouse/public/products?since=…` — `api-client.ts:getPosProducts`.)*
- After the merge, the backend MUST, in/after the same transaction:
  1. `UPDATE product_variants SET updated_at = now() WHERE template_id = $templateId AND salon_id = $salonId;` — so the incremental `since` feed re-emits **every** sibling variant with the new `template.name_translations`.
  2. Emit `product.updated` (sync outbox) for **each** sibling variant id, not only the PATCHed one — so a connected POS gets a push for all of them.
- For 1 template : 1 variant this is exactly the one variant (already covered). The requirement exists so multi-variant templates never show a half-updated catalog.

**(4) Meilisearch reindex — asynchronous, best-effort, non-fatal.** *(verified: product-admin does NOT reindex today — the `product.updated` listener only writes the sync outbox; reindex is `ProductSearchService.indexProduct/indexProducts/reindexSalon` calling `index.addDocuments`, `product-search.service.ts:363-459`, with no Bull queue.)*
- On a translations change, after the DB transaction **commits**, trigger `indexProducts([affected variant ids])` **fire-and-forget** (not awaited in the request path), wrapped in try/catch.
- **Reindex failure MUST NOT fail the PATCH** — the jsonb is already persisted; search is eventually consistent. Failures are logged (greppable) and retried by the existing periodic/manual `reindexSalon` backstop.
- Meili itself is eventually-consistent server-side, so "synchronous vs async" is moot for the client; we choose **async fire-and-forget after commit** to keep PATCH latency flat.

**(5) Capability version + old-backend fallback.**
- Backend bumps `ProductAdminCapabilities.version` **1 → 2** (currently `version: 1`, `product-admin.service.ts:93`) and adds **`canEditDisplayName: <true for OWNER|MANAGER>`**.
- **App fallback (mandatory):** if `version < 2` **OR** `canEditDisplayName !== true` (including the field being absent on an old backend), the app **hides the display-name editor AND never sends `nameTranslations`**. Sending it to an old backend triggers `400` (`forbidNonWhitelisted`), so the gate is a hard requirement, not cosmetic.

### A.3 Next step (locked sequence)

1. Backend folds A.1–A.2 into this contract (done in this revision). →
2. Two **separate** implementation plans, in order: **(P1) Backend** — `PRODUCT_ADMIN_DISPLAY_NAME_PLAN_BACKEND.md`; then **(P2) App** — `PRODUCT_ADMIN_DISPLAY_NAME_PLAN_APP.md`. Backend ships + verifies first; the app plan starts only after the backend capability (`version:2`, `canEditDisplayName`) is live.

---

## 1. Ownership map — there are **four** name-ish fields

Verified against current entities on branch `feat/product-admin-create-product`.

| Field | Table / entity | Column | Type / scope | Role | Edited by app today? |
|---|---|---|---|---|---|
| **Canonical (template)** | `products` → `new-system/product.entity.ts:154-155` (class `Product`, alias `ProductTemplateNew`) | `name` | `varchar(255) NOT NULL`, per-salon (`salon_id` `:131-132`) | Canonical name; CREATE writes it here. | ✅ via create; backfill-only on update |
| **Canonical (variant)** | `product_variants` → `new-system/product-variant.entity.ts:139-140` | `name` | `varchar(255) NULLABLE` (NULL = inherit template), per-salon (`salon_id` `:88-89`) | Canonical name actually snapshotted by POS orders. | ✅ `PATCH /variants/:id` sets it every time |
| **Variant single-string display** | `product_variants` → `product-variant.entity.ts:143-149` | `display_name` | `varchar(255) NULLABLE` | A *single* (not per-locale) display override. **Nothing in product-admin writes it**, but `mapVariant` *reads* it first (see §3). Latent. | ❌ never written |
| **Per-language display overlay** | `products` (template) → `product.entity.ts:248-253` | `name_translations` | `jsonb NOT NULL DEFAULT '{}'::jsonb`, `Record<string,string>`, per-salon | **The per-language display name the POS renders.** This is the target of this contract. | ❌ **no write path; sent → 400** |

Key facts:
- **`name_translations` lives ONLY on the template (`products`)** — there is **no** `name_translations` column on `product_variants` (confirmed: no entity field, no migration). Column added by `migrations/2118600000000-AddNameTranslationsToProducts.ts:9-12`.
- The table named **`products` today IS the former `product_templates_new`** (renamed; the old legacy `products` table was **dropped**). `product_variants.template_id → products.id` (`product-variant.entity.ts:95-100`). So there is exactly **one** live template table and **one** live variant table.
- `categories.name_translations` exists too (`category.entity.ts:54-55`) — same jsonb pattern.
- ⚠️ **A second, unrelated localization mechanism exists:** relational table **`product_translations`** (`new-system/product-translation.entity.ts:26,57`, column `product_name`), wired via `Product.translations`. **This is what the b2c/b2b storefront serves as localized titles — NOT `name_translations`.** Editing `name_translations` does not touch it (see §4.6). This is the single most important "gotcha" for the app bot.

---

## 2. How the display name is resolved (read path)

1. **App render:** `resolveName(row, lang)` returns `name_translations[lang]` if present & non-empty, else canonical `name`. Both `name_translations` and `nameTranslations` keys accepted; values lower-cased, empties dropped. Source: `C:\POS-zira\src\shared\catalog-names.ts:28-72`.
2. **App sync source:** `GET /api/v1/warehouse/public/products` (paginated 100/page) → `api-client.ts:1683,1713`. Each row's translations come from
   `item.nameTranslations ?? item.name_translations ?? item.template?.nameTranslations ?? item.template?.name_translations` (`api-client.ts:~1888`). Because the variant has no translations column, this resolves to **`template.name_translations`** today. (Comment in code: *"Product display name follows the template's translations (Phase 1 scope — variant-specific translations are deferred). Variant-level overrides land later."*)
3. **Backend feed shape:** `pos-public.controller.ts:95 @Get("public/products")` → `enrichForPos(v)` returns `{ ...v, ... }` (`:199,:258`), spreading the variant **and its nested `template`** (which carries `name_translations`). ✔ The feed already ships per-product translations.
4. **App-side "poison guard"** (`api-client.ts:1944-1975`): the app **drops any `name_translations` JSON byte-identical across products with *different* canonical `name`s**, falling back to canonical. This was a defense against the old clone-smear bug (one shared `{en:Okra…}` block on many products). Comment: *"Backend must regenerate per-product translations; remove this guard once that lands."*
   - **Contract implication:** the edit endpoint writes one product at a time, so it never *creates* a shared block — the guard will not fight a legitimate single-product edit. But see the multi-variant caveat in §6, Decision 1.

---

## 3. Why the app can only edit `name` today (proof)

**App side**
- `ProductEditForm.tsx` has exactly one name input, state `const [name,setName]=useState(product.name||'')` (`:93`), label `products.drawer.canonicalName` → **"Canonical name"** (`:270`). There is **no** per-language field.
- The save payload `ProductAdminUpdateVariantInput` (`ProductEditForm.tsx:179-191`) = `{ name, barcode, sku, priceGrossGrosze, vatRate, categoryId, saleUnit, sellBy, imageUrl, isActive, expectedUpdatedAt }`. **No `nameTranslations`.**
- The write types omit it entirely: `ProductAdminCreateProductInput` (`shared/types.ts:2968-2980`) and `ProductAdminUpdateVariantInput` (`:2982-2996`) have no `nameTranslations`. (The **read** type `ProductAdminVariant:2950` *does* declare `nameTranslations?` — but see below, the backend never populates it.)
- A full renderer grep found **no** translation-edit UI anywhere under `renderer/components/products/`.

**Backend side**
- `UpdateProductAdminVariantDto` (`product-admin.dto.ts:37-112`) declares only `name?` (`:38-42`, `@MaxLength(255)`) among name fields — **no `nameTranslations`/`name_translations`.**
- `ProductAdminService.updateVariant` (`product-admin.service.ts:110-189`) sets `variant.name = dto.name` always (`:139`), and `template.name = dto.name` **only if `!template.name`** (backfill-only, `:174`) — so canonical names can diverge after a rename. It **never** assigns `nameTranslations` to either row.
- `CreateProductAdminProductDto` (`product-admin.dto.ts:174-240`) omits it; `createProduct` (`service:419-446`) writes `name` to template + variant and leaves `products.name_translations` at the DB default `'{}'`.
- Global pipe `ValidationPipe({ whitelist:true, forbidNonWhitelisted:true })` (`main.ts:201-204`) → a request carrying `nameTranslations` is **rejected with HTTP 400** ("property nameTranslations should not exist"), *not* silently dropped.
- **Mutation response gap:** `mapVariant` (`service:940-964`) returns `name: v.displayName || v.name || v.template?.name` (`:949`) and **omits `nameTranslations`**. So even the read model the app gets back from a mutation never echoes translations — the app only ever learns them from the separate public sync feed.

**The only path that persists `name_translations`** is the **legacy** quick-add upsert (`warehouse/services/product-quick-add.service.ts`): create branch `nameTranslations: dto.nameTranslations || {}` (`:2288`) and update branch **merge** `{ ...(product.nameTranslations||{}), ...dto.nameTranslations }` (`:2095-2098`). Endpoint `POST /warehouse/quick-add/create` — a **different controller** the POS-zira product-admin flow does **not** call. (This is the merge pattern we should mirror; see §5.)

**Conclusion:** *Can the current product-admin endpoints persist `nameTranslations`?* **No** — not on CREATE, not on UPDATE; sending it returns 400.

---

## 4. Impact analysis — what an edit to each field touches

The decisive question: *does editing `name_translations` change any already-issued invoice, past order, or fiscal print?* **No.** Every transactional/fiscal/accounting consumer **snapshots base `name`** at transaction time and never reads `name_translations`.

| # | Consumer | Field read | Snapshot/Live | Edit `name_translations`? | Edit base `name`? |
|---|---|---|---|---|---|
| 1 | Invoices / KSeF / JPK / proformas — `invoice_items.name` (`invoice-item.entity.ts:25-27`), `proforma_items.name` (`proforma-item.entity.ts:11-13`); filled from `orderItem.productName` (`invoice.service.ts:673,959,1172,1335`) or operator DTO (`:557`); emitted `<P_7>${item.name}` (`ksef-xml-builder.service.ts:85`, `jpk-fa.service.ts:246`, `jpk-zakup.service.ts:230`), PDFs (`invoice-pdf.service.ts:408`, `proforma-pdf.service.ts:426`) | base `name` lineage | **SNAPSHOT** | **No** — never read | No effect on issued docs; only *future* invoices snapshot the new `name` |
| 2 | B2B POS order lines — `b2b_order_items.product_name` ("snapshot in case product name changes", `b2b-order-item.entity.ts:182-186`); filled `product.name`/`template.name` (`b2b-pos.service.ts:2450,2526,2670,3748`) | base `name` | **SNAPSHOT** | **No** | No effect on past orders |
| 3 | Ecommerce order lines — `order_items.product_name` (`order-item.entity.ts:80-83`); filled `product.name`/`variant.name` (`order.service.ts:523,533`) | base `name` | **SNAPSHOT** | **No** | No effect on past orders |
| 4 | **Fiscal printer** (receipt line name) — reads order-line snapshot `item.productName` (`order.service.ts:3372-3373` → printer `:3399-3405`; B2B sends `fullOrder.items[].productName`); `ReceiptItemDto.name` max 40 chars Posnet (`print-job.dto.ts:31-34`); `fiscal-receipt.service.ts` stores **no item names** | base `name` snapshot | **SNAPSHOT** (no live re-read) | **No** | No (prints the snapshot) |
| 4b | Shelf/info **LABEL** (not a receipt) — `nameTranslations?.pl?.trim() || name` (`product-quick-add.service.ts:3352-3354`) | `name_translations.pl` w/ fallback | **LIVE** at print | Only if **`.pl`** edited; **`.vi` has no effect** | Yes (fallback when no `.pl`) |
| 5a | **Meilisearch** — indexes `name` + `name_pl/en/vi/...` from `nameTranslations` (`product-search.service.ts:44-52`, searchable `:183-191`) | both | **LIVE** (reindex) | **Yes** — translated-term hits update after reindex (this is the *intended* upside) | Yes |
| 5b | POS / admin / storefront **SQL search** — `LOWER(template.name) LIKE` (`b2b-product.service.ts:138`), `variant.name ILIKE` (`product.service.ts:146`), `p.name ILIKE` (`storefront-product.service.ts:88`) | canonical `name` | LIVE | No | Yes |
| 6 | **Storefront title** (GraphQL) — `name: product.name` (`product.resolver.ts:676`), `variant.name||template.name` (`b2b-storefront.service.ts:611`) | canonical `name` | LIVE | **No** | Yes |
| 6b | **Storefront localized title** — separate `product_translations.product_name` table (`product.resolver.ts:372-401`, `translation.service.ts:257`) | **different table** | LIVE | **No** (zero refs to `name_translations` under `storefront-api`) | No |

**Decisive answers**
- *Editing only `name_translations` → already-issued invoice / past order / fiscal print?* **None changed.** All are snapshots of `name`; none read `name_translations`.
- *Is base `name` safe to leave untouched while only `name_translations` changes?* **Yes — that is exactly the correct design.** Sole observable effects: Meilisearch translated-term search (after reindex), and the label's `.pl` line if `.pl` is edited.
- *Cross-salon?* No risk — `name_translations` is on a per-salon (`salon_id NOT NULL`) row and the endpoint scopes every query by `salonId` from the JWT.
- ⚠️ *Storefront surprise to flag:* editing the POS "display name" (`name_translations`) will **not** change the **web storefront** title (which uses `product.name` + the separate `product_translations` table). If salons expect web + POS display names to match, that's a **Phase 2** sync, out of scope here.

---

## 5. Proposed minimal contract (for review)

Reuse the endpoint the app already calls. **Do not** introduce a new route.

```
PATCH /api/v1/warehouse/product-admin/variants/:variantId
```

- Controller/Service/DTO: `product-admin.controller.ts` (`updateVariant`), `product-admin.service.ts` (`updateVariant`), `product-admin.dto.ts` (`UpdateProductAdminVariantDto`).
- Guards unchanged: `JwtAuthGuard + RolesGuard`, `@Roles(OWNER, MANAGER)`; `salonId` from JWT, never the body.
- Headers unchanged (see sibling create doc §2).

### 5.1 Request — add one field

| Field | Type | Req | Rules |
|---|---|---|---|
| `nameTranslations` | `Record<string,string>` | No | Object only (not array). Keys = supported locale codes, lower-cased: **`pl,en,de,uk,vi,ru,zh,tr`**. Values: string, trimmed, `MaxLength(255)`. **Empty string / null value = delete that locale key.** Max 16 keys. |

All existing fields stay as-is (`name?`, `barcode?`, …). `nameTranslations` is **independent of `name`** — supplying one never implies the other.

Example (set/repair the VI display name, leave canonical & other locales intact):
```json
{ "nameTranslations": { "vi": "Đầu vai" }, "expectedUpdatedAt": "2026-06-30T10:00:00.000Z" }
```

### 5.2 Merge semantics (mirror legacy quick-add `:2095-2098`)

```
template.name_translations = stripEmpty({ ...(template.name_translations ?? {}), ...incoming })
```
- **Per-locale MERGE**, not replace — editing `vi` must not wipe `pl`/`en`.
- A locale whose incoming value is `""`/`null` is **removed** (so it falls back to canonical again).
- After merge, drop empty values (matches the app's `parseTranslations`/`encodeTranslations`, which discard empties) so the stored jsonb stays clean.
- **`name` (template & variant) is never modified by a `nameTranslations` edit.**

### 5.3 Write target & concurrency

- Write to **`variant.template.name_translations`** (the template the `:variantId` belongs to). `updateVariant` already loads `variant.template` and writes other template fields (`taxRate`, `categoryId`), so the precedent exists.
- **Concurrency:** reuse `expectedUpdatedAt`/`expectedVersion` → `STALE_PRODUCT` on mismatch (existing behavior).
- ⚠️ **Touch the variant:** the app's optimistic token is the **variant's** `updatedAt`, but a translations edit changes the **template** row. The service MUST also bump `variant.updatedAt` (save the variant, even when only translations changed) so the app's next `expectedUpdatedAt` stays valid and the public feed re-emits the row.

### 5.4 Response — echo the merged translations (close the gap)

`mapVariant` (`service:949`) currently omits translations. Add to its output:
```
nameTranslations: v.template?.nameTranslations ?? {}
```
so the app updates its local row immediately from the mutation result (no full resync needed). The read type `ProductAdminVariant.nameTranslations?` (`shared/types.ts:2950`) already exists — today it is just never populated.

### 5.5 Search reindex

If the existing `updateVariant` does **not** already enqueue a Meilisearch reindex, the translations edit should trigger one (so translated-term search reflects the change). Verify against `product-search.service.ts` wiring; reuse whatever the canonical-`name` update already does. (Functional-but-eventual; not a correctness blocker.)

### 5.6 Capability flag

Add to `ProductAdminCapabilities` (`shared/types.ts:2892`, backend `GET /warehouse/product-admin/capabilities`):
- **`canEditDisplayName: boolean`** (`true` for OWNER|MANAGER, matching `canUpdateProduct`), and **bump `version`**.
- The app shows the per-language editor **only when `canEditDisplayName === true`**, so older backends degrade gracefully (no 400s).

### 5.7 Error codes (reuse the existing envelope)

Envelope shape unchanged (`{ ok:false, error:{ code, message, field?, details? } }`, `ProductAdminErrorEnvelope` `shared/types.ts:2921`). Reuse: `STALE_PRODUCT`, `PRODUCT_NOT_FOUND`, `SALON_CONTEXT_MISMATCH`, `UNAUTHORIZED_PRODUCT_ADMIN`. Add (or map to a generic 400):

| Code | When |
|---|---|
| `INVALID_LOCALE` | a key is not in the supported locale set |
| `INVALID_TRANSLATIONS` | value not a string, > 255 chars, payload not an object, or > 16 keys |

(If we prefer not to grow the enum, return a plain `400` with `field: "nameTranslations"`; the app already surfaces `error.message`.)

### 5.8 (Optional) CREATE parity

Mirror the same field on `CreateProductAdminProductDto` so a product can be born with display names (validation identical; stored verbatim into `products.name_translations`). Optional — the edit path is the priority.

---

## 6. Trade-offs

**Decision 1 — Scope of the display name: template-level vs per-variant.** → **LOCKED: template-level = YES** (see §A.1.a / §A.2.1). The text below is the original analysis; §A is authoritative.
- *Template-level (RECOMMENDED, minimal):* write to `products.name_translations`. The column only exists here; the app already reads template translations; matches today's "Phase 1" read path.
  - ✅ Zero schema change. ✅ Correct for POS 1-template:1-variant products (chesaigon, KaiPizz).
  - ⚠️ For a **multi-variant** template, all variants share one overlay. Since the app lists *variants* and the poison guard drops a translation block shared across rows with **different canonical names**, a multi-variant template with differing variant names could have its (shared) translation dropped client-side. Acceptable for the current single-variant POS catalogs; **document it**.
- *Per-variant override (Phase 2):* add `product_variants.name_translations`. Schema change + migration + read-path change. Defer until a real multi-variant naming need appears (the app sync comment already anticipates this).

**Decision 2 — Merge vs Replace.** Merge per-locale (chosen, §5.2). Replace would let a `{vi:…}`-only payload wipe `pl`/`en`. Merge matches the legacy quick-add precedent. Deletion handled via empty-value sentinel.

**Decision 3 — Reuse `PATCH /variants/:id` vs new endpoint.** Reuse (chosen). One round-trip with other edits, reuses concurrency + envelope + guards, matches the app's per-row model. `updateVariant` already writes template fields, so writing `template.name_translations` is consistent. A dedicated `/translations` route adds wiring for no benefit at this scope.

**Decision 4 — Editing canonical `name`.** Out of scope here, but note the existing **backfill-only** template-name behavior (`service:174`) means renames can leave `products.name` stale vs `product_variants.name`. If the app later wants to fix the *canonical* name too, that's a separate change (it WOULD affect future invoices/orders/storefront — by design).

---

## 7. File impact map (for the eventual implementation — not done here)

### Backend (`/var/www/www/enail/backend`)
```
MODIFY  src/modules/product-admin/dto/product-admin.dto.ts
          + nameTranslations?: Record<string,string> on UpdateProductAdminVariantDto
            (@IsOptional @IsObject + custom per-locale/value validator); optional on Create DTO.
MODIFY  src/modules/product-admin/services/product-admin.service.ts
          + updateVariant: merge into variant.template.name_translations (strip empties),
            do NOT touch name, bump variant.updatedAt, save template+variant.
          + mapVariant: add nameTranslations: v.template?.nameTranslations ?? {}.
          + capabilities(): canEditDisplayName; bump version.
          + (verify) enqueue Meilisearch reindex on translations change.
MODIFY  src/modules/product-admin/controllers/product-admin.controller.ts
          (only if capabilities() shape is built here)
TEST    src/modules/product-admin/__tests__/*  (extend existing 31-test suites)
```
**No new entity. No migration.** `products.name_translations` already exists (`jsonb NOT NULL DEFAULT '{}'`).

### App (`C:\POS-zira` — by the POS-zira bot, after review)
```
MODIFY  src/shared/types.ts
          + nameTranslations? on ProductAdminUpdateVariantInput (and Create input if used);
          + canEditDisplayName on ProductAdminCapabilities.
MODIFY  src/renderer/components/products/ProductEditForm.tsx
          + per-language display-name section (prefill from translations / resolveName),
            relabel the existing field clearly as "Canonical name (receipts/fiscal)",
            send nameTranslations only for changed locales, gate on canEditDisplayName,
            update local row from the mutation response.
MODIFY  src/main/network/api-client.ts (only if payload typing/whitelist needs it)
KEEP    the poison guard (api-client.ts:1944-1975) until per-product translations are
          verified end-to-end; a single-product edit never trips it.
```

---

## 8. Migration / backfill

- **Schema migration: NONE.** Column exists.
- **Data backfill: NOT part of this contract.** A separate, optional cleanup could align the known chesaigon mismatch (`name` ≠ `name_translations.vi`, e.g. "Đầu vai giòn" vs "Đầu vai") — but per prior incidents this is data-sensitive and historically app-driven; do it as a deliberate, backed-up DATA task on the correct DB (**Contabo** prod — the Netcup box has a stale clone), **not** bundled with the code change.

---

## 9. Tests to add (before shipping)

**Backend (unit/integration, extend `product-admin` suites):**
1. Merge keeps other locales: existing `{pl,en}` + send `{vi}` → all three present.
2. Empty/null value deletes that locale; stored object has no empty values.
3. Canonical `name` (template & variant) untouched by a `nameTranslations`-only PATCH.
4. Unknown locale key → `INVALID_LOCALE`; non-string / > 255 / non-object / > 16 keys → `INVALID_TRANSLATIONS`.
5. `nameTranslations` no longer 400s under `forbidNonWhitelisted`.
6. Salon isolation: cannot edit another salon's variant (PRODUCT_NOT_FOUND / SALON_CONTEXT_MISMATCH).
7. Concurrency: stale `expectedUpdatedAt` → `STALE_PRODUCT`; success **bumps `variant.updatedAt`** even when only translations changed.
8. Response echoes merged `nameTranslations`.
9. Roles: STAFF → 403; OWNER/MANAGER → 200. `capabilities.canEditDisplayName` reflects role.
10. **Regression:** order-item / invoice-item snapshots still read base `name` (assert a `name_translations` edit does not change a freshly-created order line's `productName`).

**App:**
1. Editor prefills from translations, sends only changed locales, gated on capability, updates local row from response.
2. Sync: an edited single-product translation survives the poison guard.

---

## 10. Backend-to-fix vs App-to-fix (the split)

**Backend MUST:**
1. Whitelist + validate `nameTranslations` on `UpdateProductAdminVariantDto` (and optionally Create).
2. `updateVariant`: per-locale **merge** into `variant.template.name_translations` (delete empties), **never** touch `name`, **bump `variant.updatedAt`**, save.
3. `mapVariant`: include `nameTranslations` in the response.
4. Add `canEditDisplayName` capability + bump `version`.
5. Ensure a Meilisearch reindex fires on the change (verify existing wiring).

**App MUST:**
1. Add per-language display-name editing UI; relabel the canonical field as receipts/fiscal-bound.
2. Add `nameTranslations` to the update input type; send only changed locales.
3. Feature-gate on `capabilities.canEditDisplayName`.
4. Apply the mutation response (`nameTranslations`) to the local row.
5. Leave the poison guard in place for now.

**Open questions for the POS-zira bot before implementation:**
- a) Confirm **template-level** display name is acceptable (all variants of a template share it). Any multi-variant catalog needing per-variant names ⇒ defer to Phase 2.
- b) Should the **web storefront** localized title (separate `product_translations` table) eventually mirror the POS display name? If yes, that's a separate Phase 2 sync, not this contract.
- c) Should the editor also expose fixing the **canonical** name on the template (today update only backfills an empty template name)? Separate decision — it *does* affect future invoices/orders/storefront.

---

## 11. Sample-row walkthrough (`2653599000036`)

Current state: `name = "Đầu vai giòn"`, `name_translations = {en:"Pork Shoulder", pl:"Karkówka", vi:"Đầu vai"}`.
- POS in VI renders **"Đầu vai"** (`resolveName` → `name_translations.vi`); a receipt/fiscal line prints **"Đầu vai giòn"** (canonical snapshot). Shelf label prints **"Karkówka"** (`.pl`).
- Cashier wants the card to read "Đầu vai giòn": `PATCH /variants/:id { nameTranslations:{ vi:"Đầu vai giòn" } }` → `name_translations.vi` updated, `pl`/`en` and canonical `name` untouched. Fiscal still prints "Đầu vai giòn". No invoice/order history changes.
- Cashier wants to drop the VI override (fall back to canonical): send `{ nameTranslations:{ vi:"" } }` → key removed → POS renders canonical "Đầu vai giòn".
- At no point does any `nameTranslations` edit alter `name`, an issued invoice, a past order line, or what the fiscal printer prints.

---

> **Status:** app-bot reviewed 2026-06-30 — decisions LOCKED + 5 hardening points folded in (§A). **No code/schema/migration/commit/deploy performed.** Next: two separate implementation plans (`PRODUCT_ADMIN_DISPLAY_NAME_PLAN_BACKEND.md` then `...PLAN_APP.md`); backend ships + verifies before the app plan starts.
