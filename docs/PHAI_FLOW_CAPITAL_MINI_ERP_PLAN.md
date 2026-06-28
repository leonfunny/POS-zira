# Phai Flow Capital Mini ERP Plan

## 1. Product Positioning

POS Zira should evolve from a point-of-sale app into a small ERP and fintech advisory layer for small and medium businesses.

The product promise:

> POS Zira helps small merchants understand their cashflow, prove business health, and choose the right working-capital option using real POS, invoice, inventory, payroll, and expense data.

This is not a standalone lending product at the beginning. It is an operational finance engine built inside the POS. The POS produces trustworthy data and advice; lenders or human partners make final financing decisions.

## 2. Core Business Problem

Many small businesses know what they sold, but they do not know:

- how much cash they will have in 7, 30, or 90 days;
- how much money is locked in inventory;
- whether staff costs are too high;
- whether they can afford supplier payments, payroll, rent, VAT, ZUS, and loan repayment;
- whether they should borrow;
- how much they should borrow;
- which financing product fits their situation;
- which documents they need to prove their business is healthy.

Most POS systems stop at sales reporting. POS Zira should answer operational finance questions:

- "Can I afford to buy 20,000 PLN of inventory next week?"
- "How much should I borrow to grow safely?"
- "Should I use inventory financing, merchant cash advance, factoring, leasing, or a normal working-capital loan?"
- "What documents will a lender need?"
- "Why is my business profitable on paper but short of cash?"
- "What should I improve before applying for financing?"

## 3. Target Users

Initial target:

- Vietnamese-owned restaurants in Poland;
- nail salons;
- small grocery stores;
- small retail shops;
- service businesses with product sales;
- small restaurants, cafes, billiard clubs, and local merchants.

Expansion target:

- Polish SMEs using POS/invoicing systems but lacking financial planning.

## 4. Product Scope

The system should combine these data domains:

- POS sales;
- payment method and settlement timing;
- refunds and discounts;
- KSeF purchase invoices;
- supplier payables;
- purchase invoice to product mapping;
- PZ goods receipts;
- FIFO inventory/kardex;
- product cost and margin;
- staff attendance/payroll/commission;
- recurring expenses;
- taxes and VAT estimates;
- loans/leasing obligations;
- cashflow forecast;
- merchant health scoring;
- capital recommendation and finance report.

## 5. What AI Does And Does Not Do

### AI Does

AI acts as a CFO-style advisor. It reads computed facts and explains them in business language.

AI can:

- explain why the business is healthy or weak;
- explain why cash is tight despite sales;
- classify business state: good and undercapitalized, risky, improving, or not finance-ready;
- suggest actions to improve cashflow;
- suggest which financing type is suitable;
- prepare a document checklist;
- generate a merchant finance report summary;
- answer questions in chat using computed data;
- explain inventory cash traps;
- explain staff cost pressure;
- explain repayment simulations.

Example AI output:

> Your business is not weak. The main constraint is undercapitalization: fast-moving products are frequently out of stock while refund rate is low and weekend sales are stable. A 12,000-16,000 PLN inventory-financing facility is safer than a 30,000 PLN general loan.

### AI Does Not

AI must not:

- approve or reject a loan;
- set official credit limits;
- set official interest rates;
- make legally binding credit decisions;
- modify financial records without review;
- post PZ, WZ, invoices, or payroll without deterministic validation and user confirmation;
- invent data not present in the system;
- replace accountant or lender compliance checks.

Credit decisions belong to lender rules, partner systems, or human review. AI provides advice and explanation.

## 6. Deterministic Engines

The following must be calculated by code, SQL, rules, and auditable formulas, not by AI.

### 6.1 Cashflow Engine

Inputs:

- POS orders;
- payment method split: cash, card, BLIK, transfer;
- settlement delay per payment method;
- refunds;
- purchase invoices;
- supplier due dates;
- recurring expenses;
- payroll and staff cost;
- tax/VAT/ZUS estimate;
- loan and leasing repayment;
- planned inventory purchases;
- starting cash balance.

Outputs:

- daily cash-in forecast;
- daily cash-out forecast;
- expected daily ending balance;
- best/base/worst scenarios;
- cash gap;
- safe buffer;
- days until cash stress;
- free cashflow;
- repayment capacity.

### 6.2 Inventory Capital Engine

Inputs:

- product stock;
- purchase price / FIFO lots;
- sales velocity;
- gross margin;
- purchase invoice lines;
- PZ and WZ movements;
- supplier lead time.

Outputs:

- inventory value;
- money locked in slow stock;
- days to sell out;
- fast-moving stockout risk;
- suggested reorder amount;
- products to stop buying;
- products suitable for inventory financing.

### 6.3 Staff Cost Engine

Inputs:

- POS shifts;
- staff profile;
- attendance;
- payroll settings;
- hourly wage;
- base salary;
- commission;
- overtime;
- tips if tracked;
- staff sales attribution.

Outputs:

- staff cost per day;
- staff cost per shift;
- labor cost ratio;
- commission payable;
- payroll due date;
- staff cost forecast;
- contribution margin after staff cost.

### 6.4 Funding Need Engine

Formula:

```text
Funding need =
  forecast cash gap
  + growth investment needed
  + safe cash buffer
  - available cash
```

Outputs:

- recommended funding range;
- maximum safe funding amount;
- minimum useful funding amount;
- warning if borrowing would create repayment stress.

### 6.5 Repayment Capacity Engine

Formula:

```text
Free cashflow =
  cash-in
  - supplier payments
  - payroll
  - rent and fixed expenses
  - tax/VAT/ZUS reserve
  - existing debt service
  - safe buffer
```

Outputs:

- safe monthly repayment;
- safe daily repayment;
- safe percentage-of-sales repayment;
- repayment duration simulation;
- cash buffer breach date.

### 6.6 Product Matching Engine

Financing type should be selected by rule first:

- inventory financing: strong sales, stockout risk, fast-moving SKU need;
- merchant cash advance: stable POS card/BLIK/cash sales;
- factoring/invoice financing: unpaid B2B invoices;
- revolving credit line: seasonal cashflow swings;
- leasing: equipment, machines, vehicles, salon equipment;
- working capital loan: general cash gap with stable repayment capacity;
- no funding yet: weak sales, high refund, negative free cashflow, or missing records.

AI can explain this rule-based result.

## 7. ERP Modules

### 7.1 KSeF Inbox

Purpose:

Receive purchase invoices from KSeF and use them as financial source data.

Features:

- KSeF settings: NIP, environment, auth method, token/certificate;
- session management;
- fetch purchase invoice headers;
- download invoice XML;
- normalize XML into invoice header and line data;
- store raw XML;
- deduplicate by KSeF number, supplier NIP, invoice number;
- show inbox statuses: NEW, MAPPED, READY_FOR_PZ, POSTED, IGNORED, ERROR;
- audit every fetch and conversion action.

Tables:

- `ksef_settings`;
- `ksef_sessions`;
- `ksef_fetch_runs`;
- `ksef_inbox_documents`;
- `ksef_inbox_lines`;
- `ksef_audit_log`.

Implementation notes:

- Use POS Zira as the main app.
- Reuse offline-invoice KSeF domain code as reference.
- Do not rely only on the old stub service. KSeF invoice ops and session v1/v2 code should be reviewed and ported carefully.
- Keep raw XML for audit.

### 7.2 Purchase Invoices

Purpose:

Track business purchases, supplier payables, input VAT, cost of goods, and expenses.

Features:

- create manually;
- create from KSeF inbox;
- create from PDF/OCR later;
- supplier snapshot;
- invoice totals;
- due date;
- payment status;
- item lines;
- linked product/expense mapping;
- confirm purchase invoice;
- mark paid;
- cancel with audit.

Tables:

- `purchase_invoices` or extend `invoices` with `direction = PURCHASE`;
- `purchase_invoice_items`;
- `purchase_invoice_payments`;
- `purchase_invoice_audit_log`.

Recommended approach:

POS Zira already has `invoices` and `invoice_items`. Use a direction field and migrate schema carefully instead of creating a completely separate parallel invoice model unless necessary.

### 7.3 Suppliers

Purpose:

Track vendors and support invoice matching, payment planning, and finance reports.

Fields:

- name;
- NIP;
- address;
- country;
- email;
- phone;
- bank account;
- payment terms;
- default expense category;
- active flag.

Tables:

- `suppliers`;
- `supplier_payment_terms`;
- `supplier_aliases`.

### 7.4 Product Mapping

Purpose:

Turn purchase invoice lines into products, inventory, PZ, or expenses.

Line classifications:

- `STOCK_PRODUCT`;
- `SERVICE_EXPENSE`;
- `ASSET`;
- `SHIPPING_COST`;
- `TAX_OR_FEE`;
- `UNKNOWN`;
- `IGNORE`.

Matching signals:

- barcode/EAN;
- SKU/code;
- supplier NIP + supplier product code;
- exact name;
- historical mapping;
- fuzzy name match;
- unit and VAT similarity;
- purchase price range.

Tables:

- `supplier_product_mappings`;
- `product_aliases`;
- `purchase_invoice_line_mappings`;
- `mapping_suggestions`;
- `mapping_audit_log`.

AI role:

- suggest likely mapping;
- explain mismatch;
- group similar supplier names;
- warn if line looks like service/expense, not stock.

Deterministic rule:

- only auto-map high-confidence exact matches;
- require user review for new product creation or low confidence;
- never auto-post PZ from ambiguous mapping.

### 7.5 PZ Goods Receipt

Purpose:

When a confirmed purchase invoice includes stock products, create PZ and add stock.

Flow:

1. Purchase invoice is confirmed.
2. Product-mapped lines are selected.
3. PZ document is generated.
4. Product stock increases.
5. FIFO lots are created.
6. Inventory value updates.

Tables:

- `pz_documents`;
- `pz_document_items`;
- `pz_sequences`.

Implementation source:

Port the core logic from offline-invoice `pz.service.ts`.

### 7.6 FIFO Kardex

Purpose:

Know real inventory value, cost of goods sold, margin, and capital locked in stock.

Movement types:

- `OPENING`;
- `PZ`;
- `WZ`;
- `ADJ`;
- `RETURN`;
- `LOSS`.

Tables:

- `inventory_movements`;
- `inventory_lots` if split from movement rows later;
- `stock_snapshots` optional for faster reporting.

Core rule:

- PZ creates positive lots with remaining quantity.
- WZ consumes oldest lots first.
- Cost of goods sold uses consumed FIFO cost.
- Stock can go negative only with explicit warning/audit.

### 7.7 WZ / Sales Issue

Purpose:

Connect POS sales to inventory issue and COGS.

Flow:

1. POS sale is completed.
2. Product lines are linked to product variants.
3. WZ movement consumes FIFO.
4. COGS is recorded.
5. Gross margin is known.

Tables:

- `wz_documents`;
- `wz_document_items`;
- `inventory_movements`;
- link to `orders` and `order_items`.

### 7.8 Expenses

Purpose:

Capture operational costs that are not stock.

Sources:

- KSeF purchase invoice lines;
- manual recurring expenses;
- payroll;
- loan repayments;
- leasing;
- rent;
- utilities;
- accountant;
- subscriptions;
- marketing;
- tax/VAT/ZUS estimate.

Tables:

- `expense_categories`;
- `expense_entries`;
- `recurring_expenses`;
- `payables`;
- `loan_obligations`.

### 7.9 Staff Cost

Purpose:

Know whether revenue is strong enough after labor cost.

Data sources:

- POS `pos_staff`;
- POS shifts;
- backend Attendance module;
- backend Payroll module;
- staff commission settings.

Tables/cache in POS:

- `staff_cost_rules`;
- `staff_attendance_cache`;
- `staff_payroll_cache`;
- `staff_cost_daily`;
- `staff_commission_runs`.

Outputs:

- staff cost per day;
- staff cost per shift;
- labor ratio;
- commission payable;
- payroll due date;
- projected payroll cash-out.

### 7.10 Cashflow

Purpose:

Show daily future cash balance.

Views:

- today;
- 7 days;
- 30 days;
- 90 days.

Cards:

- cash in;
- cash out;
- expected balance;
- supplier due;
- payroll due;
- tax reserve;
- inventory cash locked;
- safe buffer;
- stress date.

### 7.11 Capital Advisor

Purpose:

Answer: how much should this business borrow, for what, how long, and what documents are needed?

Outputs:

- recommended funding amount;
- maximum safe funding amount;
- recommended product type;
- repayment duration;
- repayment method;
- risk warnings;
- use-of-funds plan;
- document checklist;
- merchant finance report.

Example:

```text
Recommended funding: 12,000-16,000 PLN
Product type: inventory financing
Duration: 60-90 days
Reason: stable revenue, low refund rate, fast-moving products often out of stock
Warning: do not borrow 30,000 PLN now; cash buffer would break after payroll week
Documents: KSeF purchase invoices, POS sales report 90 days, bank statement, supplier invoices, payroll summary
```

## 8. Business Classification

The system should classify merchants into operating states.

### 8.1 Good But Undercapitalized

Signals:

- stable revenue;
- low refund;
- strong margin;
- fast-moving products out of stock;
- supplier invoices support demand;
- repayment capacity positive.

Recommendation:

- inventory financing;
- supplier credit;
- small growth loan;
- merchant cash advance if sales are stable.

### 8.2 Weak Business

Signals:

- falling revenue;
- high refund;
- high labor ratio;
- high slow-stock value;
- negative free cashflow;
- repayment simulation breaks buffer.

Recommendation:

- do not borrow yet;
- reduce slow inventory;
- cut cost;
- improve sales;
- revise pricing;
- review after 30 days.

### 8.3 Potential But Poor Sales Execution

Signals:

- cost base is reasonable;
- margin is good;
- some products sell well;
- customer repeat signal exists;
- revenue is inconsistent or traffic is low.

Recommendation:

- small marketing/test budget;
- supplier credit for proven products;
- not a large loan;
- action plan before financing.

### 8.4 Profitable But Cash-Trapped

Signals:

- sales and margins are positive;
- receivables or inventory absorb cash;
- supplier due dates are earlier than customer cash-in;
- payroll/rent timing creates stress.

Recommendation:

- invoice financing;
- payment-term negotiation;
- smaller frequent inventory buys;
- cash buffer policy.

## 9. Finance Document Pack

The POS should create a lender-ready pack.

Documents/data:

- company data: NIP, REGON, CEIDG/KRS if available;
- POS sales report 3/6/12 months;
- payment breakdown;
- refund/discount report;
- KSeF purchase invoices;
- supplier invoices;
- inventory value report;
- payroll/staff cost report;
- recurring expense list;
- cashflow forecast;
- repayment simulation;
- use-of-funds plan;
- merchant health report.

Generated output:

- PDF report;
- CSV export;
- JSON partner export;
- consent/audit record.

## 10. UI Plan

Add sidebar group:

```text
ERP
  KSeF Inbox
  Purchases
  Suppliers
  Inventory Value
  Staff Cost
  Expenses
  Cashflow
  Capital Advisor
```

For MVP, this can start as one `ERP / Flow` tab with internal tabs:

- KSeF;
- Purchases;
- Inventory;
- Staff;
- Cashflow;
- Capital.

## 11. Implementation Plan

### Phase 0: Technical Preparation

- Keep POS Zira as the main app.
- Use offline-invoice only as reference/source for domain logic.
- Create migrations in POS Zira SQLite.
- Add feature key: `erp` or `capital`.
- Add IPC module: `erp.module.ts` or `capital.module.ts`.
- Add renderer tab: `ErpFlowTab.tsx`.
- Keep all mutations auditable.

### Phase 1: Purchase + Supplier Foundation

Implement:

- suppliers table/repo;
- purchase invoice direction/schema;
- purchase invoice service;
- purchase invoice list/detail/create/confirm/paid/cancel;
- payment due tracking.

Acceptance:

- manually create purchase invoice;
- mark it paid;
- it appears in payable/cashflow data.

### Phase 2: Product Mapping + PZ

Implement:

- supplier product mapping;
- product aliases;
- line classification;
- product creation from mapped invoice line;
- PZ generation;
- inventory movement PZ.

Acceptance:

- confirm a purchase invoice;
- mapped product lines create PZ;
- stock increases;
- inventory value updates;
- unmapped lines remain pending.

### Phase 3: FIFO Kardex + Sales WZ

Implement:

- inventory_movements;
- FIFO PZ lots;
- WZ on sale;
- COGS per order line;
- margin per product/order/day.

Acceptance:

- product sold by POS consumes FIFO lot;
- gross margin report includes real cost.

### Phase 4: KSeF Inbox

Implement:

- KSeF settings;
- fetch purchase invoice headers;
- download XML;
- normalize into inbox;
- convert inbox document to purchase invoice;
- audit log.

Acceptance:

- test KSeF environment fetch works;
- duplicate invoice is not imported twice;
- user can map and confirm KSeF invoice into PZ/payable.

### Phase 5: Staff Cost

Implement:

- sync/cache payroll or attendance summaries from backend;
- local staff cost rules for offline fallback;
- daily staff cost summary;
- labor ratio.

Acceptance:

- daily business summary shows revenue, gross margin, labor cost, and labor ratio.

### Phase 6: Expense Planner

Implement:

- recurring expenses;
- one-off expense entries;
- supplier due payments;
- loan obligations;
- tax/VAT reserve placeholders.

Acceptance:

- cashflow forecast includes rent, payroll, supplier due, loan repayment, and recurring expenses.

### Phase 7: Cashflow Engine

Implement:

- daily forecast table/function;
- base/best/worst scenario;
- safe cash buffer;
- cash gap;
- stress date;
- inventory locked capital.

Acceptance:

- user can see 30-day daily cash forecast;
- cashflow changes when purchase invoice, payroll, or expense changes.

### Phase 8: Capital Advisor

Implement:

- funding need engine;
- repayment capacity engine;
- finance product matching;
- document checklist;
- merchant health facts.

Acceptance:

- user asks "how much should I borrow?";
- system returns amount range, repayment duration, product type, warning, and document checklist.

### Phase 9: AI CFO Advisor

Implement:

- AI prompt that only consumes computed facts;
- business diagnosis;
- action suggestions;
- merchant finance report generation.

Guardrails:

- AI cannot approve/reject;
- AI cannot mutate accounting records;
- AI must cite which facts it used;
- AI must show uncertainty when data is missing.

### Phase 10: Partner Export

Implement:

- PDF Merchant Finance Report;
- JSON export for lender partner;
- consent record;
- export audit log.

Acceptance:

- merchant can export a finance pack from POS data.

## 12. Data Safety And Compliance

Rules:

- Ask merchant consent before analyzing/exporting financing data.
- Keep raw source documents.
- Keep audit log for every import, mapping, PZ, payment, report export.
- Separate advice from official credit decision.
- Make computed formulas inspectable.
- Use human review for financing decision and document submission.

Important:

Because many small Polish businesses are sole proprietors, business data can be personal data. Creditworthiness AI can become high-risk under EU AI rules if used for automated credit decisions. Therefore this system must remain an advisory and reporting layer until a regulated partner process is defined.

## 13. MVP Definition

The first useful MVP:

1. Purchase invoice module.
2. Supplier module.
3. Product mapping.
4. PZ + FIFO inventory value.
5. Staff cost daily summary.
6. Cashflow 30-day forecast.
7. Capital Advisor report.

KSeF can be phase 2 of MVP if connector work is slower, but the data model should be ready from the beginning.

## 14. Demo Scenario

Merchant asks:

> Can I borrow 20,000 PLN to buy more inventory next week?

System computes:

- 90-day sales stable;
- weekend sales strong;
- 12 fast-moving products are often out of stock;
- slow inventory is 31,000 PLN;
- payroll due in 11 days;
- safe repayment capacity is 4,800 PLN/month;
- 20,000 PLN would breach safe buffer;
- 12,000-16,000 PLN is safer.

AI explains:

> You should not borrow the full 20,000 PLN now. The business is healthy but cash buffer is tight around payroll week. A 12,000-16,000 PLN inventory-financing facility is safer, focused on the 12 fast-moving SKUs. Avoid using the loan for fixed costs. Prepare POS sales report, KSeF purchase invoices, supplier invoices, payroll summary, and bank statement.

## 15. Success Metrics

Product metrics:

- percentage of purchase invoices mapped;
- percentage of products with known cost;
- inventory value accuracy;
- cashflow forecast coverage;
- number of merchants with generated finance report;
- number of merchants classified as good-but-undercapitalized;
- number of actionable improvement plans.

Business metrics:

- ERP feature activation;
- paid add-on conversion;
- lender referral conversion;
- financing report exports;
- merchant retention.

## 16. File/Code References

Current POS Zira reference points:

- `src/main/database/migrations.ts`: local SQLite schema and migrations.
- `src/main/database/repos/order-repo.ts`: POS orders and payment data.
- `src/main/database/repos/product-repo.ts`: POS product catalog.
- `src/main/database/repos/sales-forecast-repo.ts`: sales forecast source queries.
- `src/main/forecast/forecast-service.ts`: current replenishment forecast.
- `src/main/database/repos/staff-repo.ts`: staff cache.
- `src/main/pos/shift-controller.ts`: shift sales and payment breakdown.
- `src/renderer/App.tsx`: main tab routing.
- `src/renderer/components/Sidebar.tsx`: sidebar navigation.
- `src/shared/types.ts`: feature keys, tabs, IPC channels.

Offline Invoice reference areas:

- `src/services/purchase-invoice.service.ts`: purchase invoice lifecycle.
- `src/services/pz.service.ts`: PZ generation from purchase invoice.
- `src/db/repositories/inventory-movement.repository.ts`: FIFO kardex.
- `src/db/repositories/ksef.repository.ts`: KSeF settings.
- `src/services/ksef/ksef-invoice.ts`: KSeF send/download/fetch operations.
- `src/services/ksef/ksef-session.v1.ts` and `ksef-session.v2.ts`: session handling.
- `src/db/schema.sql`: accounting/purchase/PZ/KSeF schema reference.

## 17. Implementation Principle

Do not build a generic AI dashboard.

Build this sequence:

```text
ERP source data
  -> deterministic financial facts
  -> cashflow and repayment simulation
  -> AI explanation and action plan
  -> finance report / partner export
```

This is what makes the POS a fintech product.
