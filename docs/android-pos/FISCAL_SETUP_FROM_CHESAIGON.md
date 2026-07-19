# Fiscal device setup — Che Saigon reference + nail-salon replication

Read-only inspection of the live Che Saigon POS/print-agent PC
(`DESKTOP-AK6GJ4Q`, salon `chesaigon`, salonId `1500feea-…`) on 2026-07-19, to
replicate the fiscal setup for the nail salon's Sunmi. **Nothing was modified on
the live machine — read-only only.**

## What Che Saigon actually runs

One Windows PC is BOTH the cashier POS **and** the print-agent that owns the
physical printers. Its `zira-ai/config.json` `printers` map:

| Role | protocol | port / windowsPrinter | serverPrinterId | enabled |
|---|---|---|---|---|
| **FISCAL** | `ELZAB_STX` | **COM3** (USB Serial VID_C1CA&PID_BA70) | `1a6c51c2-6bf6-4576-a24f-290e4f27b468` | yes |
| RECEIPT | WINDOWS | Xprinter XP-80T (80mm, cash drawer) | `7d866223-…` | yes |
| LABEL | ZEBRA | ZDesigner GK420d | `a628fe31-…` | yes |
| A4 / KITCHEN / TICKET | WINDOWS | — | … | no |

Fiscal-relevant flags:
- `allowRealFiscalPrint = true` (+ `elzab-dev-mock.flag.disabled` present → real ELZAB, not the mock)
- `fiscalDailyReport = { enabled:true, master:true, hour:23, minute:30, tz:Europe/Warsaw }` — **this machine is the one fiscal daily-report master**
- `fiscalOnCashSale = "ask"` — the cashier is asked whether to fiscalize a cash sale
- `printerProtocol = THERMAL`, `multiPrinterMode = true`
- COM ports present on the box: COM1 (built-in), **COM3 (the ELZAB, USB-serial)**, COM5 (Prolific PL2303 — a second USB-serial adapter)

The physical fiscal printer is an **ELZAB** (labelled "Fiskal / Posnet") on
COM3, spoken to over the **ELZAB_STX** protocol by the print-agent.

## How a printed fiscal receipt flows (this is what the Sunmi reuses)

1. A POS creates an order and asks to fiscalize.
2. A fiscal print JOB is created against the backend for the **`FISCAL_RECEIPT`
   printer role** → the backend resolves it to the salon's fiscal
   `serverPrinterId` and dispatches it to the connected print-agent that owns
   that printer.
3. The print-agent (this PC) prints on COM3 / ELZAB_STX.

The Sunmi's E-FISCAL code (committed, `702cd43`) does exactly step 1–2 with the
staff JWT — **it is a job submitter, identical to a second Windows POS**. It
never touches COM3 or the ELZAB.

## To make the nail salon "the same" (Plan A)

The ELZAB is a **physical device owned by a print-agent host at the salon** — it
cannot live on the Sunmi (Plan A, owner-approved). So the nail salon needs the
same three pieces Che Saigon has:

1. **A print-agent host at the nail salon + an ELZAB fiscal printer** on a COM
   port, protocol `ELZAB_STX`, exactly like COM3 here. (Hardware — owner
   provides. Could be a small Windows/mini-PC, same role as this Che Saigon PC.)
2. **Backend registration**: register that fiscal printer for the nail salon
   (a `serverPrinterId`) and **assign the `FISCAL_RECEIPT` role** to it, so the
   Sunmi's `listPrinterAssignments` resolves it. (Backend/DB task — I can do
   this once given the nail salon's `salonId` + the printer is registered.)
3. **Print-agent config on that host**: `FISCAL` printer = `ELZAB_STX`, correct
   COM port, `allowRealFiscalPrint=true`, `fiscalDailyReport.master=true` on
   exactly one machine, `fiscalOnCashSale` per the salon's preference.

Then the Sunmi (E-FISCAL) submits fiscal jobs and the ELZAB prints — same as
Che Saigon. The Sunmi's built-in printer covers the non-fiscal customer copy
(a later Sunmi ESC/POS driver packet).

## What I need from the owner to actually wire it

- The nail salon's **salonId / slug**.
- Confirmation of **which machine will run the nail salon's print-agent** and
  **which ELZAB model** it drives (so the COM port + role assignment can be set).
- Whether the salon reuses an existing fiscal printer/agent or gets a new one.

Until the nail salon has a print-agent host + ELZAB registered with the
`FISCAL_RECEIPT` role, the Sunmi's fiscal code runs correctly in tests but has
no physical printer to reach — exactly as Che Saigon's Sunmi would if COM3 were
empty.
