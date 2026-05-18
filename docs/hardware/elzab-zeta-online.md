# ELZAB Zeta Online install runbook

## Scope

ELZAB Zeta Online is handled as a fiscal printer, not as a generic ESC/POS
thermal printer. In the app the canonical protocol name is `ELZAB_STX`.
Server values `ELZAB`, `STX`, and `ELZAB_STX` map to `ELZAB_STX` and are
forced into the `FISCAL` slot.

Current app support is a safe integration boundary only:

- config/routing/status/test seams exist for `ELZAB_STX`
- the driver auto-runs the bundled PowerShell sidecar when the official
  `ElzabDR.dll` is present locally
- fiscal receipt and report commands require a sidecar built against ELZAB's
  official `elzabdr`/STX API and verified on real hardware
- no output is sent through the thermal ESC/POS driver and no non-fiscal output
  is labelled fiscal

## Official sources

- Downloads: https://www.elzab.com.pl/pl/strefa-dla-klienta/do-pobrania/programy
- Product page: https://www.elzab.com.pl/pl/kasy-i-drukarki-online/drukarki-sklepowe-online/elzab-zeta-online
- Extended manual: https://www.elzab.com.pl/download/io/B20IO00017_int.pdf

Relevant ELZAB downloads for fiscal printers online:

- `Usb_cdc_ser.zip` - USB CDC serial driver for ELZAB Online fiscal printers.
- `hccrndis_win7_8_10.zip` - optional USB RNDIS network driver for Zeta Online.
- `Stampa.zip` - Windows service/preflight tool.
- `om_iprg.zip` - programmer manual.
- `elzabdr.zip` - 32/64-bit Windows DLL, Linux SO, and sample receipt program.

## Current Zira sidecar

Zira ships a PowerShell sidecar at `resources/elzab/sidecar/elzab-stx-sidecar.ps1`.
The Electron bridge auto-discovers it in development and in packaged builds. The
sidecar loads ELZAB's official `ElzabDR.dll` with P/Invoke and supports:

- `check`, `connect`, and `status` by opening the configured COM/IP target,
  reading device name/status/VAT, then closing the connection
- `test` as a non-fiscal STX printout
- `receipt` as a real fiscal receipt only when `ALLOW_REAL_FISCAL_PRINT=true`
  is set before starting the app

The sidecar searches for `ElzabDR.dll` in:

- `ZIRA_ELZABDR_DLL`
- `ZIRA_ELZABDR_DIR\ElzabDR.dll`
- `%APPDATA%\zira-ai\elzab\elzabdr\Windows\x64\ElzabDR.dll` on 64-bit Windows
- `%APPDATA%\zira-ai\elzab\elzabdr\Windows\x86\ElzabDR.dll` on 32-bit Windows

For development, extracting ELZAB's official `elzabdr.zip` into
`%APPDATA%\zira-ai\elzab\elzabdr` is enough for auto-discovery. For production,
install or copy the official SDK files with the deployment and keep
`ALLOW_REAL_FISCAL_PRINT` off until authorized service is present for go-live.

The manual lists USB-B and RJ45 RS-232 computer interfaces, built-in
WiFi/Bluetooth, and protocol service choices `ELZAB`, `STX`, and `THERMAL`.
For Zira, choose `ELZAB` or `STX`; do not use printer-side `THERMAL` for fiscal
integration.

## USB CDC COM path

Use this path first for Chesaigon unless the installer has a stronger reason to
prefer IP.

1. Download `Usb_cdc_ser.zip` and the USB driver installation PDF from the
   official ELZAB downloads page.
2. Install the driver as Administrator before plugging the printer in, or follow
   the PDF's manual driver binding steps after Windows detects the device.
3. Connect USB-B from printer to POS PC.
4. Confirm Windows Device Manager shows an ELZAB USB CDC serial device with a
   stable `COMx` port.
5. In the printer menu, configure the computer service/protocol to `ELZAB` or
   `STX`, not `THERMAL`.
6. In Zira, configure the `FISCAL` printer slot:
   - protocol: `ELZAB_STX`
   - port: the detected `COMx`
   - baudRate: installer/service recommendation, default `9600` until verified
7. Extract `elzabdr.zip` under `%APPDATA%\zira-ai\elzab\elzabdr`, or set
   `ZIRA_ELZABDR_DIR` / `ZIRA_ELZABDR_DLL` to the official SDK DLL location.
   Zira will then auto-load the bundled PowerShell sidecar.

## Optional RNDIS/IP path

Use this only if service chooses network transport.

1. Download `hccrndis_win7_8_10.zip` and the RNDIS installation PDF from ELZAB.
2. Install the RNDIS driver and connect USB-B.
3. Confirm Windows creates a network adapter for the printer.
4. Configure printer network/service settings:
   - protocol: `ELZAB` or `STX`
   - TCP mode/port per service decision
   - IP/server settings per service decision
5. Verify IP reachability from the POS PC.
6. In Zira, configure `FISCAL` with protocol `ELZAB_STX` and the verified
   address. Real printing still requires the official sidecar.

## Stampa preflight

Before Zira is considered blocked or broken, prove the hardware path outside
Zira:

1. Install `Stampa.zip`.
2. Run Stampa as Administrator.
3. Select the same COM port or IP path that Zira will use.
4. Confirm Stampa can connect, read status/device information, and run the
   service-approved test.
5. If Stampa cannot communicate, fix driver, cable, printer-side protocol, baud,
   TCP mode, or service state before touching Zira.
6. Record the final COM/IP, protocol, baud/TCP port, firmware, and service notes.

## Serwis and fiskalizacja prerequisites

Do not schedule go-live on assumptions. Fiscal use requires:

- authorized ELZAB service involvement
- fiscalization/registration completed for the business and tax office workflow
- correct VAT/PTU rates and header data configured by service
- internet/online reporting status healthy on the device
- daily report obligations explained to the owner
- service decision on protocol (`ELZAB` or `STX`) and transport (USB COM or IP)
- Zira sidecar validated with real receipt and report flows before live sales

## Chesaigon install checklist

- POSNET printer remains configured in its own `FISCAL` path.
- ELZAB Zeta Online is added as a separate backend printer row with protocol
  `ELZAB`, `STX`, or `ELZAB_STX`; the agent maps it to `FISCAL`/`ELZAB_STX`.
- ELZAB is not configured as `THERMAL`, `WINDOWS`, or `RECEIPT`.
- USB CDC or RNDIS driver is installed from ELZAB's official downloads page.
- Device Manager shows the expected COM port or network adapter.
- Printer-side protocol is `ELZAB` or `STX`.
- Stampa connects and reports healthy device status.
- Authorized service confirms fiscalization and sale readiness.
- `ZIRA_ELZAB_BRIDGE_PATH` points to the approved sidecar helper.
  If this is not set, the bundled PowerShell sidecar is used automatically when
  `ElzabDR.dll` is found.
- Zira test print returns success only through the sidecar. Missing sidecar,
  missing hardware, wrong protocol, or unsupported report/receipt commands must
  return explicit errors.
- First live validation is done with service present: status check, test,
  fiscal receipt, correction/refund expectations, X/Z report path, and rollback
  to POSNET if ELZAB is not ready.
