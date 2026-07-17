# Android POS B2 synthetic SQLite spike

Date: 2026-07-17

Status: **PARTIAL GO for isolated development evidence; NO-GO for production storage or Android business writes**

Base commit: `b28e37d` on `codex/android-pos-sqlite-spike`

This packet uses only `DEMO-*` data inside the development application ID `com.ziraai.posdiagnostics.dev`. It adds no Capacitor registration, JavaScript API, backend request, authentication, real salon schema, payment, print, fiscal, updater, release signer, or deployment path.

## Candidate comparison

| Candidate | Evidence and strengths | Production traps / open decisions |
| --- | --- | --- |
| `@capacitor-community/sqlite` 8.1.0 | Maintained Capacitor 8 package; Android/iOS/Electron/Web APIs; transactions, upgrade statements, import/export and encryption support. The upstream README documents JDK 21 and modern Android tooling. | It uses SQLCipher even for unencrypted native databases and explicitly warns about encryption export classification. Its generic `execute`, `query`, import/export and secret-management surface is much broader than the POS feature boundary. Upstream examples name AGP 8.7.2 and SDK 35, while this spike is on AGP 8.13, SDK 36 and minSdk 28, so exact compatibility still needs a pinned clean build. |
| Feature-oriented custom native adapter | Small auditable surface; this spike exposes only fake catalog seeding and atomic fake-order submission. It uses the platform `SQLiteOpenHelper`, transactions, foreign keys, UNIQUE constraints and WAL without adding a dependency or JS SQL bridge. | Current spike is plaintext and Android-only. Encryption/key lifecycle, safe diagnostic export, corruption preservation and maintenance ownership remain unresolved. Selecting custom means owning migrations, concurrency, recovery and platform-specific tests long term. |

Primary evidence: [Capacitor community SQLite README](https://github.com/capacitor-community/sqlite), [Capacitor custom plugin documentation](https://capacitorjs.com/docs/plugins/tutorial/android-implementation), [Android `SQLiteOpenHelper`](https://developer.android.com/reference/android/database/sqlite/SQLiteOpenHelper), [Android database testing guidance](https://developer.android.com/training/data-storage/room/testing-db), and [Android backup rules](https://developer.android.com/identity/data/autobackup).

Owner selection is deliberately **OPEN**. This spike does not approve either candidate for production and does not treat “supports encryption” as a complete key-management/export decision.

## Implemented synthetic boundary

- `SyntheticLedgerOpenHelper` creates only `fake_catalog`, `fake_orders`, `fake_order_items`, and `fake_order_upload_journal`.
- One transaction inserts the immutable fake order, every item, and exactly one upload intent.
- Database constraints enforce one journal per order and unique order-command, idempotency and client-attempt lineages. Separate two-connection races hit each journal key with different local order IDs, prove the losing order/items roll back, and re-read the winning persisted payload hash. Item foreign keys, rollback, and cascade deletion are exercised.
- `SCHEMA_V1 -> SCHEMA_V2` adds a catalog revision using `SQLiteOpenHelper`'s transactional migration.
- Foreign keys and WAL are enabled and exercised. An attempted custom `busy_timeout=5000` assertion exposed that the API 36 framework reported `2500` after open, so the unproven override was removed; lock-wait policy remains an explicit owner decision rather than a false guarantee.
- The repository allowlists its count targets and exposes no generic raw-SQL method. Nothing registers it as a Capacitor plugin or calls it from the WebView.
- Existing manifest policy remains `allowBackup=false`; executable instrumentation parses exact `path="."` exclusions in the legacy root and independently in the Android 12+ `cloud-backup` and `device-transfer` sections.

## Executable evidence

Linux build host:

- Java and AndroidTest compilation: pass (`54` Gradle tasks; `3` executed);
- debug app + AndroidTest assembly: pass (`143` Gradle tasks);
- `git diff --check`: pass.

Cold API 36 emulator on Alienware:

- AVD started with `-wipe-data`, no snapshot, hardware acceleration and fresh APK installs;
- full Stage 1/Stage 2/B2 instrumentation: `OK (9 tests)`, `INSTRUMENTATION_CODE: -1`;
- app APK SHA-256: `ca68fe81caf31a2a05145ef2a1fcf267af04630c15966533217c3dbfdfa79f49`;
- AndroidTest APK SHA-256: `6924e03d6a5a368c0a0b8e2f3ae0d6fade301398e3bbbff03df5d9db28b89d69`;
- emulator and persistent ADB server stopped after the run.

The seven database tests prove:

1. order + items + upload intent commit atomically and survive close/reopen;
2. an injected failure before journal insert rolls the whole order transaction back;
3. three separate two-helper races cover `order_command_id`, `idempotency_key`, and `client_attempt_id`, leaving one winning hash and no orphan loser rows;
4. missing-catalog foreign keys roll back the command and deleting an order cascades to its items/journal;
5. V1 data survives the V2 migration with the expected default;
6. a deliberately broken V2 migration rolls back, leaving the V1 database readable and later recoverable by the valid migration;
7. compiled manifest/backup resources exclude every durable domain at `path="."` in the legacy, cloud, and device-transfer sections.

## Remaining acceptance gaps

This is not a complete B2 acceptance packet yet:

- no physical process kill at each transaction boundary, device reboot or OS-update matrix;
- no real low-storage/`SQLITE_FULL` test or WAL checkpoint under storage pressure;
- no deliberate file corruption test proving preservation/quarantine and encrypted diagnostic export;
- no uninstall/reinstall experiment proving the expected local-data loss workflow;
- cloud restore and device-to-device transfer are blocked statically but have not been exercised with Android backup/restore infrastructure;
- no SQLCipher build, encryption key generation/rotation, export classification review or recovery-key decision;
- no physical target tablet evidence and no long-running concurrency/load test.

Until those gaps and the owner gate close, the fake schema must not be renamed/reused as the real POS schema. Android auth, catalog backend reads, carts, orders, shifts, events, payments, printing and fiscal work remain disabled. Chesaigon, production backend, real POS databases, machine identity, credentials and printer/fiscal configuration were not accessed.

Lifecycle: planned and implemented on an isolated feature branch; compiled and emulator-tested; not landed on canonical; not production-built; not deployed; not verified live.
