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
