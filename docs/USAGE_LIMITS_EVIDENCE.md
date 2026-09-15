# Provider Limits verification

The feature adds Usage → Limits and a composer shortcut for native account quota,
optional CLIProxyAPI hubs, verified account deduplication, comparable-window
averages, and deliberate Codex reset redemption. [User behavior and capability
limits](USAGE_LIMITS.md) describe the supported routes.

## Feature verification

All commands used Node.js 22.23.2 on macOS ARM64.

- `npm run check:quality`: passed migration lineage, architecture, theme generation,
  both lint layers, and all Node, renderer, private-connect and test type checks.
- Focused Vitest run with one worker: **10 files / 80 tests passed**. It includes
  projection, native and hub protocol fixtures, installation ownership, reset
  retry persistence and route compatibility, actual credential vault persistence,
  renderer state/focus/expiry, command boundary, and database migration coverage.
- `npm run test:portable`: **84 files / 1,310 passed / 9 skipped**, one worker.
- `npx electron-vite build` and the real `npm run check:renderer-bundle`: passed.
- `npx playwright test tests/e2e/usage-limits.spec.ts --project=display-sensitive --workers=1`:
  **1 passed in 9.1 seconds**. The native fixture exercises cold and warm composer
  dialog focus, Escape/return focus, hub setup through the actual vault, deduplication,
  explicit reset confirmation, restart persistence, hub removal, themes and narrow
  layout without viewport overflow. It reports no renderer errors.
- The native launcher (58155), private profile/workspace (`ie-ibCevA`) and its
  temporary directory were confirmed removed after the fixture closed.

The provider executables, hub, accounts and reset credits in the feature tests
are synthetic. No real reset credit was redeemed. Local screenshots do not
certify native Windows/Linux behavior or upstream live-provider availability.

The release coordinator owns the exact-source full `npm run check` and hosted
CI for the consolidated v0.0.55 candidate. An intermediate full run during
teardown dependency integration also encountered contended Git timeouts; it is
**not** final-source validation and is not counted as a passed gate here.

## Linux ARM64 fixture correction (2026-09-13)

The [consolidated candidate's Linux ARM job](https://github.com/eduardtomas1/inertia/actions/runs/34720475590/job/103625398279)
failed at the first hub-row assertion. Its error context says the management key
could not be saved in secure storage, before the runtime hub-save command.
The headless job had no Secret Service setup. In addition, Playwright 1.63.0's
Electron loader explicitly appends `--password-store=basic`, even when ordinary
launch arguments select another backend. Inertia correctly refuses that backend;
[Electron documents its lack of OS protection](https://www.electronjs.org/docs/latest/api/safe-storage).

The correction is confined to test infrastructure:

- The Limits fixture starts its own foreground D-Bus and GNOME keyring daemons,
  with private HOME/XDG directories and a random nonempty password sent only on
  stdin. It waits for the private default login collection and keeps it alive
  across the app restart.
- A temporary Electron entrypoint selects `gnome-libsecret` after Playwright's
  loader, preserves the normal application path, and imports the unchanged built
  app. The scenario asserts the real backend and asynchronous encryption
  availability before saving the hub credential.
- Linux interaction, full-platform CI and release jobs install `dbus-daemon`,
  `dbus-bin` and `gnome-keyring`. A workflow contract checks all three paths.
- Teardown stops only the two owned foreground children, with bounded TERM/KILL
  handling, then removes their temporary store. Setup failure also cleans up.
  Production vault behavior, encryption, `basic_text` refusal, preload and
  packaged application code are unchanged.

Local proof used Ubuntu 24.04.4 ARM64, Node 22.23.2 and the locked dependency graph
in container `inertia-limits-linux-proof` (`380c63205fdc`), from image
`inertia-local-arm64-buildbase:31301b7` (`sha256:9a1eda1250c8d2ee48425d7013644cddbd3cf17433ba045dc7a19187dd7d2887`).
The application was built with `npm run build:packaged` from
`817fbeacc1fcc7f944b3f69d771c050495cf6f71`; both runs used that same bundle.
Only the corrected test files changed between runs.

- **Before:** the unchanged Limits scenario failed at line 77 with the same
  missing hub row and secure-storage error as hosted CI.
- **After:** `xvfb-run --auto-servernum npm exec -- playwright test
  tests/e2e/usage-limits.spec.ts --project=display-sensitive --workers=1` passed
  **1 test in 8.8 seconds** on final fixture source. The storage evidence records
  `{"backend":"gnome_libsecret","available":true}`. Hub setup, verified account
  pooling, restart persistence, removal, keyboard interaction and layouts passed.
- Linux focused vault/workflow validation passed **2 files / 32 tests**, including
  insecure-backend refusal. `npm run check:quality` passed on macOS ARM64.
- A Linux setup-failure probe removed `gnome-keyring-daemon` from the helper's
  private executable search path. Setup rejected and removed its private store
  and D-Bus child. After the final E2E, launcher PID 2345, `/tmp/ie-Lu5jJA`, private
  keyring directories and credential daemons were confirmed absent.
- The proof container was removed. The unrelated `inertia-issue220-linux`
  container remained running and was not modified.

Local logs are `/tmp/inertia-limits-linux-{before,final,build,unit,cleanup,quality}.log`.
Screenshots, storage evidence and fixture ownership remain under
`/Users/eduardtomasvelez/.codex/tmp/inertia-limits-linux-proof/test-results/limits-linux-final/`.
This proves the targeted Linux fixture against the feature source, not the final
combined release. The release coordinator owns the consolidated full
`npm run check` and hosted platform matrix. No Windows or macOS desktop rerun was
performed for this Linux-only correction. The earlier verification manifest and
screenshots above remain the original feature snapshot.

## Native restart readiness correction (2026-09-13)

The [consolidated candidate's macOS x64 job](https://github.com/eduardtomas1/inertia/actions/runs/34720475590/job/103625398264)
reported `Codex3 accounts` after restart where the fixture requires two verified
accounts. The shell can become ready before provider detection completes. Limits
previously treated the initial `canRun: false` / `checking` snapshot as a settled
unavailable account, cached its null identity for 60 seconds, and displayed it
separately from the two verified hub accounts. The open panel's normal periodic
refresh did not repair this within the assertion window.

`NativeUsageReader` now performs the existing bounded provider detection when an
explicit Limits read reaches Codex or Claude while readiness is still checking.
It then applies the existing availability and account-verification rules. This
can add one normal detection during startup; it uses the existing privileged
process ownership, deadline and cancellation handling. Settled signed-out
providers remain unavailable without another probe. File-store verification,
provider-owned IDs, reset checks and deduplication are unchanged. No renderer
code, cache interval, command schema or bundle ceiling changed.

Verification used macOS ARM64 and Node 22.23.2, based on `31586db7` with the
correction applied:

- A unit regression with delayed detection failed before the fix with three
  pooled identities, including the extra null native identity. After the fix it
  retains exactly the two provider-owned IDs, even when both accounts have the
  same email. Additional cases cover a pending check finding a signed-out
  provider and an already settled signed-out provider.
- The existing native E2E now gives the fixture's login-status response a bounded
  2.5-second delay on restart. Against the previous application bundle, the same
  exact account-count assertion failed with `Codex3 accounts`. After rebuilding,
  the unchanged scenario passed **1 test in 13.0 seconds**, including the exact
  two-account count, persisted hub removal and final one-account count.
- Focused native reader, service, projection and installation-ownership tests
  passed **4 files / 35 tests**. `npm run check:quality` and `npm run build:bundle`
  passed. Renderer source and bundle budgets are untouched.
- Native launcher PID 89528 and its private `ie-IMna0z` workspace were confirmed
  removed after the passing run. The shared GUI lane was released.

Before/after logs are `/tmp/inertia-limits-readiness-before.log`,
`/tmp/inertia-limits-readiness-after.log`, and
`/tmp/inertia-limits-readiness-e2e-{before,after}.log`; native artifacts are in
`test-results/limits-readiness-{before,after}`. The unit regression is included in
the portable suite. The coordinator owns the final consolidated full check,
portable gate and hosted platform matrix; native x64, Windows and Linux were not
rerun locally for this correction.

## Screenshots

All four native screenshots were visually reviewed. The wide captures are
2560×1640 pixels; the narrow capture is 1520×1736 pixels on the Retina display.

- [Light account pools](screenshots/provider-limits-light.png)
- [Dark account pools](screenshots/provider-limits-dark.png)
- [Private account details and reset action](screenshots/provider-limits-account-details.png)
- [Narrow layout](screenshots/provider-limits-narrow.png)

## Bundle measurements

Baseline is `65bfbb18`. The following are measurements, not replacements for the
fail-closed build gate. Gzip values sum independently compressed chunks in each
closure. The final real gate passed unchanged first-load and existing optional
feature ceilings. The approved core allowance covers the added boundary
validators/context; the new Limits closure has its own 15.5 KiB ceiling.

| JavaScript scope | Baseline bytes | Feature bytes | Baseline gzip | Feature gzip |
| --- | ---: | ---: | ---: | ---: |
| Entry | 192736 | 192736 | 60851 | 60850 |
| Initial workbench closure | 760965 | 762222 | 229410 | 229809 |
| Detached chat closure | 581921 | 582376 | 176740 | 176916 |
| Core excluding separately capped optional features | 2048753 | 2051351 | 618451 | 619206 |
| New complete deferred Limits closure | 0 | 15853 | 0 | 5938 |

`connectionMessages.ts` loads `server-event-schema` on the first runtime message.
Its usage result validators validate the bounded Limits snapshots, confirmations
and outcomes. App imports a small context/opener and types; it does not import
privileged command validation. The Limits panel, source form and projection load
on demand. Adding a hub creates no agent route and no startup/background worker.

## Dependency and boundary notes

The feature includes append-only migration 74; migration records 1–73 remain
unchanged and the exact 73→74 upgrade is tested. Hub keys use the existing
`backendSecretReferenceForProfile` derivation and encrypted vault. No credential
or provider process API was added to preload.

Native Claude verification includes the separately reviewed #354 teardown fixes:
normal EOF, partial metadata completion, cancellation during close, exact one-close
behavior and confirmed process-tree ownership. The usage adapter releases ordinary
operation failures and quarantines only unconfirmed ownership or failed exact release.

## Compact Limits rows and composer quota (2026-09-15)

Limits now shows one row per provider. Each reported window has a meter, the
remaining percentage and a countdown; equivalent accounts use the existing
`usagePools` average. A dot, the meter and the number carry the health tone.
Accounts open under a disclosure in the same columns and stay inert while
collapsed. The averages explanation sits behind an info control, and a skeleton
replaces the loading sentence during the first read. Entry, fill and disclosure
motion runs only under `prefers-reduced-motion: no-preference`. Account details,
hub setup and the reset confirmation flow are unchanged.

The composer usage popover shows context as a larger ring and quota with the
Limits health tones; the trigger itself still shows only the context ring. A
line names another ready, fully reported account of the same provider with more
room than the selected route's tightest window, with the reading's age after five
minutes. The Environment panel's Usage section opens by default and remembers a
collapse or reopen in the renderer's optional layout storage. It reads `usage.limits.get` with `refresh: false`, which returns the
runtime's in-memory snapshot; it never refreshes providers. It loads with the
deferred Limits module.

The History/Limits switch and the popover's **All provider limits** button were
styled only by the lazily loaded Limits stylesheet. On a first visit, History
showed unstyled adjacent buttons until Limits loaded. Their rules now live in
`UsageView.css` and `styles.css`; a stylesheet test and the Usage E2E (computed
`display: flex` before Limits is opened) cover it.

Verification used macOS ARM64 and Node 22.23.2 on `70db1278`, main with #390 merged in:

- `npm run check`: passed. **849 files / 9,039 tests passed**, 16 files / 140
  tests skipped, and the real renderer bundle gate passed.
- `npx playwright test tests/e2e/usage-limits.spec.ts tests/e2e/usage.spec.ts
  tests/e2e/usage-popover-placement.spec.ts --project=display-sensitive --workers=1`:
  **3 passed in 21.8 seconds**, with no renderer errors. `npx playwright test
  tests/e2e/layout.spec.ts --workers=1`: **6 passed**, including the default-open
  Usage section and its keyboard order.
- Providers, hub, accounts and reset credits are the existing synthetic fixtures.
  No real provider CLI ran and no reset credit was redeemed. Native Windows and
  Linux rendering was not exercised locally.

| JavaScript and CSS scope | Baseline bytes | Feature bytes | Change | New ceiling |
| --- | ---: | ---: | ---: | ---: |
| Deferred Limits closure | 17591 | 19942 | +2351 | 19.7 KiB |
| Main workbench first load | 811095 | 811819 | +724 | 793 KiB |
| Detached chat first load | 620226 | 620921 | +695 | 606.6 KiB |
| Core | 2115046 | 2115861 | +815 | 2,066.4 KiB |
| Entry CSS | 348591 | 350894 | +2303 | unchanged 346 KiB |

The first-load growth is the quota tone, the lazy hint boundary and the
remembered Usage section; the hint's logic stays in the deferred Limits closure. Measurements are
in [the renderer evidence](pr-evidence/limits-strip-composer-quota-renderer-bundle.json).
The earlier manifest and screenshots remain the original feature snapshot.

- [Light rows with Codex accounts open](screenshots/limits-strip-light.png)
- [Dark rows](screenshots/limits-strip-dark.png)
- [Account details and reset action](screenshots/limits-strip-account-details.png)
- [Narrow layout](screenshots/limits-strip-narrow.png)
- [Composer popover with a low weekly window and a roomier account](screenshots/composer-usage-quota.png)

Comparison captures from the same fixtures, with `3baeaef3` as the before state:

- [Composer popover and Environment Usage before](screenshots/composer-usage-before.png)
  and [after](screenshots/composer-usage-after.png), taken when the popover first opens.
- [Usage switch before](screenshots/usage-switch-before.png), cropped to the header
  on a first visit with Limits never opened, and [after](screenshots/usage-switch-after.png).
