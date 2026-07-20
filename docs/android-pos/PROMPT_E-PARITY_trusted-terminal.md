# Prompt — E-PARITY: make the Sunmi connect and behave EXACTLY like the Windows POS

Owner directive (2026-07-19): the target is a **dedicated Sunmi POS terminal**
(fixed in the shop, trusted like the Windows counter). The Windows app already
connects to the print-agent, fiscal, and backend and works — so **copy the
Windows behavior faithfully; do not invent an Android-specific design.** The
"lost-tablet" security rail (staff-JWT-only, no `pa_` key, no socket) no longer
applies — a trusted fixed terminal may connect exactly like Windows.

Run these as SEQUENTIAL single claude-glm packets (one at a time, wait to
completion — never parallel; see EXPANSION_PLAN §conveyor rules). Each is one
commit with tests. Paste the packet body below into `glm-run.sh`.

---

## PACKET E-PARITY-1 — print-agent connection (pa_ key + connect + socket), like Windows

Read docs/android-pos/EXPANSION_PLAN_2026-07-19.md, the committed shim under
src/renderer/android-pos/shim/ + port/api-client.ts, and the Windows source you
are porting: src/main/network/socket-client.ts, src/main/modules/auth.module.ts
(connectWithAvailablePrintAgentKey `:919`, the `/print-agent/connect` + pa_-key
flow), src/main/config/store.ts (getSecureApiKey/setSecureApiKey). Worktree must
be clean before you start; no mutating git.

PRINCIPLE: this is a faithful PORT of the Windows connection flow, not a
redesign. Where Windows does X, do X. Cite the Windows source line for each
ported piece.

IMPLEMENT (mirror Windows exactly):
1. **pa_ key storage** — the Sunmi is a trusted terminal, so it MAY hold the
   salon-wide print-agent API key like Windows. Store/read it via the existing
   SecureKV Keystore store (shim/token-store.ts) under a `pa_key` slot,
   mirroring Windows setSecureApiKey/getSecureApiKey. Fetch it exactly like
   Windows: after login, `GET /api/v1/print-agent/my-key` (staff JWT) →
   store the returned pa_ key.
2. **connect** — port connectWithAvailablePrintAgentKey (auth.module.ts:919):
   `POST /api/v1/print-agent/connect` with the pa_ key → register this terminal
   as an agent. Same request/response as Windows.
3. **Socket.IO** — port socket-client.ts: open `io(\`${apiUrl}/print-agent\`, …)`
   with the same auth (pa_ key), the same events Windows subscribes to (print
   job status push, config updates, remote-control), the same reconnect policy.
   socket.io-client runs in the WebView (it is isomorphic); import it in the
   shim graph. Add socket.io-client to RENDERER_ALLOWED_PACKAGES in
   scripts/verify-cross-platform-boundaries.mjs and RELAX the WebSocket/socket
   ban FOR THE SHIM GRAPH ONLY to the `/print-agent` + `/print-agent-remote`
   namespaces (still forbid arbitrary WebSocket/exfil). Document the relaxation
   inline as the owner-approved trusted-terminal decision. Add fixtures.
4. **Real-time print status** — where E1a/E-FISCAL currently POLL getPrintJobStatus,
   ALSO accept the socket's job-status push events (Windows uses the socket as
   the primary signal, polling as fallback). Keep the poll fallback.
5. **Wire it into boot** — after login, mirror the Windows sequence: fetch pa_
   key → connect → open socket. On logout, disconnect + clear the pa_ key like
   Windows. Do this in the real-transport login/logout, not the renderer.

HARD LIMITS (still real — these are hardware/platform, NOT security rails):
- Do NOT attempt to drive a serial/USB fiscal or card device directly from
  Android — those are native x86 Windows drivers. Fiscal stays via the agent
  (E-FISCAL, done). Card is a SEPARATE later packet (E-PARITY-2) because it
  needs the Elavon terminal.
- If socket.io-client is not already an installable renderer dependency, STOP
  and report — do not add a brand-new npm dependency without approval; it is in
  package.json for the main process, confirm it resolves for the renderer build.

TESTS tests/android-agent-connect.test.ts (stub fetch + a fake socket): pa_ key
fetched + stored after login; connect POSTs /print-agent/connect with the key;
socket opens to the /print-agent namespace with the pa_ auth; a job-status push
event resolves a pending print without polling; logout disconnects + clears the
pa_ key. Keep ALL existing suites green (the boundary relaxation must not weaken
the arbitrary-WebSocket/exfil ban — add a NEGATIVE fixture proving a non-agent
WebSocket still fails).

ACCEPTANCE (run once, then STOP): npm run build:android:web; npm run
test:android:boundaries; npx vitest run tests/android-agent-connect.test.ts
tests/android-remote-print.test.ts tests/android-fiscal-print.test.ts
tests/cross-platform-boundary-verifier.test.ts tests/android-shim.test.ts.
Report: Windows source line citations, the boundary relaxation (exact
namespaces), socket events wired, and the socket.io-client dependency status.

---

## PACKET E-PARITY-2 — electronic payment (CARD/BLIK) like Windows, over the agent

Prereq: E-PARITY-1 (socket connected). Port the Windows Elavon card flow
(src/main/network/socket-client.ts + src/main/modules/pos.module.ts
requestElavon/elavon:payment-response) EXACTLY: the POS requests a card payment
over the print-agent socket, the terminal captures, the response comes back over
the socket, and ONLY THEN is the order created as paid. Lift the CASH-only guard
in real-transport.createOrder to allow CARD/BLIK **only when a real capture
reference is present** (mirror Windows — never mark PAID without the terminal's
authorization/reference). Requires the salon's Elavon card terminal reachable
via the agent (same as Windows). If no card terminal is configured, card stays
disabled gracefully.

## PACKET E-PARITY-3 — product admin like Windows

Port the `/api/v1/warehouse/product-admin` routes (api-client.ts productAdminRequest
`:1586`, productAdminMultipartRequest `:1655`) with the SAME auth Windows uses.
Wire pos.productAdmin.* (create/edit variant, stock adjust, scan-import). A
trusted terminal may use the pa_ key path if that is what Windows uses.

## PACKET E-PARITY-4 — Sunmi built-in ESC/POS printer (customer copy)

Native Capacitor plugin using Sunmi's Android printer SDK (InnerPrinter AIDL /
`woyou.aidlservice.jiuiv5`) for the non-fiscal customer receipt copy. Needs the
physical Sunmi to test. The legal fiscal receipt still comes from the ELZAB via
the agent (E-FISCAL).

---

### Honest caveats (state these; do not paper over them)
- E-PARITY-1/3 are pure software and testable in CI. E-PARITY-2 (card) and
  E-PARITY-4 (Sunmi printer) need PHYSICAL hardware to verify — unit tests prove
  the wiring, not the paper/terminal.
- "Exactly like Windows" holds for the connection/protocol/auth layer. It does
  NOT extend to Windows' native serial/USB drivers — those are replaced by the
  agent (fiscal) or an Android-native plugin (Sunmi printer). This is physics,
  not a choice.
