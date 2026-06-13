# Fiscal Daily Report Autoprint Plan, ELZAB Zeta Online

Date: 2026-06-13  
Project: POS-zira, Chesaigon POS1 fiscal-printer master  
Scope: investigate and harden automatic `raport fiskalny dobowy` printing without touching normal fiscal receipt printing.

## Current Context

The POS app has an automatic fiscal daily report scheduler on POS1.

Implemented pieces:

- `src/main/modules/fiscal-daily-report.module.ts`
  - Runs a local timer every 30 seconds.
  - On POS1 master, after configured Warsaw time, calls `HardwareModule.printFiscalDailyReport`.
  - Records result in local SQLite table `fiscal_daily_report_runs`.

- `src/main/modules/hardware.module.ts`
  - Resolves the configured fiscal printer.
  - Calls `ElzabDriver.printDailyReport`.

- `src/main/hardware/elzab/elzab-driver.ts`
  - Uses the ELZAB sidecar bridge for reports.
  - Normal receipt printing uses a separate path and must not be changed for this task.

- `resources/elzab/sidecar/elzab-stx-sidecar.ps1`
  - Has native ELZAB functions:
    - `DailyReport(int Unconditionally)`
    - `DailyReportPaperPrint(int Unconditionally)`
    - `DailyReportViaDeviceSettingsPrint(int Unconditionally)`
    - `DailyReportInternalPrint(int Unconditionally)`
    - `DailyReportNumber(ref int Number)`
  - Current report command calls `DailyReportPaperPrint($unconditionally)`.
  - It reads `beforeReportNumber` and `afterReportNumber`, but the app currently treats any native return code `0` as success.

Observed incident:

- On 2026-06-12, user manually printed `raport dobowy` around 22:00 for safety.
- Auto scheduler ran at 23:58 Warsaw and local POS1 DB/log marked SUCCESS.
- In the morning no additional physical daily report paper was found.

Important interpretation:

- This is not enough to prove the command is broken.
- Because a manual daily report was already printed at 22:00, the 23:58 command may have returned OK but produced no new fiscal report/paper if there were no sales after 22:00.
- The current code is still too weak because it records SUCCESS without verifying that the ELZAB daily report number increased.

## Fiscal Receipt vs Fiscal Daily Report

These are different operations.

Normal fiscal receipts:

- Use the receipt path:
  - `ReceiptCancel`
  - `ReceiptBegin`
  - `pReceiptItemEx`
  - `FillPaymentSTX`
  - `ReceiptEnd` / `ReceiptEndEx`
- Have order/payment idempotency via `fiscalAttemptRepo`.
- Are business-critical and already working for card/cash fiscal orders.
- Must not be modified unless absolutely necessary.

Fiscal daily report:

- Uses report commands only:
  - currently `DailyReportPaperPrint`
- Has no order items, prices, payment methods, or VAT mapping from POS.
- Closes the current fiscal period on the physical printer.
- Needs a separate confirmation mechanism based on printer report number and physical paper.

## Problem To Solve

We need a reliable way to prove the report command:

1. Actually reaches the ELZAB printer.
2. Actually creates a fiscal daily report.
3. Prints paper when expected.
4. Does not mark scheduler success when no new report was created.
5. Does not interfere with normal fiscal receipt printing.

## Recommended Direction

Add a manual admin-only test button in Printer Settings first.

This is better than setting the scheduler 5 minutes ahead because:

- It gives immediate feedback while the user is physically beside the printer.
- It can show before/after report numbers and native ELZAB result data.
- It avoids waiting for a timer and guessing whether the scheduler or command failed.
- The exact same command can later be used by the 23:58 scheduler.

Do not remove the button after the test. Keep it hidden under Advanced/Admin with a strong confirmation. It is useful as an emergency tool if auto-report fails in the future.

## Proposed Implementation

### 1. Sidecar hardening

File:

- `resources/elzab/sidecar/elzab-stx-sidecar.ps1`

Change report command to return stronger diagnostics:

- Read `DailyReportNumber` before command.
- Execute candidate report command.
- Read `DailyReportNumber` after command.
- Return JSON data:
  - `reportKind`
  - `commandUsed`
  - `unconditionally`
  - `beforeReportNumber`
  - `afterReportNumber`
  - `reportNumberIncreased`
  - `target`

Treat a native return code `0` with unchanged report number as a distinct diagnostic state:

- `ELZAB_NO_DAILY_REPORT_CREATED`

Do not blindly call this success in the app.

If `DailyReportNumber` cannot be read before the command:

- Do not send the fiscal daily report command.
- Return `ELZAB_DAILY_REPORT_NUMBER_UNAVAILABLE`.

If the command is sent and returns OK, but the after-number cannot be read:

- Return `ELZAB_DAILY_REPORT_CONFIRMATION_UNKNOWN`.
- Do not auto-retry from the scheduler, because the command may already have created or printed the daily report.

### 2. Try command variants safely

Start with the current command:

1. `DailyReportPaperPrint(1)`

If it returns OK but report number does not increase during manual test, try:

2. `DailyReportViaDeviceSettingsPrint(1)`

Only if still needed, investigate:

3. `DailyReport(1)` with explicit print mode if ELZAB docs/header support it safely.

Do not change receipt commands.

### 3. Driver return value

File:

- `src/main/hardware/elzab/elzab-driver.ts`

Current `printReport` returns `Promise<void>` and discards sidecar `data`.

Change narrowly:

- Return the `ElzabOperationResult` data or a typed `FiscalDailyReportResult`.
- Keep `printReceipt` behavior unchanged.
- For reports, let caller know:
  - native success/failure
  - before/after report number
  - command used

### 4. Hardware module return value

File:

- `src/main/modules/hardware.module.ts`

Change `printFiscalDailyReport` from `Promise<void>` to returning the report result.

Keep the current printer selection and connection check.

### 5. Scheduler success criteria

File:

- `src/main/modules/fiscal-daily-report.module.ts`

Do not mark `fiscal_daily_report_runs.status = SUCCESS` only because the ELZAB DLL returned OK.

Mark success only when:

- `afterReportNumber > beforeReportNumber`, or
- a future confirmed ELZAB result explicitly proves a report was created.

If no report was created:

- Record status as FAILED or a new diagnostic status if the local schema supports it.
- Store message like:
  - `ELZAB_NO_DAILY_REPORT_CREATED: Daily report command returned OK but report number did not increase.`
- Retry according to configured retry rules.

If confirmation is unknown after the command was sent:

- Record FAILED with a non-retryable diagnostic.
- Stop automatic retries for that day until a human checks printer paper/report number.

### 6. Manual Settings button

File likely involved:

- `src/renderer/components/Settings.tsx`
- preload/electron API file if present
- shared IPC definitions in `src/shared/types.ts`
- `src/main/modules/hardware.module.ts` IPC handlers

Add UI under fiscal printer / advanced printer settings:

- Button label: `Print fiscal daily report now`
- Visible only when fiscal printer is configured.
- Visible and callable only on the configured fiscal daily-report master POS.
- Prefer hidden behind Advanced/Admin area.
- Confirmation modal text:
  - "This will close the current fiscal day on the ELZAB printer now. Continue only if you are physically beside the printer and ready to collect the report."

Button result should show:

- Success/failure.
- Command used.
- Before/after report number.
- Message if no report was created.

### 7. Config

Current scheduler config:

- POS1: enabled/master true.
- POS2: disabled/master false.

For Chesaigon:

- Keep only POS1 as fiscal daily report master.
- POS2 must never auto-print daily report.

Consider setting:

- `unconditionally: true`

Reason:

- The goal is daily paper/report certainty.
- If there were no sales since the previous report, behavior must be verified with the physical printer. If ELZAB still does not create a new report, the app should report `NO_REPORT_CREATED`, not fake success.

## Physical Test Plan

Run this while the user is physically at POS1 and the fiscal printer.

### Before code restart

1. Confirm POS1 is the machine connected to ELZAB Zeta Online.
2. Confirm POS2 is not master for daily report.
3. Keep normal sales flow untouched.

### After patched POS1 app starts

1. Open Settings -> Printer / Fiscal printer.
2. Confirm fiscal printer status is connected.
3. Use the manual button once.
4. Watch physical printer:
   - Did a `RAPORT FISKALNY DOBOWY` print?
   - What report number is printed?
5. Check app result:
   - before report number
   - after report number
   - command used
   - success/failure

### Expected passing result

- Paper prints.
- `afterReportNumber > beforeReportNumber`.
- Local log records the same numbers.
- Local DB records SUCCESS only after report number increment.

### If no paper prints

Classify by data:

- Native command failed:
  - inspect error code and local menu/device state.

- Native command returned OK but report number unchanged:
  - command variant is wrong for this printer/mode.
  - try `DailyReportViaDeviceSettingsPrint(1)`.

- Report number increased but no paper:
  - fiscal memory report was created, but print mode/output is wrong.
  - investigate ELZAB print mode commands before changing scheduler.

## Operational Warning

Printing a fiscal daily report closes the current fiscal period.

If tested at 18:00-19:00 while the shop keeps selling until 22:00:

- The first report covers sales until the test time.
- Later sales may belong to the next fiscal report period.
- This is acceptable for a controlled test if the user keeps the paper and knows there may be two fiscal reports for one calendar day.

Safer alternatives:

- Test after closing.
- Test before first sale of a day, if there is a known pending fiscal period.
- Test once during a quiet time only if resolving the automation is higher priority than keeping one clean daily period.

## What Not To Do

- Do not change normal fiscal receipt item/payment code.
- Do not touch `ReceiptBegin`, `pReceiptItemEx`, `ReceiptEnd`, or fiscal receipt idempotency unless the investigation proves they are involved.
- Do not run this command on POS2.
- Do not mark auto-report SUCCESS without report-number evidence.
- Do not rely only on app logs. Physical paper or report number increment is required.

## Verification Checklist For The Patch

Code/build:

- `npm run build:main`
- `npm run typecheck:renderer`

Runtime:

- POS1 fiscal printer connected.
- Manual button prints or reports a clear diagnostic.
- `fiscal_daily_report_runs` records correct status.
- App logs include command used and before/after report number.
- Normal fiscal receipt printing still works for a card order after the change.

Production rollout:

- Patch POS1 source first.
- User restarts POS1 when no customers are affected.
- POS2 can pull/build later, but config remains disabled/master false.

## Current Recommendation

Implement the manual admin test button and stronger report-number validation first.

Once a real manual test proves which ELZAB command prints a daily report correctly, update the 23:58 scheduler to use that exact same command and success criteria.
