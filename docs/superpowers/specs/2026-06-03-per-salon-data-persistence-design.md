# Per-salon local data persistence (no destructive wipe)

**Date:** 2026-06-03
**Status:** Approved, implementing

## Problem

On the same device, logging into a DIFFERENT salon than the current one calls
`clearSalonDataWithBackup` → wipes salon-specific tables (orders, fiscal_attempts,
print_attempts, products, bookings…). The backup before the wipe is **best-effort**:
if the backup service isn't ready or the copy fails, `createRestorePoint` swallows
the error and `clearSalonData()` runs anyway → the leaving salon's local data is
**lost, unrecoverably**. An accidental cross-salon login on a live POS can destroy
the day's data.

## Goal

Never destroy a salon's local data on salon switch. Persist each salon's data
on disk; on returning to a salon, restore it and sync deltas. If the current
salon cannot be safely saved, **abort the switch** (keep current salon + session).

## Decisions (from brainstorming)

1. **Abort on save failure** — if archiving the current salon fails, cancel the
   switch: don't store the new token, keep the current salon + session, surface
   an error. Absolute data preservation over convenience.
2. **Restart-based restore** — reuse the existing, tested backup→pending-restore→
   `applyPendingDatabaseRestore` (boot) path. Switching to a salon that has a
   stored archive stages it and relaunches the app (~10s). Salon switching is
   rare, so a restart is acceptable and far lower-risk than a live hot-swap.

## Architecture (reuses existing machinery)

- **Storage:** one full SQLite snapshot per salon at `<userData>/salons/<salonId>.db`
  (overwritten with the latest on each switch-out). Live DB stays `pos.db`.
- **Restore reuse:** `applyPendingDatabaseRestore` already runs at boot
  (`orchestrator.ts:157`, before DB init), validates the staged `pending-restore.db`
  as a real SQLite file, makes a safety backup of the current `pos.db`, then
  replaces it. We stage a salon archive as `pending-restore.db` and relaunch.

## New code

**`LocalBackupService` (backup-service.ts)** — file ops, reuses its deps:
- `salonArchivePath(salonId)` → `join(userDataDir, 'salons', <sanitized>.db)`.
- `archiveSalon(salonId)` → `flushDatabase()` then atomic copy `pos.db` → archive
  (tmp+rename, mkdir). Returns `{success, path?, error?}`.
- `hasSalonArchive(salonId)` → `fs.existsSync`.
- `stageSalonRestore(salonId)` → validate archive exists, copy → `pending-restore.db`,
  set the same `backupPendingRestore*` config flags `prepareRestore` sets. (Boot's
  `applyPendingDatabaseRestore` validates the SQLite header, so a corrupt archive
  is rejected there and the app falls back to the safe path.)

**`auth.module.ts`** — replace the 4 `clearSalonDataWithBackup` call sites with one
orchestrator `switchSalonData(oldSalonId, newSalonId)`:
1. No `oldSalonId` (first login) → `clearSalonData()` (empty) + sync. `{ok, willRestart:false}`.
2. `archiveSalon(oldSalonId)`. Fails → `{ok:false, error}` → caller ABORTS (no token, no switch).
3. `hasSalonArchive(newSalonId)`:
   - yes → `stageSalonRestore(newSalonId)`; fails → `{ok:false}` (abort). ok →
     `{ok, willRestart:true}` → caller stores token + `config.salonId=new`, emits
     `salon:switching`, then `app.relaunch(); app.exit(0)` after a short delay.
   - no (first time for this salon) → `clearSalonData()` (empty) + `{ok, willRestart:false}`.

**Caller (login handlers) contract:**
- `{ok:false}` → return `{success:false, error}` to AuthScreen; keep current session.
- `{ok, willRestart:true}` → persist token + config FIRST (so they survive restart),
  then relaunch. On boot: pending restore loads the salon's data, stored token keeps
  the user logged in, post-login sync pulls deltas.
- `{ok, willRestart:false}` → persist token + config, continue normally.

## Scope of switch paths

- **email login + telegram login + explicit change-salon** → full archive + restore
  (+ relaunch when restoring an existing archive).
- **startup auth salon switch** (boot-time mismatch, rare/defensive) → archive current
  (enforced) + `clearSalonData` + fresh sync, **no relaunch** (avoids a boot→restore→
  boot loop). No data loss: the leaving salon is archived; the target's archive (if any)
  is restored on the next explicit login, not auto-restored at startup.

## Failure handling

- Archive fails → abort switch (decision 1).
- Stage fails → abort switch.
- Corrupt archive at boot → `applyPendingDatabaseRestore` validation rejects it →
  existing corrupt-DB quarantine + empty + full sync (degraded, safe).
- `app.relaunch` is added (standard Electron; not currently used).

## Out of scope (YAGNI)

- Auto-cleanup/retention of `salons/*.db` (few salons; revisit if disk pressure).
- Encrypting salon archives at rest (pos.db itself is unencrypted today — no regression).
- Live hot-swap without restart.
- Backend changes (none — fully local).

## Testing

- Unit (backup-service): `archiveSalon` creates the file via flush+atomic copy;
  `hasSalonArchive` true/false; `stageSalonRestore` sets pending-restore config;
  archive-failure path returns `{success:false}` without staging.
- Unit (auth switch orchestration): abort path returns `{ok:false}` and does NOT
  call clearSalonData; restore path returns `willRestart:true`; new-salon path clears.
- Scenario (documented manual / e2e): login A (orders) → switch B → switch back A →
  A's orders present (restored), B's data preserved in `salons/<B>.db`.

## Files

`src/main/database/backup-service.ts` (new methods), `src/main/modules/auth.module.ts`
(switch orchestration + relaunch), possibly `src/main/modules/backup.module.ts`
(expose new methods), `tests/*`. ~3-4 files, local-only, no backend, no DB schema change.
