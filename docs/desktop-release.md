# Desktop release, update and recovery (H7)

Status as of 2026-10-04. What is **implemented and verified**, and what is
**required before** shipping signed builds or automatic updates.

## Release artifacts
`npm run desktop:dist` → `dist-desktop/Aharos-Setup-<version>.exe` (NSIS, per-user,
`%LOCALAPPDATA%\Programs\Aharos`) and `Aharos-Portable-<version>.exe`.
`npm run desktop:pack` → `dist-desktop/win-unpacked/` (same app, no installer).

**macOS (configured, NOT yet verified on a Mac — see below).**
`npm run desktop:dist:mac` (on a Mac) → `dist-desktop/RESTORA-<version>-mac-<arch>.dmg`;
`npm run desktop:pack` on a Mac → `dist-desktop/mac-arm64/RESTORA.app` (Apple
Silicon) or `dist-desktop/mac/RESTORA.app` (Intel). Data lives in
`~/Library/Application Support/Aharos`. The DMG is built for the arch of the Mac
that builds it, because the server payload's native modules (Prisma query engine,
sharp) are the build machine's; `desktop/scripts/after-pack.cjs` refuses a package
whose native modules do not match its target (so a Mac package cannot be produced
from Windows, and an Intel DMG cannot be produced on Apple Silicon). CI builds both:
`.github/workflows/ci.yml` job `desktop-macos` (arm64 + x64 runners) runs the
desktop E2E, `desktop:verify` and the DMG build and uploads each DMG.

Not yet done for macOS: **(1)** no macOS package has been produced yet. Every
`desktop-macos` run up to 6bca43c built the payload and passed the desktop E2E on
both arches, then failed at "Package: RESTORA.app" with `<repo> not a file`: the
workflow exported `CSC_LINK=""` (secret not configured) and electron-builder treats
an empty `CSC_LINK` as a certificate path. Fixed 2026-10-06 (CSC_* are exported only
when the secret is non-empty); the next push must show the job green and attach
`restora-mac-arm64` / `restora-mac-x64` DMGs before macOS counts as built. Then copy
both DMGs into `dist-desktop/`, run `node scripts/site/release-manifest.mjs`, upload
them to the release host, and the download page lists them. Until then the site
correctly says "Not released yet"; **(2)** no Developer ID signing or
notarization: the app is ad-hoc signed and Gatekeeper requires right-click → Open
on first launch. To sign and notarize: GitHub secrets `MAC_CSC_LINK` /
`MAC_CSC_KEY_PASSWORD` (Developer ID Application certificate, .p12) and
`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` passed to the
`desktop-macos` job; verify with `codesign --verify --deep --strict` and
`spctl -a -vv dist-desktop/mac-arm64/RESTORA.app`.

**Unsigned (local / ad-hoc) builds and the fuses.** Electron's macOS binaries
ship linker-signed ad-hoc (no team ID, no hardened runtime). Flipping the Electron
fuses rewrites bytes in `Electron Framework`, so without a re-seal the first fuse
read is killed by the kernel on Apple Silicon (`EXC_BAD_ACCESS (SIGKILL (Code
Signature Invalid))` in `electron::fuses::IsRunAsNodeEnabled`).
`electronFuses.resetAdHocDarwinSignature: true` re-applies an ad-hoc signature
to the whole bundle right after the fuses are flipped; with a Developer ID
electron-builder then signs over it (hardened runtime + `desktop/mac/entitlements.mac.plist`).
`npm run desktop:verify` on a Mac checks `codesign --verify --deep --strict`.
A locally built app carries no quarantine flag and opens normally; a copy
downloaded from the internet is quarantined, and since macOS 15 an unsigned app
must be allowed once in System Settings → Privacy & Security → "Open Anyway"
(right-click → Open no longer bypasses Gatekeeper). Never disable Gatekeeper or SIP.

Manual macOS check (on a Mac): `npm ci && npm run desktop:build && npm run desktop:e2e
&& npx electron-builder --mac --dir --publish never && npm run desktop:verify &&
npx electron-builder --mac --publish never`, then open the DMG, drag RESTORA to
Applications, launch it, complete setup, sign in, take an order through POS → KOT
→ KDS → payment, print a test page from Settings → Printers, back up, quit (⌘Q),
relaunch and confirm the data persisted.

- **Version** = `package.json` `version` (app, installer file name, backup manifests).
  Bump it for every release; the installer upgrades in place (same `appId`
  `com.aharos.desktop`).
- **Data** lives in `%APPDATA%\Aharos` (`data\aharos.db`, `backups\`, `logs\`,
  `config.json`) — never inside the install directory. Uninstall and upgrade keep it
  (`deleteAppDataOnUninstall: false`).
- **Never published by a build.** `publish: null` in `electron-builder.yml` and
  `--publish never` in the scripts: a CI run with a GitHub token cannot create a
  release by accident.

## Security of the packaged app (verified by `npm run desktop:verify`)
| Control | Where |
|---------|-------|
| Renderer: `sandbox`, `contextIsolation`, no `nodeIntegration`, `webSecurity`, DevTools off when packaged; `app.enableSandbox()` for every renderer | `desktop/main/main.ts` |
| Renderer may only load/request the local server origin (plus data:/blob:); navigation, redirects, popups and `<webview>` blocked; all permissions denied | `main.ts` `installSecurity`, `policy.ts` |
| App preload exposes 4 functions, setup preload 3; every IPC handler checks sender frame + origin and validates arguments | `desktop/preload/*`, `main.ts`, `policy.ts` |
| Child processes get an allow-listed environment (no developer `DATABASE_URL`, `NODE_OPTIONS`, provider secrets) | `policy.ts` `childEnv` |
| Per-install `AUTH_SECRET` encrypted with `safeStorage` (DPAPI on Windows, Keychain on macOS) | `desktop/main/config.ts` |
| macOS: hardened runtime with only the JIT + library-validation entitlements Electron and the native server modules need; no sandbox/network/device entitlements | `desktop/mac/entitlements.mac.plist` |
| **Electron fuses:** `RunAsNode`, `NODE_OPTIONS`, `--inspect` disabled; cookie encryption on; app loads only from `app.asar` with **embedded integrity validation**. `GrantFileProtocolExtraPrivileges` stays on: the splash / setup pages are `file://` pages in `app.asar` and fail to load without it (found by `desktop:verify`) | `electron-builder.yml` `electronFuses` |
| Packaged app exits if started with `--remote-debugging-port/-pipe/-address`, `--inspect*` or `--js-flags` | `main.ts` + `policy.ts` `hasDebugSwitch` |
| Build fails on `.env` / database files in the payload or any `.env` value found in it (secret scan) | `desktop/scripts/build.mjs` |

Playwright drives Electron through `--inspect`, which the fuses deliberately
block. The full desktop E2E (`npm run desktop:e2e`) therefore runs the same app
code on the unpacked build with the stock Electron binary; the **fused** binary is
checked by `npm run desktop:verify` (fuse wire, real start-up + upgrade + sign-in,
`ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `--inspect` / `--remote-debugging-port`
attacks, tampered `app.asar` refused).

## Upgrades and migrations (verified)
On every start the DB tool runs `desktop/runtime/upgrade.ts`:
1. **Refuse without touching anything** a database that has tables but no history,
   contains a migration this version does not know (written by a newer version —
   downgrade protection), has an edited applied migration (checksum), or an
   unfinished migration.
2. **Verified pre-migration backup** (`backups\aharos-<stamp>-pre-migration.db` +
   manifest with SHA-256) before anything is applied to existing data.
3. Forward migrations, **one transaction each**, `foreign_key_check` before commit.

Tests: `tests/desktop/upgrade-restore.test.ts` (a database from the previous release,
ad547ae, with real rows → upgrade → rows intact, history accepted by `prisma migrate
status`; failing migration → rolled back, data intact; newer database refused) and
`tests/desktop/migrator.test.ts`.

### If an upgrade fails
The app shows "Aharos could not start … No data was deleted" and does not start.
The database is at a migration boundary (the failed migration rolled back).
- Install the fixed version → it continues from that boundary; or
- go back to the previous version: replace `%APPDATA%\Aharos\data\aharos.db` with
  the newest `backups\*-pre-migration.db` (delete `aharos.db-wal` / `-shm` first)
  and reinstall the previous installer. The previous version refuses the
  partially-upgraded file (unknown migrations), never damages it.

## Backup and restore (verified)
- Backups are `VACUUM INTO` snapshots, verified (`integrity_check`, history, SHA-256
  manifest) **before** they are kept; automatic every 12 h (14 kept), manual,
  pre-migration and pre-restore backups are never rotated.
- They are in the user's own profile (`%APPDATA%\Aharos\backups`, user-only ACL by
  default). They contain the whole database (incl. password hashes): treat copies
  as confidential. Backup **encryption is not implemented**.
- **Restore** (menu, Owner + fresh password re-confirmation): verifies the chosen
  file, refuses backups from a newer version, stops the server, takes a verified
  pre-restore backup, verifies the exact copy swapped in, migrates it. **If the
  restored file cannot be migrated, the pre-restore data is put back
  automatically** (`desktop/runtime/restore.ts`, `RestoreRolledBackError`).
- Logs never contain passwords or the install secret; they contain e-mail
  addresses of setup/restore actors and blocked URLs (first 200 characters).

## One version, one binary (finding 2026-10-19)
`src/site/release-manifest.json` publishes `1.0.0-rc.1` as the 2026-10-06 build
(Setup 136,792,602 bytes, sha256 `67ec34c5…`). The local `dist-desktop/` holds a
2026-10-15 rebuild (Cloud Sync) under the **same** version (Setup 137,822,088
bytes), so `tests/site/website.test.ts` fails locally (CI has no `dist-desktop`,
so CI is green). Two different binaries must never share a version: an upgrade
check, a support report or a future updater cannot tell them apart. Before the
next distributed build, bump `package.json` `version` (e.g. `1.0.0-rc.2`),
rebuild, and regenerate the manifest (size + sha256) from that exact file; the
test then passes against it. The test and the existing installers were left
unchanged.

**Resolved locally 2026-10-20.** The manifest is the correct record: the draft
GitHub release `v1.0.0-rc.1` (created 2026-10-10, not published) holds exactly
those two files, and GitHub's asset digests equal the manifest's sha256 values
(Setup `67ec34c5…`, Portable `3a1415ad…`). The manifest was therefore kept. The
mislabelled 2026-10-15 rebuild was moved, not deleted, to
`dist-desktop/unreleased-2026-10-15-build-labelled-rc.1/` (with a README holding
both sets of sizes/hashes), so `dist-desktop/` no longer offers a file under the
rc.1 name that is not rc.1. No rc.2 was built: the next release's contents are
the uncommitted review work, which is not yet approved. When it is:

1. Bump `package.json` `version` to `1.0.0-rc.2` (and the rc.1 literals in
   `tests/site/website.test.ts` together with the manifest).
2. `npm run desktop:dist` on a clean checkout of the approved commit (no dev server
   running; see the desktop build hazards in this file).
3. `npm run desktop:verify`, then `node scripts/site/release-manifest.mjs`.
4. Independently check `certutil -hashfile dist-desktop\RESTORA-Setup-1.0.0-rc.2.exe SHA256`
   (and Portable) against the manifest, upload both to a new draft release, and
   compare GitHub's asset digests before publishing.
5. The installed copy on this PC reports 1.0.0-rc.1 but is the 2026-10-15 build:
   install rc.2 over it once released.

## Start-up time (measured 2026-10-19, installed 1.0.0-rc.1 build of 2026-10-15)
Measured from the app's own `Startup timings` log line on this machine (8 GB RAM,
under 1 GB free during the runs), with isolated data folders (`AHAROS_DATA_DIR`):

| Launch | Database + all 28 migrations | Local server ready | Window / first page |
|---|---|---|---|
| Clean first launch (empty folder) | 1.2 s (then the first-run setup window; the server starts after setup) | — | — |
| Set-up install, 12:03 | 2.2 s | 32.4 s | 33.5 s |
| Same install restarted, 12:14 | 2.0 s | 19.3 s | 41.7 s |

One-time database initialization is not the cost: the packaged Next.js server
boot (17–30 s here) is, plus a window / first-page gap that varied from 1 s to
22 s. The earlier "~72 s first launch" figure therefore mostly measures the
server boot and the setup flow. Next step before optimizing: profile the
standalone server start (module loading from `resources/server`, antivirus
scanning of the unpacked files, cold disk cache) on a machine with free memory.

### 2026-10-20 packaging check (unpacked build only, nothing published)
- `npm run desktop:pack` failed with "No standalone build found": a stray
  `package.json` / `package-lock.json` in the user's home folder made Next.js
  infer that folder as the workspace root, so the standalone server was written to
  `.next-desktop/standalone/Downloads/food/`. `next.config.mjs` now pins
  `outputFileTracingRoot` to the checkout (test
  `tests/config/next-tracing-root.test.ts`); packaging then succeeded.
- `npm run desktop:verify` on that package: **23/23 checks passed** (fuses, DPAPI
  secret, upgrade from the previous release with a verified pre-migration backup,
  sign-in and data intact, first run, debugger / `RUN_AS_NODE` / tampered-asar
  refusals). The packaged server was ready **2.9 s** after the database step.
- The run immediately before it, the first launch of the freshly unpacked files,
  timed out after 120 s waiting for the server's health check; that run's log was
  deleted by `desktop:verify`'s cleanup (it now keeps the folder when a check
  fails). Investigation on 2026-10-21 (below). No installer (`desktop:dist`) was
  built: the version is still `1.0.0-rc.1` and an rc.2 needs the release decision
  described above.

### 2026-10-21 first-launch timeout investigation
Measured with the packaged server (`resources/server`) started with the app's
environment, event-loop gap monitoring and CPU profiles, plus seven full
`desktop:verify` runs. The original >120 s failure was **not reproduced** (three
attempts right after `desktop:pack`); two causes of slow starts were proven:

1. **Next.js preloaded every route at start-up (fixed).** Next 15's default
   `experimental.preloadEntriesOnStart` loads all 164 routes and evaluates every
   module when the server starts. That blocked the server's event loop for
   2.6–4.3 s in one stretch, so the launcher's first health check failed on
   **every** start with "database ping timed out" (the database answers in
   ~50 ms; the timer and the answer were both stuck behind the blocked loop), and
   a critical "database unavailable" alert was logged. In one stalled warm start
   the health check answered only after 48.8 s (the launcher gives up at 60 s).
   With it off (desktop build only; `next.config.mjs`, enforced by
   `desktop/scripts/build.mjs`, test `tests/config/next-desktop-preload.test.ts`):
   first health check succeeds every time, health at 1.6–2.1 s instead of
   4.0–7.6 s (once 5.3 s, when the process itself was slow to launch), total start-up blocking ~2.0 s instead of ≥ 4.1–6.6 s.
2. **Reading freshly written files is very slow the first time (outside the
   app).** Right after `desktop:pack`, reading every file of the package once took
   **108 s** (2,972 files, 457 MB, ≈ 4 MB/s; `.js` files slowest); a second read
   took 2.5 s. Launching straight after packaging took 28.8 s (before the fix) and
   31.2 s (after) to serve; after that one pre-read, the same launch served in
   **1.7 s**. A control test with identical bytes saved as `.js` and `.dat`
   showed intermittent first-read penalties for `.js` only, and electron-builder
   itself once failed with `EPERM` renaming its just-extracted folder. This is
   consistent with on-access antivirus scanning (Defender real-time protection is
   on), but it is **not proven**: Defender's own counters are not readable here
   without administrator rights (`New-MpPerformanceRecording` would show it).
   An installer writes the same fresh files, so a real first launch after
   installation can pay this cost too; it is within the 60 s limit in every run
   measured after the fix, but on slower PCs it is untested.

Launch times after the fix (`Aharos server ready on loopback`): warm 2.1 s,
fresh copy 2.7 s, straight after packaging 31.2 s, after packaging + pre-read
1.7 s; upgrade from the previous release with data preserved passed in every run.

## Code signing — NOT configured (installers are unsigned)
No certificate exists in this repository or CI. Unsigned installers trigger
SmartScreen warnings and cannot be verified by an updater. Required:
1. An **OV or EV code-signing certificate** issued to the publisher (EV, or OV with
   reputation, avoids SmartScreen warnings). Since 2023 these are issued on a
   hardware token / cloud HSM: plan for **Azure Trusted Signing** or an HSM-backed
   signing service rather than a `.pfx` file.
2. For a `.pfx`: GitHub secrets `WIN_CSC_LINK` (base64 or https URL of the .pfx)
   and `WIN_CSC_KEY_PASSWORD`; `.github/workflows/ci.yml` already passes them to
   electron-builder as `CSC_LINK` / `CSC_KEY_PASSWORD`. For Azure Trusted Signing,
   add `win.azureSignOptions` in `electron-builder.yml` and the Azure credentials
   as secrets.
3. Verify: `Get-AuthenticodeSignature dist-desktop\Aharos-Setup-<v>.exe` →
   `Valid`, and the same for `win-unpacked\Aharos.exe` and the bundled `.node` files.
Never commit certificates, keys or passwords.

## Automatic updates — NOT implemented (by decision)
There is no updater in the app. Updates are manual: run the new installer (data
and backups are kept; the next start migrates with a verified backup). An updater
must not be enabled until **all** of these exist:
1. Signed installers (above); `electron-updater` verifies the publisher of the
   downloaded installer against the running app (`win.publisherName`).
2. A trusted update channel over HTTPS controlled by Aharos (GitHub Releases or a
   static host), publishing `latest.yml` with SHA-512 of each installer; publishing
   only from a protected release workflow, never from ordinary CI.
3. Update flow: download → verify signature + hash → **verified backup** → install
   → start-up migration (already safe, above). Never auto-install during service
   hours; let the Owner choose the time.
4. Rollback = reinstall the previous signed installer + restore the pre-migration
   backup (above). Staged rollout per outlet before all tills.
