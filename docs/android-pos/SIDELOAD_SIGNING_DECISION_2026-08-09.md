# Sideload signing key — owner decision, 2026-08-09

Approved by Paul on 2026-08-09, in the session that first built a release APK
carrying the remote-management plane.

## What was decided

A dedicated **sideload signing key** exists for `com.ziraai.posdiagnostics.dev`,
used only for APKs installed by hand (or by `AppUpdaterPlugin`) onto terminals
we own.

The alternative considered and rejected was signing with the Android debug key.
That key is public — anyone holding it could sign an APK that a terminal would
accept as a legitimate update, leaving the host allowlist as the only barrier.

## Why the signer matters more than usual here

`AppUpdaterPlugin.verifyArchiveIdentity` refuses any update whose signer digest
differs from the installed app's (`update-signer-mismatch`). The signing key is
therefore the trust anchor for every remote `APP_UPDATE` command, not merely a
packaging formality. `scripts/run-android-build.mjs` pins the fingerprint below
so a build signed by any other key fails the gate instead of producing an
artifact no terminal would accept.

## Key identity

| | |
|---|---|
| Alias | `zira-pos-sideload` |
| Algorithm | RSA 4096, SHA384withRSA |
| Subject | `CN=Zira POS Sideload, O=Zira AI, L=Warsaw, C=PL` |
| Validity | 10000 days from 2026-08-09 |
| SHA-256 | `15:22:D2:FA:E3:4E:11:CF:14:ED:26:C0:D6:86:65:D6:B9:F8:4A:55:C1:8D:BF:CC:71:10:F3:8A:77:96:33:06` |
| SHA-1 | `19:85:1F:BB:18:77:2A:16:06:18:EF:ED:50:BD:6F:EA:5C:61:43:EF` |

## Where the material lives

On the Netcup build box only, outside the repository:

```
/home/paul/.secrets/zira-pos-android/zira-pos-sideload.p12   (0600)
/home/paul/.secrets/zira-pos-android/signing.env             (0600)
```

Nothing signing-related is committed — `signing-material-hygiene` in the
production-readiness gate must keep passing.

To build a signed APK:

```bash
set -a && . /home/paul/.secrets/zira-pos-android/signing.env && set +a
ZIRA_ANDROID_BUILD_NUMBER=<monotonic> npm run android:build:verify
```

With those variables unset the release stays unsigned and the build-only lane
behaves exactly as before.

## ⚠️ Backup obligation — unmet

**This key is not backed up anywhere off the Netcup box.** Losing it means no
installed terminal can ever be updated again: a replacement key produces a
different signer digest, every update is refused, and each till has to be
uninstalled and reinstalled by hand at the venue. Copy both files to offline
storage.

## What this decision does NOT cover

- **Play distribution.** The Play upload key and the Play app-signing key are
  two further, separate identities. `owner-release-signing`,
  `owner-play-distribution` and `owner-application-id` in the
  production-readiness gate remain blocked and unaffected by this decision.
- **The application ID.** It is still the development identity
  `com.ziraai.posdiagnostics.dev`. Sideloading onto owned terminals does not
  make it permanent; shipping to Play would.
- **versionCode allocation.** Builds still take `ZIRA_ANDROID_BUILD_NUMBER`.
  For sideloading, any monotonically increasing integer is enough; the
  Play-safe allocator remains an open item.
