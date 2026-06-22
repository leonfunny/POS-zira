# Design Reasoning & Plan: Phái Flow Capital — POS + Cashflow Intelligence / Embedded Finance

> Mở rộng POS Zira thành **"POS biết dự báo tiền"** → lớp fintech embedded finance cho SME.
> One-liner pitch: *"We turn POS transaction data into real-time financial intelligence and working-capital access for small merchants."*

---

## 0. TL;DR — Điều quan trọng nhất

**Anh KHÔNG xây fintech từ con số 0. ~80% backend engine ĐÃ CÓ và đang LIVE trên Contabo.**

Backend module `erp-ai` (đã deploy 2026-06-21) đã implement gần như toàn bộ tầm nhìn:

| Tầm nhìn của anh | Đã có sẵn ở backend | Endpoint |
|---|---|---|
| 1. Cashflow Dashboard (Cash vs Sales, 7/30/90) | ✅ `cashflow-read-model` + `cashflow-summary` | `GET /erp-ai/cashflow/summary` |
| 2. AI Sales & Cash Forecast | ✅ `cashflow-forecast` (7/30/90 ranges) | `GET /erp-ai/cashflow/forecast` |
| 3. Inventory Cash Trap | ✅ `inventory-money-lock` | `GET /erp-ai/inventory/money-lock` |
| 4. Smart Expense & Payable Planner | ✅ `expense-planner` + `employee-cost` | `GET/POST /erp-ai/expenses`, `/employee-costs/summary` |
| Capital Need Detector | ✅ `cashflow-planning` | `GET /erp-ai/cashflow/capital-need` |
| Financing Simulation (MCA, working capital) | ✅ `financing-advisory` (fitScore 0–100) | `GET /erp-ai/financing/options` |
| Merchant Finance Report (cho lender) | ✅ `merchant-finance-report` + PDF (riskLevel low/med/high) | `GET /erp-ai/financing/report[.pdf]` |
| KSeF inbound (lấy hóa đơn mua về) | ✅ `ksef-inbox` (import → map-to-expense → create-pz) | `POST /erp-ai/ksef/inbox/*` |
| Finance Center web dashboard | ✅ đã render đủ section + tải PDF | `/app/erp-ai/finance` |

**Cái CÒN THIẾU (chính là phần "mở rộng POS"):**

1. 🔴 **POS Electron app chưa hiển thị gì** — Finance Center mới chỉ ở web dashboard, KHÔNG có tab trong app POS quầy.
2. 🟡 **Event pipeline chưa đầy đủ** — outbox POS→backend đã CODE (nhánh `feat/pos-event-outbox`) nhưng CHƯA merge/build/deploy → backend hiện chỉ nhận `order.created` qua backend-adapter, thiếu shift/refund/fiscal/cash-drawer trực tiếp từ máy.
3. 🔴 **Module 5 — AI Business Copilot** chưa có ở đâu cả (erp-ai không có chat/anomaly/copilot).
4. 🟡 **Merchant Score 0–100 "Phái Merchant Score"** mới có một nửa (riskLevel low/med/high + financing fitScore) — chưa thành điểm số sản phẩm hoàn chỉnh.
5. 🟡 **Anomaly detection** ("hôm nay có gì bất thường?") chưa có.
6. 🔴 **Demo "wow"** ("Can I afford 20,000 PLN inventory next week?") chưa có UI.

→ **Plan = productize engine có sẵn vào app POS + lấp 6 gap trên.** Rủi ro thấp, time-to-demo nhanh, đúng để pitch PFR fintech.

---

## 1. Requirements

- **What:** Thêm lớp Cashflow Intelligence + embedded finance vào POS Zira (Electron app), tái sử dụng engine `erp-ai` có sẵn ở backend; bổ sung AI Copilot, Merchant Score, anomaly detection, affordability simulator.
- **Why:** Biến POS commodity → sản phẩm fintech "cashflow-based underwriting & working-capital access". Tận dụng distribution sẵn (cộng đồng VN ở Ba Lan: nhà hàng, nail, grocery) + thế mạnh dòng tiền. Pitch PFR: Fintech + AI.
- **Who:** `OWNER`, `MANAGER` (xem tiền + financing). `STAFF` KHÔNG thấy (dữ liệu tài chính nhạy cảm). Lender/partner = consumer của Merchant Finance Report PDF (offline, không cần account).
- **Where:** `POS-zira` Electron app (client) + `backend/erp-ai` + `backend/pos-events` + `frontend` web dashboard (đã có).
- **Scope:** Enhancement (productize engine có sẵn) + 3 module mới nhỏ (Copilot, Score, Anomaly).

### Boundary client/server (theo CLAUDE.md của POS-zira)
- POS app = **client**. Mọi endpoint `erp-ai/*` ĐÃ tồn tại → app chỉ cần **gọi**, không cần xin server change cho Phase 1–3.
- Endpoint mới (Copilot chat, Merchant Score, Anomaly) = **server change** → làm ở `backend/erp-ai`, rồi app gọi. Đây là repo anh sở hữu cả 2 đầu nên OK, nhưng giữ contract rõ ràng.

---

## 2. Architecture

### Luồng dữ liệu (end-to-end)

```
┌─────────────────── POS Zira (Electron, mỗi máy quầy) ───────────────────┐
│  Bán hàng / ca / refund / fiscal / mở két                                │
│        │                                                                  │
│        ▼  ghi business fact (offline-first)                              │
│  pos_event_outbox (SQLite)  ◄── ĐÃ CODE ở nhánh feat/pos-event-outbox    │
│        │  uploader (ulid idempotency, retry/backoff)                     │
│        ▼                                                                  │
│  POST /api/v1/pos-events/batch  ─────────────┐                          │
│                                               │                          │
│  TAB MỚI "Dòng tiền" (renderer)              │  GỌI (đọc):              │
│   - Cash Today/7/30/90                        │  GET erp-ai/cashflow/*  │
│   - Inventory Money Lock                      │  GET erp-ai/inventory/* │
│   - Affordability simulator (WOW)             │  GET erp-ai/financing/* │
│   - AI Copilot chat                           │  POST erp-ai/copilot    │
└───────────────────────────────────────────────┼──────────────────────────┘
                                                 ▼
┌──────────────────────── Backend eNail (Contabo, LIVE) ───────────────────┐
│  pos-events/  ingestion (idempotent, per-salon guard) + adapter          │
│        │  POS_DIRECT_EVENT_SALON_IDS = cutover từng salon (tránh dup)     │
│        ▼                                                                   │
│  pos_events (deterministic facts)                                         │
│        │                                                                   │
│  erp-ai/  ◄── ĐÃ LIVE:                                                    │
│   cashflow-read-model · forecast · planning(capital-need)                 │
│   inventory-money-lock · expense-planner · employee-cost                  │
│   financing-advisory(fitScore) · merchant-finance-report(+PDF, riskLevel) │
│   ksef-inbox(import→map→PZ)                                               │
│   ⊕ MỚI: copilot(LLM grounded) · merchant-score · anomaly-detector        │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼  web dashboard (đã có)  /app/erp-ai/finance
```

### Định vị sản phẩm 3 lớp (mapping vào code có sẵn)

**Lớp 1 — Cashflow Intelligence** (✅ 90% có): summary/forecast/capital-need/inventory-money-lock/expenses. Việc còn lại = **đưa vào tab POS**.

**Lớp 2 — Phái Merchant Score** (🟡 50% có): nâng `riskLevel` (low/med/high) + financing `fitScore` thành **điểm 0–100** với sub-scores (revenue stability, volatility, refund rate, cash conversion cycle, growth, inventory turnover). Thêm endpoint `GET /erp-ai/merchant-score`.

**Lớp 3 — Working Capital** (✅ 80% có, KHÔNG tự cho vay giai đoạn đầu): `financing/options` (MCA / working-capital / inventory financing simulation) + `financing/report.pdf` = **"merchant finance report" cho lender partner**. Anh chỉ làm **scoring + data layer cho lender**, tránh rủi ro pháp lý. Đúng như anh nói.

---

## 3. Trade-offs (các quyết định lớn)

### QĐ1: UI cashflow nằm ở đâu?
- **A. Tab trong POS Electron app** — chủ shop xem ngay tại quầy, đúng tầm nhìn "POS biết dự báo tiền". Reuse api-client có sẵn.
  - ＋ Đúng pitch, ở nơi chủ shop làm việc · ＋ Offline-aware (hiện cache khi mất mạng)
  - − Phải build/ship app mới tới fleet
- **B. Chỉ web dashboard** (đã có) — không đụng app.
  - ＋ Zero client work · − Không phải "POS biết tiền", chủ shop ít mở dashboard web
- **→ Khuyến nghị: A + giữ B.** Tab POS cho chủ shop tại quầy; web dashboard cho xem từ xa / lender report. Cùng backend.

### QĐ2: Outbox event — deploy thế nào?
- **A. Per-salon cutover** qua env backend `POS_DIRECT_EVENT_SALON_IDS` (đã design, user-confirmed) — bật từng salon, adapter cũ vẫn chạy cho salon chưa bật → **không double-count**.
  - ＋ An toàn money-path, rollback = bỏ salon khỏi env · − Phải quản lý danh sách
- **B. Bật toàn fleet ngay** — rủi ro dup events (adapter + direct cùng emit).
- **→ Khuyến nghị: A.** Pilot chesaigon trước (dev-test → 1 salon → fleet).

### QĐ3: AI Copilot — grounding thế nào?
- **A. Tool/data-grounded** — Copilot CHỈ trả lời từ output các endpoint erp-ai (forecast, money-lock, score...), không bịa. LLM = lớp diễn giải.
  - ＋ Đúng "AI không phán chung chung" · ＋ An toàn, auditable (audit trail cho fintech)
  - − Cần định nghĩa tool schema
- **B. Đẩy raw data vào prompt** — nhanh nhưng dễ hallucination, lộ dữ liệu.
- **→ Khuyến nghị: A.** Backend `copilot.service` gọi nội bộ các service erp-ai → đưa số liệu xác định vào context → LLM diễn giải. Advisory-only, có disclaimer.

### QĐ4: Cho vay thật vs data/lead layer?
- **→ Khuyến nghị: Data/underwriting layer trước** (như anh nói). MVP = scoring + merchant finance report cho lender partner. KHÔNG cấp vốn → tránh giấy phép tài chính. Marketplace để Phase sau.

---

## 4. File Impact Map

### A) POS-zira (Electron app) — CLIENT

**MERGE trước (đã code, chỉ cần đưa về main + build):**
- `src/main/database/repos/pos-event-outbox-repo.ts` — outbox repo
- `src/main/events/pos-event-emitter.ts` — emitter (8 event types)
- `src/main/sync/pos-event-uploader.ts` — uploader → `/pos-events/batch`
- `src/main/utils/ulid.ts` — idempotency id
- migration `pos_event_outbox` (trong `migrations.ts`)
- call sites: `order-repo.ts`, `shift-controller.ts` (emit khi bán/mở-đóng ca)
- tests: `pos-event-{emitter,ulid,uploader}.test.ts`
- → nguồn: nhánh `feat/pos-event-outbox` trên `/home/paul/POS-zira-feature` (commit b07dc28a)

**CREATE (tab Dòng tiền):**
- `src/renderer/windows/pos/tabs/CashflowTab.tsx` — tab chính (Cash Today/7/30/90, Sales≠Cash)
- `src/renderer/components/cashflow/ForecastCard.tsx`
- `src/renderer/components/cashflow/InventoryMoneyLock.tsx`
- `src/renderer/components/cashflow/AffordabilitySimulator.tsx` — **WOW feature**
- `src/renderer/components/cashflow/MerchantScoreGauge.tsx`
- `src/renderer/components/cashflow/CopilotChat.tsx`
- `src/renderer/hooks/useCashflow.ts` — gọi erp-ai endpoints
- `src/main/network/api-client.ts` → thêm methods: `getCashflowSummary/Forecast/CapitalNeed`, `getInventoryMoneyLock`, `getFinancingOptions`, `getMerchantScore`, `askCopilot`, `getAnomalies`
- i18n: thêm key vào `src/renderer/i18n/translations.ts` (7 ngôn ngữ — chú ý vi/pl)

**MODIFY:**
- `src/renderer/windows/pos/POS.tsx` — đăng ký tab + gate role OWNER/MANAGER
- `src/shared/types.ts` — thêm IPC channels + DTO cashflow/score/copilot
- `src/shared/electron.d.ts` — khai báo electronAPI mới
- `src/main/modules/sync.module.ts` — wire outbox uploader (đã có ở nhánh)

### B) backend/erp-ai — SERVER (3 module mới)

**CREATE:**
- `controllers/erp-ai-copilot.controller.ts` → `POST /erp-ai/copilot/ask`
- `services/copilot.service.ts` — grounded LLM (gọi nội bộ cashflow/forecast/money-lock/score; OpenAI gpt-4o-mini hoặc gemini)
- `dto/copilot.dto.ts`
- `controllers/erp-ai-merchant-score.controller.ts` → `GET /erp-ai/merchant-score`
- `services/merchant-score.service.ts` — điểm 0–100 + sub-scores (tái dùng read-model + forecast + money-lock)
- `dto/merchant-score.dto.ts`
- `controllers/erp-ai-anomaly.controller.ts` → `GET /erp-ai/anomaly/today`
- `services/anomaly-detector.service.ts` — z-score/threshold trên pos_events (refund spike, doanh thu bất thường, void nhiều, drawer mở nhiều)
- `dto/anomaly.dto.ts`

**MODIFY:**
- `erp-ai.module.ts` — đăng ký 3 controller + 3 service (NHỚ barrel export `services/index.ts` — incident rule)
- `merchant-finance-report.service.ts` — nhúng `merchantScore` vào report (cho lender)

### C) frontend web dashboard
**MODIFY:**
- `frontend/src/app/app/erp-ai/finance/page.tsx` — thêm section Merchant Score + Anomaly + Copilot (optional Phase 4); i18n `lib/i18n` (useDashboardTranslation — KHÔNG dùng next-intl trong /app/app/**)

### D) MIGRATE (backend)
- Có thể KHÔNG cần migration mới (engine đã đọc `pos_events`). Score/anomaly = read-only. Copilot = stateless. → **migration: none** (an toàn). Nếu lưu chat history → 1 bảng `erp_ai_copilot_messages` (optional, Phase 4).

---

## 5. Risks

| Risk | Mức | Mitigation |
|---|---|---|
| **Double-count events** (adapter + direct outbox) | HIGH | Per-salon cutover env `POS_DIRECT_EVENT_SALON_IDS`; ingestion đã idempotent theo `eventId`; pilot 1 salon trước |
| **Money-path sai** (forecast/score lệch → quyết định tài chính sai) | HIGH | Engine deterministic; LLM chỉ diễn giải, KHÔNG tính tiền; disclaimer "advisory only, AI không duyệt financing" (đã có trong mọi endpoint) |
| **Lộ dữ liệu tài chính cho STAFF** | HIGH | Gate `@Roles(OWNER, MANAGER)` ở backend (đã có) + ẩn tab ở renderer |
| **Multi-tenant leak** | HIGH | Mọi service filter `user.salonId`; ingestion reject event lệch salon (đã có) |
| **LLM hallucination về tiền** | MED | Tool-grounded (QĐ3-A); chỉ feed số đã tính; audit trail mọi câu trả lời copilot |
| **Build/ship fleet hỏng** | MED | Per-salon update qua R2 (electron-updater), pilot chesaigon; KHÔNG tắt app đang bán |
| **i18n thiếu key crash** | LOW | Luôn dùng fallback `t(key)||'Default'`; web dùng `useDashboardTranslation` |
| **Pháp lý cho vay** | MED | Giai đoạn đầu = data/scoring layer cho lender, KHÔNG tự cấp vốn |

---

## 6. Implementation Order (phân pha)

### Phase 0 — Nền tảng dữ liệu (1 tuần) ⭐ unblocks tất cả
1. Đưa nhánh `feat/pos-event-outbox` về main POS-zira; build trên Alienware (typecheck:renderer + tsc main + vitest).
2. Backend: bật `POS_DIRECT_EVENT_SALON_IDS=<chesaigon salonId>` (đã có guard).
3. Ship app pilot chesaigon (R2) → verify `/pos-events/batch` 201, không dup (so adapter vs direct).
*→ Sau pha này backend có dòng event đầy đủ từ máy thật.*

### Phase 1 — Cashflow Tab trong POS (MVP "POS biết tiền") (1–2 tuần)
4. api-client: 5 method đọc erp-ai (cashflow/inventory/financing).
5. CashflowTab + ForecastCard + InventoryMoneyLock (reuse endpoint có sẵn — KHÔNG cần backend mới).
6. Sales≠Cash card (doanh thu vs tiền thực nhận vs vốn kẹt tồn vs chi phí sắp tới).
7. Offline-aware: cache lần gọi cuối, banner khi mất mạng.
*→ Demo được "Cash Today/7/30/90 + Inventory Money Lock" ngay trong POS.*

### Phase 2 — Fintech layer: Score + Affordability + Lender Report (1–2 tuần)
8. Backend `merchant-score.service` + endpoint → MerchantScoreGauge.
9. **AffordabilitySimulator (WOW)**: ô nhập "muốn nhập X PLN tuần tới" → gọi `financing/options` + `capital-need` → trả "nên nhập bao nhiêu, ngày nào chạm buffer, ưu tiên SKU vòng quay <21 ngày".
10. Nút "Xuất Merchant Finance Report (PDF)" trong POS → `financing/report.pdf` (đã có). Nhúng merchantScore.
*→ Đủ chất fintech để pitch: scoring + financing simulation + lender report.*

### Phase 3 — AI Copilot + Anomaly (1–2 tuần)
11. Backend `copilot.service` (grounded) + `anomaly-detector.service` + endpoints.
12. CopilotChat trong POS ("Hôm nay có gì bất thường?", "Có đủ tiền trả supplier?", "Nên nhập gì?").
13. Anomaly banner trên CashflowTab.
*→ Hoàn thiện "AI Business Copilot" — module 5.*

### Phase 4 — Web parity + polish (tùy chọn)
14. Thêm Score/Anomaly/Copilot vào web Finance Center.
15. Lưu copilot history (optional migration).

---

## 7. MVP để nộp PFR (fintech grant)

Gọn đúng 5 thứ PFR muốn thấy — **tất cả tái dùng engine có sẵn + 2 service mới nhỏ**:

1. **POS cashflow forecast 30 ngày** — ✅ có (`forecast`) → chỉ cần tab POS (Phase 1).
2. **Merchant health score** — 🟡 Phase 2 (`merchant-score`).
3. **Capital need detector** — ✅ có (`capital-need`) → Phase 1/2.
4. **Financing simulation** (advance: nhận bao nhiêu, trả % doanh thu/ngày, bao lâu hoàn) — ✅ có (`financing/options`) → Phase 2.
5. **Partner lender export** (merchant finance report PDF) — ✅ có (`report.pdf`) → Phase 2.

**3 keyword pitch:**
- **Fintech**: working capital, merchant financing, cashflow-based underwriting (financing-advisory + merchant-finance-report).
- **AI**: forecast, merchant score, anomaly detection, repayment simulation, copilot.
- **AI governance/security nhẹ**: anomaly detection giao dịch bất thường, giải thích score (explainable), **audit trail** mọi quyết định tài chính, disclaimer advisory-only.

**Câu pitch:** *"Phái Flow Capital helps small merchants access working capital using real-time POS data instead of outdated bank statements."*

---

## 8. Demo "WOW"

Chủ shop gõ trong tab Dòng tiền (hoặc hỏi Copilot):
> "Can I afford to buy 20,000 PLN of inventory next week?"

Hệ thống (AffordabilitySimulator → `capital-need` + `financing/options` + `inventory/money-lock`):
> "Không nên mua toàn bộ. Với tốc độ bán hiện tại, anh sẽ xuống dưới mức cash buffer an toàn vào ngày 18. Đề xuất nhập 11,000 PLN trước, ưu tiên 12 SKU vòng quay <21 ngày. Nếu cần đủ 20,000, anh đủ điều kiện một working-capital advance hoàn trả bằng 8% doanh thu/ngày trong ~75 ngày."

---

## 9. Estimated Complexity

| | Mức |
|---|---|
| Backend (3 service mới: copilot/score/anomaly) | moderate (read-only, reuse) |
| Frontend POS (tab + 6 component + hook) | moderate |
| Outbox merge/build/deploy | simple (đã code, chỉ wire+test+ship) |
| Migration | none (Phase 0–3) / safe (Phase 4 copilot history) |
| **Tổng** | ~Phase 0–3: 4–7 tuần 1 dev. Demo-able sau Phase 1 (~2–3 tuần). |

**Không breaking change** với API hiện có. Mọi endpoint erp-ai đã advisory-only & role-gated.
</content>
</invoke>
