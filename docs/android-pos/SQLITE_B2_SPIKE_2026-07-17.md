# Android POS B2 synthetic SQLite spike

Date: 2026-07-17

Status: **PARTIAL GO for isolated development evidence; NO-GO for production storage or Android business writes**

Hardening branch: `codex/android-pos-sqlite-hardening`, based on `168c405`

This packet uses only `DEMO-*` data inside the development application ID `com.ziraai.posdiagnostics.dev`. It adds no Capacitor registration, JavaScript API, backend request, authentication, real salon schema, payment, print, fiscal, updater, release signer, or deployment path.

## Candidate comparison

| Candidate | Evidence and strengths | Production traps / open decisions |
| --- | --- | --- |
| `@capacitor-community/sqlite` 8.1.0 | Maintained Capacitor 8 package; Android/iOS/Electron/Web APIs; transactions, upgrade statements, import/export and encryption support. The upstream README documents JDK 21 and modern Android tooling. | It uses SQLCipher even for unencrypted native databases and explicitly warns about encryption export classification. Its generic `execute`, `query`, import/export and secret-management surface is much broader than the POS feature boundary. Upstream examples name AGP 8.7.2 and SDK 35, while this spike is on AGP 8.13, SDK 36 and minSdk 28, so exact compatibility still needs a pinned clean build. |
| Feature-oriented custom native adapter | Small auditable surface; this spike exposes only fake catalog seeding and atomic fake-order submission. It uses the platform `SQLiteOpenHelper`, transactions, foreign keys, UNIQUE constraints and WAL without adding a dependency or JS SQL bridge. | Current spike is plaintext and Android-only. Encryption/key lifecycle, safe diagnostic export, production-grade crash-durable/active-WAL corruption preservation and maintenance ownership remain unresolved. Selecting custom means owning migrations, concurrency, recovery and platform-specific tests long term. |

Primary evidence: [Capacitor community SQLite README](https://github.com/capacitor-community/sqlite), [Capacitor custom plugin documentation](https://capacitorjs.com/docs/plugins/tutorial/android-implementation), [Android `SQLiteOpenHelper`](https://developer.android.com/reference/android/database/sqlite/SQLiteOpenHelper), [Android database testing guidance](https://developer.android.com/training/data-storage/room/testing-db), and [Android backup rules](https://developer.android.com/identity/data/autobackup).

Owner selection is deliberately **OPEN**. This spike does not approve either candidate for production and does not treat “supports encryption” as a complete key-management/export decision.

## Implemented synthetic boundary

- `SyntheticLedgerOpenHelper` creates only `fake_catalog`, `fake_orders`, `fake_order_items`, and `fake_order_upload_journal`.
- One transaction inserts the immutable fake order, every item, and exactly one upload intent.
- Database constraints enforce one journal per order and unique order-command, idempotency and client-attempt lineages. Separate two-connection races hit each journal key with different local order IDs, prove the losing order/items roll back, and re-read the winning persisted payload hash. Item foreign keys, rollback, and cascade deletion are exercised.
- `SCHEMA_V1 -> SCHEMA_V2` adds a catalog revision using `SQLiteOpenHelper`'s transactional migration.
- Foreign keys and WAL are enabled and exercised. The test proves a non-empty WAL exists, performs a full checkpoint that completes without `SQLITE_BUSY` and checkpoints every observed frame, runs `integrity_check`, then closes/reopens and checks integrity again. This is not power-loss evidence. An attempted custom `busy_timeout=5000` assertion exposed that the API 36 framework reported `2500` after open, so the unproven override was removed; lock-wait policy remains an explicit owner decision rather than a false guarantee.
- A custom corruption handler writes and fsyncs a persistent lock under `noBackupFilesDir`, copies the database and known sidecar paths to temporary incident files, fsyncs and verifies SHA-256 before publication (atomic when supported), retains the locked sources, and throws to stop Android's automatic post-corruption reopen. Every later helper open checks the lock first. Only test cleanup removes it; no production recovery/unlock path exists. Directory-entry fsync and an active multi-connection WAL snapshot remain outside this evidence.
- The transaction wrapper preserves a primary SQLite failure and attaches any `endTransaction()` failure as suppressed. This prevents a secondary “no transaction is active” rollback error from hiding `SQLiteFullException`.
- The repository allowlists its count targets and exposes no generic raw-SQL method. Nothing registers it as a Capacitor plugin or calls it from the WebView.
- Existing manifest policy remains `allowBackup=false`; executable instrumentation parses exact `path="."` exclusions in the legacy root and independently in the Android 12+ `cloud-backup` and `device-transfer` sections.

## Executable evidence

Linux build host:

- debug app + AndroidTest assembly: pass (`143` Gradle tasks; `9` executed in the final APK build);
- full Android build/unit/assembly gate: pass (`196` Gradle tasks; `50` executed), merged debug/release manifest policy: pass;
- Windows Electron build/typecheck: pass; cross-platform boundary suite: `53/53` pass;
- `git diff --check`: pass.

Cold API 36 emulator on Alienware:

- AVD started with `-wipe-data`, no snapshot, hardware acceleration and fresh APK installs;
- default Stage 1/Stage 2/B2 instrumentation with no host phase: `OK (13 tests)`, `INSTRUMENTATION_CODE: -1`; 12 tests execute and the host-only reinstall probe is assumption-skipped, so the normal Gradle runner remains green;
- guarded host reinstall runner uninstalls both packages, confirms both package paths absent, fresh-installs both APKs, then verifies database, credential/device-protected files/preferences, no-backup and app-external sentinels are absent: seed `OK (1 test)`, verify `OK (1 test)`, final `PASS Android reinstall probe`;
- LocalTransport backup probe: `Backup is not allowed`, followed by another uninstall/fresh-install and all-sentinel verification: `OK (1 test)`; this is not cloud or OEM device-transfer evidence;
- app APK SHA-256: `cc0c7278a8a5e1677c07b115affadfc8fe7a6f625716b3309c37677f770ec06c`;
- AndroidTest APK SHA-256: `88c46064901219622a17a04f617a3dae76fdb50a87d366dbfa6fd70486d6593f`;
- emulator and persistent ADB server stopped after the run.

The ten database tests prove:

1. order + items + upload intent commit atomically and survive close/reopen;
2. an injected failure before journal insert rolls the whole order transaction back;
3. three separate two-helper races cover `order_command_id`, `idempotency_key`, and `client_attempt_id`, leaving one winning hash and no orphan loser rows;
4. missing-catalog foreign keys roll back the command and deleting an order cascades to its items/journal;
5. V1 data survives the V2 migration with the expected default;
6. a deliberately broken V2 migration rolls back, leaving the V1 database readable and later recoverable by the valid migration;
7. compiled manifest/backup resources exclude every durable domain at `path="."` in the legacy, cloud, and device-transfer sections;
8. a constrained `max_page_count` in rollback-journal mode produces a real engine `SQLiteFullException` without filling the AVD, rolls the order/items/journal back, restores the original limit, then accepts a small write and passes integrity checking;
9. deliberate main-file damage invokes quarantine, retains the damaged source hash, publishes an equal SHA-256 incident copy and manifest, creates a persistent lock, and blocks a second helper from silently creating/opening a blank database;
10. a bounded direct handler test preserves synthetic `.db`, `-wal`, `-shm`, and `-journal` files byte-for-byte at both locked source and incident paths. This proves path coverage, not consistency of a real active WAL snapshot.

The separate reinstall probe is assumption-skipped when no phase is present so normal instrumentation remains compatible, and fails for any unknown explicit phase. The guarded host runner always supplies `seed` or `verify`, brackets them with real package uninstalls and fresh installs, checks `ro.kernel.qemu=1`, requires exactly one selected emulator and never uses `adb install -r`:

```bash
npm run test:android:reinstall -- --serial emulator-5554
```

The disposable LocalTransport check used the same seed/verify phase around fresh installs:

```bash
adb shell bmgr enable true
adb shell bmgr transport com.android.localtransport/.LocalTransport
adb shell bmgr backupnow com.ziraai.posdiagnostics.dev
# uninstall both packages, fresh-install both APKs, then run reinstallPhase=verify
adb shell bmgr enable false
```

## Remaining acceptance gaps

This is not a complete B2 acceptance packet yet:

- no physical process kill at each transaction boundary, device reboot or OS-update matrix;
- no real filesystem-exhaustion test; `max_page_count` proves the SQLite engine error path in rollback-journal mode, not OS low-storage behavior or WAL under storage pressure;
- no power-loss/process-kill/reboot test around WAL checkpoint, and the platform SQLite build has not been qualified against current upstream WAL-reset fixes;
- corruption quarantine is plaintext synthetic evidence only; directory metadata is not fsynced, real sidecar consistency under active multi-helper/process WAL, crash-durable publication, encrypted diagnostic export and owner recovery/unlock remain unproven;
- LocalTransport dynamically refused backup as intended, but Google cloud restore and OEM device-to-device transfer have not been exercised;
- no SQLCipher build, encryption key generation/rotation, export classification review or recovery-key decision;
- no physical target tablet evidence and no long-running concurrency/load test.

Until those gaps and the owner gate close, the fake schema must not be renamed/reused as the real POS schema. Android auth, catalog backend reads, carts, orders, shifts, events, payments, printing and fiscal work remain disabled. Chesaigon, production backend, real POS databases, machine identity, credentials and printer/fiscal configuration were not accessed.

Lifecycle: planned and implemented on an isolated feature branch; compiled and emulator-tested; not landed on canonical; not production-built; not deployed; not verified live.
