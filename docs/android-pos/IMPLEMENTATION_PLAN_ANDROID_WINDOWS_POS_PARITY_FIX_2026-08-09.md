# Implementation plan — sửa Android/Windows POS parity

Ngày: 2026-08-09
Nguồn: `docs/android-pos/REVIEW_FRONTEND_MODULE_SPLIT_2026-08-09.md`
Target branch hiện tại: `codex/android-settings-20260809`
Trạng thái: **PLAN REVISED AFTER REVIEW — chưa cho phép triển khai behavior, commit, deploy hoặc restart POS**

## 1. Goal và success criteria

Mục tiêu là giữ một cashier renderer dùng chung, sửa các divergence thật và live capability gaps mà không fork Windows/Android. Shared-renderer/shim là quyết định chủ động của parity plan (`docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md:14-20,48-64`); `POSLayout` vẫn là coordinator chung của bốn mode (`src/renderer/components/pos/POSLayout.tsx:1893-1944`).

Plan hoàn thành khi tất cả điều kiện sau đúng:

1. Android không còn tạo protected interruption cart mà cashier không thể phục hồi; mọi restored tender đi qua durable anti-duplicate boundary và uncertain reconciliation.
2. `pos.loyalty.lookupCustomer` chạy bằng staff JWT trên Android, có typed response/error mapping và không còn waiver surface.
3. UI thu ngân fail-closed theo một capability manifest rõ ràng; không còn customer-display success giả, Camera/Quick Add/Pickup/Label affordance chết, hoặc Android mount Electron-only `<webview>`.
4. Android Settings chỉ cho chọn `en/vi/tr/zh/uk/ru/pl`; năm setting thiết bị không có Android consumer không còn giả vờ là control hoạt động.
5. Android cashier và Bi-a có zero Chromium-83 CSS findings; strict CSS guard nằm trong Android verification gate.
6. Windows và Android dùng cùng POS font metrics; Pay và các action cốt lõi nhìn thấy/nhấn được ở Windows 800×600, 1024×768 và Android 1336×736.
7. Có authenticated visual harness cho Retail, Salon, Payment, Order History, Bi-a và Settings; login-only smoke vẫn được giữ riêng.
8. Sau correctness/parity, `POSLayout` được tách nội bộ theo feature hook/layer mà không đổi lifecycle, cart, modal hoặc callback semantics.
9. Không có production deploy, Play/R2 publish, database migration, Chesaigon restart hoặc live payment trong implementation branch.

## 2. Model routing

Không dùng một model chạy YOLO toàn plan. Money path, shared live Windows till và 390 CSS findings tạo ba loại rủi ro khác nhau; chạy theo packet với review gate là bắt buộc.

| Vai trò | Model | Reasoning | Được giao |
|---|---|---|---|
| Architecture/money-path owner | `gpt-5.6-sol` | `xhigh` | Protected cart, restored tender, capability contract, cross-platform invariants, final acceptance |
| Independent money-path reviewer | `gpt-5.5` | `xhigh` | Adversarial crash/idempotency/auth/tenant review; không tự sửa cùng packet |
| Typed implementation/test owner | `gpt-5.6-terra` | `high` | Settings, loyalty transport, capability consumers, test harness, build integration |
| Mechanical inventory/editor | `gpt-5.6-luna` | `high` | Chỉ liệt kê/sửa nhóm CSS đơn giản đã khóa file; không quyết định layout/payment, không approve diff |
| Visual/dual-host reviewer | `gpt-5.6-sol` hoặc `gpt-5.6-terra` | `high` | Screenshot comparison, responsive assertions, Windows + SUNMI acceptance |

Nếu chạy qua skill `codex-spark-plan`, dùng **chunked mode**, một packet/lần và xin approval trước khi launch write-capable Codex. Không dùng full-plan YOLO cho W0/W5 money path hoặc shared CSS; skill cũng yêu cầu explicit launch approval và để changes uncommitted.

## 3. Branch/worktree và execution protocol

1. Không triển khai trong `/var/www/pos-zira` đang ở branch khác và có user WIP.
2. Worktree plan hiện có local review changes chưa nằm trên `origin/codex/android-settings-20260809`. Vì vậy **không** được tạo worktree mới trực tiếp từ remote ref đó: làm vậy sẽ bỏ mất plan, review và các comment correction đã kiểm chứng.
3. Sau khi owner duyệt plan, supervisor phải review current diff, tạo một baseline commit chỉ chứa các doc/comment changes đã duyệt, rồi ghi exact `BASELINE_SHA`. Nếu owner chưa cho phép commit, dừng ở plan phase; không dùng patch ngầm hoặc copy WIP sang run directory.
4. Tạo isolated worktree/feature branch `codex/android-pos-parity-fixes-20260809` từ exact `BASELINE_SHA`, rồi xác minh plan file và review file có cùng blob SHA-256 với worktree nguồn trước khi sửa behavior.
5. Mỗi executable packet có exact file allowlist. Umbrella group như W4/W9 không được launch; chỉ sub-packet có danh sách file cụ thể mới được giao executor. Nếu cần file ngoài allowlist, executor dừng với `NEED CLARIFICATION`; không tự mở rộng scope.
6. Executor không chạy `git add`, `git commit`, `git reset --hard`, `git checkout .`, `git restore .` hoặc `git clean`. Supervisor review diff/test rồi mới quyết định commit riêng từng packet.
7. Packet không được trộn refactor với behavior/money fix. Mỗi packet phải có before/after evidence và rollback bằng revert commit, không bằng manual DB mutation.
8. Không build/test trên máy Chesaigon live trong các packet code. Trước mọi restart/update live POS phải xác nhận counter idle và xin confirmation riêng theo repo instructions.

Baseline gate:

```bash
git status --short --branch
git rev-parse HEAD
sha256sum \
  docs/android-pos/IMPLEMENTATION_PLAN_ANDROID_WINDOWS_POS_PARITY_FIX_2026-08-09.md \
  docs/android-pos/REVIEW_FRONTEND_MODULE_SPLIT_2026-08-09.md
```

Handoff phải ghi `BASELINE_SHA`, hai document SHA-256 và output `git status`; thiếu một trong ba thì không launch packet.

## 4. Dependency graph

```text
Baseline SHA gate
 ├─ W0 stranded-cart containment
 ├─ W1a contract -> W1b lifecycle -> W1c consumer gates
 │                    ├─ W3 loyalty lookup
 │                    └─ W4a containment -> W4b native product create
 ├─ W2 Settings contract
 └─ W6 authenticated visual harness + chrome83 targets
      └─ W7 shared POS font
           └─ W8 core cashier CSS
                └─ W9 Billiard + remaining CSS + strict gate

W0 + W1c ── W5 full restored-cart tender wave

W1c + W2 + W3 + W4a + W4b + W5 + W9 green
 └─ W10 POSLayout internal split
```

W0, W2 và W6 có thể được chuẩn bị song song sau baseline gate vì file sets gần như độc lập, nhưng P0 W0 được review/merge trước behavior khác. W3/W4/W5 không chạy song song nếu cùng chạm `shim/index.ts`, `real-transport.ts`, `AndroidBootApp.tsx` hoặc `POSLayout.tsx`. W4c là optional design amendment, không block W4 release khi Android action đã fail closed.

## 5. Work packets

### W0 — contain protected cart bị kẹt

**Ưu tiên:** P0, làm đầu tiên
**Owner:** `gpt-5.6-sol xhigh`
**Reviewer:** `gpt-5.5 xhigh`

#### Problem đã kiểm chứng

Android `prepare()` hiện park cart thường thành protected hold (`tests/android-billiard-handoff.test.ts:318-337`). Sau payment, `complete()` nói cart còn trong Holds để recall (`src/renderer/android-pos/shim/billiard-handoff.ts:721-735`), nhưng Android `hold.list()` lọc protected rows, `hold.get()` trả `null`, và `hold.recall()` từ chối chúng (`src/renderer/android-pos/shim/hold-orders.ts:164-169,235-257`). Cart vì vậy có thể nằm trong Android local DB nhưng không có UI/API phục hồi.

#### Change

- Trước full restored-cart wave, Android `prepare()` phải từ chối new Billiard handoff nếu live ordinary cart còn items; message yêu cầu cashier Hold cart thủ công trước.
- Resume cùng checkout ID vẫn được phép nếu active/frozen identity khớp.
- Boot diagnostics phải phát hiện protected interruption row orphaned/legacy và báo “recovery required”; tuyệt đối không auto-delete, unprotect hoặc list như manual hold.
- Sửa test đang khẳng định stranded behavior thành test fail-closed containment.

#### Executable sub-packets và exact allowlist

**W0a — refuse new stranded-cart creation**

- `src/renderer/android-pos/shim/billiard-handoff.ts`
- `tests/android-billiard-handoff.test.ts`

**W0b — boot diagnostic for legacy protected rows**

- `src/renderer/android-pos/shim/billiard-handoff.ts`
- `src/renderer/android-pos/AndroidBootApp.tsx`
- `tests/android-billiard-boot.test.tsx`

W0a phải review trước W0b. W0b không mutate legacy row; chỉ surface durable recovery-required state.

#### Tests/gates

```bash
npx vitest run tests/android-billiard-handoff.test.ts tests/android-billiard-boot.test.tsx
npm run test:android:parity
npm run typecheck:renderer
```

#### Hard stop

- Cần mutate/xóa protected rows cũ mà chưa có verifier.
- Không phân biệt chắc legacy protected row với manual hold.
- Refusal xảy ra sau khi journal/hold đã được ghi.

### W1 — versioned cashier capability manifest

**Owner:** `gpt-5.6-sol high`
**Implementation:** `gpt-5.6-terra high`

#### Change

Tạo một manifest typed, versioned, mỗi outcome có `supported | unsupported | degraded` và reason code. Tách ba trục độc lập:

1. platform/runtime capability;
2. salon config;
3. entitlement/role.

Initial outcomes:

- `loyaltyLookup`
- `restoredCartTender`
- `customerDisplay`
- `nativeProductCreate`
- `debtLedgerExternal`
- `quickAddRecognition`
- `pickupOrders`
- `labelPrint`
- `scale`

Manifest chỉ quyết định renderer affordance; không thay backend authorization/security. Unknown/error phải fail closed. Name parity không đủ vì parity guard chỉ kiểm function names (`tests/android-preload-surface-parity.test.ts:23-28`), còn Android window stub hiện trả success giả (`src/renderer/android-pos/shim/stubs.ts:702-710`).

Lifecycle invariant:

- Manifest instance phải bind vào `salonId + userId + registerId + authEpoch`; không được dùng kết quả của session trước.
- Login/logout, auth expiry, đổi salon/register, role, entitlement hoặc relevant config phải lập tức đưa affected outcome về `unsupported/unknown` trước khi recompute.
- Platform capability là host-owned input; salon config và entitlement/role là inputs riêng. Không suy ra `supported` chỉ vì function tồn tại trên `window.electronAPI`.
- W1 không thêm IPC/preload/main-process surface. Nếu một capability thật sự cần Windows main cung cấp dynamic state chưa có trên bridge, dừng và viết W1d riêng với exact contract/files/tests.

#### Executable sub-packets và exact allowlist

**W1a — pure contract/defaults**

- New `src/shared/pos/cashier-capabilities.ts`
- New `tests/pos-capability-manifest.test.ts`

**W1b — host lifecycle/provider**

- New `src/renderer/components/pos/capabilities/PosCapabilityProvider.tsx`
- `src/renderer/components/pos/POSLayout.tsx`
- `src/renderer/windows/pos/POSApp.tsx`
- `src/renderer/App.tsx`
- `src/renderer/android-pos/AndroidBootApp.tsx`
- `tests/android-shell-props-parity.test.tsx`
- New `tests/pos-capability-lifecycle.test.tsx`

**W1c — first consumer gating**

- `src/renderer/components/pos/POSLayout.tsx`
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx`
- `src/renderer/components/pos/templates/retail/QuickActions.tsx`
- `src/renderer/components/pos/PaymentModal.tsx`
- New `tests/android-pos-capability-ui.test.tsx`

W1a, W1b và W1c là ba review/commit boundaries riêng. Không chạm `src/shared/electron.d.ts`, preload, `src/main/modules/pos.module.ts` hoặc Android transport trong W1a-c.

#### Tests/gates

- Unknown manifest version/state fails closed.
- Unsupported action không gọi bridge.
- Windows default capabilities phản ánh behavior thật; Android không được “supported vì method tồn tại”.
- Auth/session/config/entitlement transition reset capability trước khi recompute; stale async result có wrong `authEpoch` bị bỏ.
- `npm run test:android:parity`, renderer typecheck, Android source/bundle boundary.

#### Hard stop

- Manifest chứa pricing/auth business rules.
- Default là supported khi load fail.
- Capability provider remount cashier/cart tree.
- Capability của user/salon/register cũ còn visible sau auth epoch change.

### W2 — Android Settings language và device controls

**Policy:** `gpt-5.6-sol high`
**Implementation:** `gpt-5.6-terra high`

#### Change

- Dùng canonical `Language = en|vi|tr|zh|uk|ru|pl` từ `src/renderer/i18n/translations.ts:3-13`; bỏ `de/cs/sk`, thêm `tr/zh/ru` trong Settings và remote settings patch.
- Existing persisted `de/cs/sk` được normalize một lần sang `en`, vì runtime hiện cũng rơi về English cho unknown language. Migration chỉ ghi local config, không phát remote settings patch/event; lần load sau phải idempotent.
- Không xóa persisted/remote keys `customerDisplayEnabled`, `selfCheckoutEnabled`, `kitchenSelfOrderEnabled`, `tvAdEnabled`, `remoteAccessEnabled` vì có thể là protocol compatibility.
- Bỏ năm interactive toggle khỏi tablet UI hoặc render read-only với label “Managed on Windows / unsupported on this device”. Không được ghi value khi user tương tác Android.
- Giữ `posMode`, language, oversell, non-fiscal và identity/version/network settings.

#### File allowlist

- `src/renderer/android-pos/SettingsScreen.tsx`
- `src/renderer/android-pos/shim/config-store.ts`
- `src/renderer/android-pos/shim/device-command.ts`
- `tests/android-settings-screen.test.tsx`
- `tests/android-device-command.test.ts`

#### Tests/gates

```bash
npx vitest run tests/android-settings-screen.test.tsx tests/android-device-command.test.ts
npm run typecheck:renderer
```

Assert canonical languages accepted, `de/cs/sk` migrate local exactly once sang `en`, không tạo remote write loop, và unsupported device controls không tạo write.

### W3 — Android loyalty lookup

**Implementation:** `gpt-5.6-terra high`
**Contract/security review:** `gpt-5.6-sol high`

#### Change

- Port typed `GET /api/v1/loyalty/pos/customer?phone=...` giống Windows `src/main/network/api-client.ts:729-740`.
- Dùng staff JWT và existing auth-refresh/error mapping; không dùng salon-wide `pa_` key.
- Add transport method, real implementation và synthetic unavailable response.
- Expose `pos.loyalty.lookupCustomer`, remove waiver `tests/android-preload-surface-parity.test.ts:143` chỉ sau runtime surface/test green.
- Manifest `loyaltyLookup=supported` chỉ khi transport capability verified.

#### File allowlist

- `src/renderer/android-pos/port/api-client.ts`
- `src/renderer/android-pos/shim/transport.ts`
- `src/renderer/android-pos/shim/real-transport.ts`
- `src/renderer/android-pos/shim/stubs.ts`
- `src/renderer/android-pos/shim/index.ts`
- `src/shared/types.ts` chỉ nếu cần dùng lại type hiện hữu, không duplicate DTO
- `tests/android-preload-surface-parity.test.ts`
- New `tests/android-loyalty.test.ts`
- New `tests/payment-modal-loyalty.test.tsx`

#### Tests/gates

- Phone normalization giống Windows.
- Found/not-found/unavailable/401-refresh/403/route-missing/network behavior.
- Tenant/user switch không reuse stale result.
- No waiver stale, parity suite green.

#### Hard stop

- Backend response khác `PosLoyaltyLookupResponse` (`src/shared/types.ts:2878-2900`).
- Valid staff JWT nhận 403/404 mà chưa xác minh backend contract.
- Cần backend/product deploy ngoài scope.

### W4 — loại Electron-only webview và dead affordances

**Architecture/security:** `gpt-5.6-sol high`
**Implementation/UI:** `gpt-5.6-terra high`

W4 là umbrella group, không launch nguyên nhóm. W4a và W4b là executable packets riêng; W4c chỉ là design gate cho tới khi owner duyệt native approach và exact native file list.

#### W4a — containment, executable

- Manifest-gate “Tạo sản phẩm” và “Sổ nợ”; Android không mount `<webview>` khi capability unsupported.
- Windows behavior không đổi.
- Customer Display, Camera/Quick Add, Pickup, Label chỉ render/enable theo manifest; không trả fake success.

Exact allowlist:

- `src/renderer/components/pos/POSLayout.tsx`
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx`
- `src/renderer/components/pos/templates/retail/QuickActions.tsx`
- `src/renderer/components/pos/PaymentModal.tsx`
- `src/renderer/android-pos/shim/stubs.ts`
- `tests/android-pos-capability-ui.test.tsx`
- `tests/android-shim.test.ts`
- New `tests/android-webview-boundary.test.ts`

`AddProductWebviewPanel.tsx` và `DebtWebviewPanel.tsx` không cần đổi nếu Android gate chứng minh chúng không mount/call. Nếu containment không đạt mà phải sửa hai panel, dừng và bổ sung exact diff scope trước khi launch lại W4a.

#### W4b — native product quick create/edit, executable sau W4a

- Reuse Android `productAdmin` transport (`src/renderer/android-pos/shim/product-admin.ts:179-265`) và existing `ProductCreateDialog`/capability hook.
- Extract adapter dùng chung từ created/updated variant sang catalog/cart line; không copy full `ProductModule`.
- Test duplicate EAN, idempotency key, grosze/quantity/VAT, catalog refresh và exact cart line.
- UI chỉ mở khi `useProductAdminCapabilities().canCreateProduct === true`; auth epoch change hoặc 403 phải đóng/fail closed, không giữ capability của cashier trước.
- Giữ `AddProductWebviewPanel` làm Windows adapter cho tới khi native React flow chứng minh parity; không xóa trong packet đầu.

Exact allowlist:

- `src/renderer/components/pos/POSLayout.tsx`
- `src/renderer/components/pos/templates/retail/RetailTemplate.tsx`
- `src/renderer/components/pos/templates/retail/QuickActions.tsx`
- `src/renderer/components/products/ProductCreateDialog.tsx`
- `src/renderer/components/products/ProductModule.tsx`
- New `src/renderer/components/products/product-admin-variant-adapter.ts`
- `src/renderer/hooks/useProductAdminCapabilities.ts`
- New `tests/product-admin-variant-adapter.test.ts`
- New `tests/android-pos-native-product-create.test.tsx`
- `tests/product-admin-capabilities-hook.test.ts`

#### W4c — debt ledger, design/approval gate only

- Không đổi `<webview>` thành `<iframe>` nếu chưa chứng minh CSP/cookie/auth.
- First safe option: allowlisted Android native external navigation/Custom Tab chỉ cho HTTPS host/path cố định.
- Nếu không có safe SSO/session handoff, giữ capability unsupported và hide action trên Android.
- Thêm native plugin/dependency chỉ bằng một plan amendment riêng sau owner approval. Amendment phải ghi exact Gradle/Kotlin/manifest/TypeScript files, URL allowlist contract, test command và rollback trước khi executor được launch.
- Nếu amendment chưa được duyệt, W4c acceptance là `debtLedgerExternal=unsupported` và Android không render action; không coi native navigation là requirement của W4 release.

#### Hard stop

- Arbitrary URL tới native plugin.
- Product create có thể POST lại sau timeout mà thiếu idempotency.
- Android vẫn render `<webview>`.
- iframe/external browser làm mất auth hoặc không trả được result nhưng UI báo success.

### W5 — full restored-cart tender wave

**Owner:** chỉ `gpt-5.6-sol xhigh`
**Independent reviewer:** `gpt-5.5 xhigh`
**Không giao implementation money path cho fast/mechanical model.**

Không ship riêng `beginRestoredTender`. Packet phải atomic gồm:

1. auto-restore protected interruption cart sau Billiard completion;
2. boot recovery/disposition và exact protected hold/journal identity;
3. durable `READY -> TENDER_COMMITTING` trước khi cashier được phép nhận tiền;
4. rollback về `READY` chỉ trước khi crossed tender boundary;
5. rollback durability failure thành `TENDER_UNCERTAIN`, không reopen payable;
6. order commit/idempotent retry thành `PAID_TOMBSTONE` trước cart clear;
7. OWNER-only `RESTORED_CART` uncertain resolution;
8. Android shell wire `onRestoredCartTenderOutcomeUncertain`;
9. reducer chặn clear restored cart khi chưa có committed order/tombstone.

#### Boot recovery invariant

Không thêm restored-cart recovery như một `useEffect` độc lập. `AndroidBootApp` hiện chạy ordinary snapshot restore (`AndroidBootApp.tsx:98-180`) và Billiard recovery (`AndroidBootApp.tsx:260-284`) song song; W5 phải thay chúng bằng một cancellable boot orchestrator có đúng thứ tự:

1. authenticated identity/config đã resolve;
2. restore và verify local open shift;
3. recover Billiard journal, committed/uncertain tender và protected interruption cart;
4. chỉ khi không có protected owner/reconciliation mới hydrate ordinary POS snapshot;
5. arm snapshot writer sau khi recovery/hydration kết thúc;
6. sau đó mới fire catalog sync.

Mọi async result bind vào cùng `authEpoch`; auth change hủy cả sequence. Protected recovery thắng ordinary snapshot. Không được persist empty/ordinary snapshot đè lên protected lifecycle trong khoảng boot.

#### File allowlist

- New preferred `src/renderer/android-pos/shim/restored-cart-handoff.ts`
- `src/shared/billiard-pos-handoff.ts`
- `src/shared/pos/billiard-pos-handoff.ts`
- `src/renderer/android-pos/shim/billiard-handoff.ts`
- `src/renderer/android-pos/shim/hold-orders.ts`
- `src/renderer/android-pos/shim/real-transport.ts`
- `src/renderer/android-pos/shim/transport.ts`
- `src/renderer/android-pos/shim/index.ts`
- `src/renderer/android-pos/shim/pos-store.ts`
- `src/renderer/android-pos/shim/db/hold-repo.ts`; không tạo ledger thứ hai
- `src/renderer/android-pos/shim/db/pos-snapshot-repo.ts` chỉ để read/clear exact ordinary snapshot theo boot invariant; không đổi schema
- `src/renderer/android-pos/AndroidBootApp.tsx`
- Characterize Windows reference, không sửa nếu không cần: `src/main/modules/pos.module.ts:1691-2154,2795-3120,5303-5350,6095-6150`
- Crash/durability/transport/shell tests liệt kê bên dưới

#### Tests bắt buộc

- `tests/billiard-pos-crash-recovery.test.ts`
- New `tests/android-restored-cart-handoff.test.ts`
- `tests/android-billiard-handoff.test.ts`
- `tests/android-billiard-checkout-wiring.test.ts`
- `tests/android-shell-props-parity.test.tsx`
- `tests/android-order-durability.test.ts`
- `tests/android-real-transport.test.ts`
- Real SUNMI force-stop recovery trước pilot

Cases: duplicate begin, wrong hold/order/clientAttemptId, auth/shift switch, snapshot drift, flush failure và failed rollback, kill sau COMMITTING, pre-existing local order, OWNER resolution, non-owner refusal, duplicate createOrder, tombstone trước cart clear, protected recovery thắng ordinary snapshot, snapshot writer chỉ arm sau recovery, và auth change hủy boot sequence.

Không dự kiến Android DB schema change trong W5: restored lifecycle nằm trong protected Hold payload hiện hữu. Nếu implementation cần sửa `shim/db/schema.ts`, native asset migration hoặc installed-image schema, dừng và tách W5a schema migration plan với verifier/upgrade/rollback riêng; không tự mở rộng W5.

#### Hard stop

- Bất kỳ success nào trước `database.flush()`.
- Ambiguous/crossed boundary tự lùi về payable.
- Order không bind durable `orderId + clientAttemptId`.
- Cart clear khi chưa có local committed order/tombstone.
- Existing protected rows cần mutate mà chưa có verifier.
- Force-stop recovery không deterministically vào reconciliation.
- Ordinary snapshot hydrate/write chạy song song hoặc chạy trước protected recovery.
- Cần sửa schema nhưng chưa có W5a migration plan được duyệt.

### W6 — authenticated visual harness và Chromium-83 build targets

**Design/test seam:** `gpt-5.6-sol high`
**Implementation:** `gpt-5.6-terra high`

Làm trước CSS refactor để có regression evidence.

#### Change

- Giữ `scripts/verify-android-responsive.mjs` cho unauthenticated Login.
- Thêm authenticated harness chạy **production Android bundle thật**. Playwright route-mock exact auth/config/catalog/shift endpoints, submit real Login form và seed deterministic responses từ test fixtures; không thêm auth bypass, query flag, localStorage escape hatch hoặc test entry vào shipping bundle.
- Viewports: 800×600, 1024×768, 1336×736; capture named screenshots.
- Assertions: no horizontal overflow, Pay/action fully visible, ≥44px critical touch targets, no console/CSP errors.
- Mọi outbound request không khớp fixture allowlist làm test fail. Bundle test phải assert không chứa fixture marker/test credential/auth-bypass symbol.
- Thêm real SUNMI Chromium-83 CDP step, nhận exact `ANDROID_SERIAL`, capture cùng named screens và WebView version; desktop Playwright mới không chứng minh engine 83.
- Pin `build.target` và `build.cssTarget` phù hợp Chrome 83 trong `vite.android.config.ts`; không giả định esbuild tự sửa flex-gap/aspect.
- Mở rộng CSS scanner unit tests; chưa bật strict release gate khi debt còn >0.

#### File allowlist

- `vite.android.config.ts`
- `package.json`
- New `scripts/verify-android-authenticated-responsive.mjs`
- New `scripts/verify-android-sunmi-authenticated.mjs`
- New `tests/fixtures/android-pos/authenticated-fixture.ts`
- `scripts/verify-css-baseline.mjs`
- `tests/css-baseline-guard.test.ts`
- New `tests/android-authenticated-bundle-boundary.test.ts`

Không sửa shared component chỉ để thêm selector trong W6. Dùng accessible role/name hoặc existing selector. Nếu một screen thật sự không thể chọn ổn định, dừng và amendment exact một component + một test thay vì mở wildcard.

#### Hard stop

- Production Android bundle chứa fixture data, test credential, test-only route hoặc auth bypass marker.
- Harness bỏ qua real login/session/config flow bằng cách thay React root.
- SUNMI command không pin exact serial/WebView version hoặc có thể chạy nhầm thiết bị.

### W7 — shared POS font parity

**Visual decision:** `gpt-5.6-sol high`
**Implementation:** `gpt-5.6-terra high`; Luna chỉ inventory

- Reuse licensed Plus Jakarta Sans assets đang có dưới `src/renderer/fonts/kso/**`; không download asset mới trong packet đầu.
- Apply một POS-specific font family cho Windows và Android shared cashier; không vô tình đổi toàn back-office/KSO.
- Quyết định rõ weight 400 vì assets hiện có 500/600/700/800; nếu cần asset 400, dừng xin approval/license evidence.
- Screenshot Vietnamese/Polish long names và payment buttons ở ba viewports.

Exact allowlist: `src/renderer/index.css`, `tailwind.config.js`, `src/renderer/components/pos/POSLayout.tsx`, và new `tests/pos-font-scope.test.ts`.

### W8 — core cashier CSS to zero trong live sale path

**Owner:** `gpt-5.6-terra high`
**Mechanical candidates:** `gpt-5.6-luna high`
**Review:** `gpt-5.6-sol high`

Không global replace. Luna chỉ được sửa nhóm đơn giản đã audit như `flex flex-col gap-*` khi semantics tương đương `space-y-*`/grid. Các row có `flex-wrap`, `justify-between`, breakpoint, payment/cart/button phải do Terra/Sol quyết định.

W8 là umbrella group; launch theo exact sub-packets:

- **W8a:** `src/renderer/components/pos/POSLayout.tsx`, `src/renderer/components/pos/Cart.tsx`, `src/renderer/components/pos/CartItem.tsx`
- **W8b:** `src/renderer/components/pos/PaymentModal.tsx`, `src/renderer/components/pos/OrderHistoryModal.tsx`
- **W8c:** `src/renderer/components/pos/templates/retail/RetailTemplate.tsx`, `src/renderer/components/pos/templates/salon/SalonTemplate.tsx`, `src/renderer/components/pos/ProductCard.tsx`
- **W8d:** `src/renderer/components/pos/ProductGrid.tsx`, `src/renderer/components/pos/QuickAddCameraModal.tsx`

Mỗi sub-packet có independent CSS before/after count, focused tests và screenshots; W8b luôn do Terra implement và Sol review, không giao Luna.

W8 locked batch hiện chứa đúng 9 `aspect-*`: 5 trong `QuickAddCameraModal`, và mỗi file 1 trong `ProductCard`, `ProductGrid`, Retail, Salon. Thay 9 vị trí này bằng explicit-height/padding-ratio theo semantics, không dùng aspect-ratio polyfill mơ hồ. Bốn vị trí còn lại thuộc W9 (`AddTableDialog` 2, `AssetPickerGrid` 2). Chạy CSS count và screenshot sau từng nhóm 1–3 file; packet phải làm giảm count, không tạo permanent allowlist.

### W9 — Billiard/remaining CSS, emitted CSS và strict gate

**Implementation:** `gpt-5.6-terra high`
**Mechanical:** `gpt-5.6-luna high`
**Acceptance:** `gpt-5.6-sol high`

W9 là umbrella group, không launch nguyên nhóm. Mỗi W9a.n/W9b.n là một exact 1–3 file packet được supervisor ghi vào execution ledger trước khi giao model.

#### Batch A — Bi-a live path

- **W9a.1:** `src/renderer/components/billiard/BilliardFloorPlan.tsx`, `src/renderer/components/billiard/ReservationPanel.tsx`
- **W9a.2:** `src/renderer/components/billiard/AddItemToTabModal.tsx`, `src/renderer/components/billiard/AddTableDialog.tsx`, `src/renderer/components/billiard/AssetPickerGrid.tsx`
- **W9a.3:** `src/renderer/components/billiard/SessionHistory.tsx`, `src/renderer/components/billiard/DailyReport.tsx`, `src/renderer/components/billiard/KitchenDisplay.tsx`

W9a aspect acceptance: sửa đúng 4 `aspect-*` trong `AddTableDialog.tsx` và `AssetPickerGrid.tsx`.

#### Batch B — remaining POS graph

- Trước mỗi launch, chạy scanner, chọn tối đa 3 exact files, thêm một dòng vào execution ledger dưới đây, rồi mới giao executor. Dòng chưa có exact file list và before-count không phải executable packet.
- Prove emitted `:where`, `:is`, `aspect-ratio`, `color-mix`, `@container` reachable hay không; không silence global KSO CSS chỉ để POS scan green.
- Nếu CSS bundle shared chứa unsupported KSO-only rule, tách/scoped bundle hoặc sửa rule mà vẫn test KSO.

Execution ledger template:

| Packet | Exact files | Before count | Expected after | Model | Review status |
|---|---|---:|---:|---|---|
| W9b.1 | _must be filled from current scanner output_ | — | — | Terra/Luna | NOT LAUNCHABLE |

Không dùng glob, “reachable files” hoặc directory allowlist trong prompt executor. Supervisor thay placeholder bằng exact paths/counts trước W9b.1; mỗi packet sau thêm một row mới.

#### Batch C — emitted CSS và release script

Exact allowlist:

- `src/renderer/index.css`
- `tailwind.config.js`
- `vite.android.config.ts`
- `package.json`
- `scripts/verify-css-baseline.mjs`
- `tests/css-baseline-guard.test.ts`
- New `tests/android-build-verification-gates.test.ts`

Nếu emitted unsupported selector đến từ dependency-generated CSS chứ không phải ba source/config files trên, dừng và lập exact amendment; không patch generated `dist/**`.

#### Final gate

`npm run test:css-baseline:strict` phải zero và được gọi sau Android web build trong release verification. Sửa `android:build:verify` trong `package.json` để strict gate chạy sau `android:sync`/bundle generation và trước native packaging. `tests/android-build-verification-gates.test.ts` pin command order để gate không bị bỏ lại về sau. Không dùng baseline allowlist lâu dài.

### W10 — split `POSLayout` sau khi parity green

**Owner:** `gpt-5.6-sol high`
**Extraction:** `gpt-5.6-terra high`
**Luna:** inventory only

W10 là umbrella refactor group, không launch toàn nhóm. Trước từng extraction, supervisor ghi exact new hook/component file, `POSLayout.tsx`, focused test files và before/after line ownership vào execution ledger; thiếu row đã duyệt thì packet `NOT LAUNCHABLE`.

Mỗi extraction là một diff/review/commit riêng, theo thứ tự:

1. `useShiftFlow`
2. `useScanImportFlow`
3. `usePickupFlow`
4. `useQuickAddFlow`
5. `useBilliardTenderFlow`
6. `CashierModalLayer`

Không giao cả sáu extraction trong một prompt write-capable. Sau từng extraction: chạy common gates, focused tests cho flow đó và dual-host authenticated screenshots; supervisor review/commit xong mới mở extraction tiếp theo.

Execution ledger template:

| Packet | Exact source files | Exact tests | Behavior invariant | Review status |
|---|---|---|---|---|
| W10.1 | _fill before launch_ | _fill before launch_ | subscriptions/modal/cart unchanged | NOT LAUNCHABLE |

Giữ `POSLayout` làm coordinator và giữ bốn shared templates. Không lazy-load template trong remediation branch; chỉ cân nhắc sau khi Chromium-83/offline/CSP harness tồn tại. Dừng nếu extraction remount state, duplicate subscription, thay modal lifetime hoặc chạm money behavior ngoài packet.

## 6. Gate matrix

### Mọi packet TypeScript/renderer

```bash
npm run typecheck:renderer
npm run test:android:parity
npm run test:android:boundaries
npm run build:android:web
git diff --check
```

Chỉ chạy focused Vitest suites nằm trong packet ngoài các common gates. `test:android:boundaries` tự build Android; không chạy song song hai command cùng ghi `dist/android-web`.

### Shared UI/CSS/font packets

- Windows POS screenshots/smoke: 800×600 và 1024×768.
- Android authenticated fixture: 1336×736.
- Real SUNMI Chromium-83 acceptance trước khi strict gate/rollout.
- Retail, Salon, Payment, Order History và Bi-a key actions đều fully visible.

### Money/native packets

- W0/W5: crash, flush failure, auth/shift switch, duplicate/idempotency tests.
- W4c/W5: Android instrumentation và real device.
- Không test money bằng live customer/payment data.

## 7. Packet acceptance template

Mỗi packet handoff phải có:

```text
Packet: Wn
Model/effort:
Baseline SHA + plan/review SHA-256:
Files changed (must match allowlist):
Behavior before:
Behavior after:
Tests run + exact results:
Windows evidence:
Android evidence:
Known gaps left:
Rollback: revert <single reviewed commit>; no DB manual mutation
Stop conditions checked:
```

Supervisor chỉ merge packet khi diff không chứa unrelated WIP, all gates xanh, và reviewer độc lập ký W0/W5.

## 8. Release/rollout order

1. Merge correctness containment W0; không deploy live trong plan này.
2. Merge W1a-c, W2, W3, W4a và W4b theo từng reviewed commit. W4c không block nếu Android debt action đã hidden/fail-closed.
3. Merge W5 restored tender chỉ sau full crash/instrumentation evidence.
4. Merge W6–W9 visual parity, on-device WebView83 và strict CSS zero.
5. W10 refactor là release riêng sau behavior parity.
6. Windows/Android packaging/pilot/deploy cần owner-reviewed release plan riêng. Trước Chesaigon update/restart phải xác nhận quầy idle và xin explicit restart confirmation.

## 9. Không nằm trong plan

- Port nguyên 17 back-office modules.
- Fork `POSLayout` hoặc bốn templates theo platform.
- Rewrite 641 call-site thành giant `PlatformPorts`.
- Backend/production schema/API redesign, backend database migration hoặc production data repair. Android local schema chỉ được đổi trong W5a migration amendment riêng.
- Play Store/R2 publish, production deploy, Chesaigon POS restart.
- Visual redesign mới; đây là parity/correctness remediation theo design hiện hữu.
