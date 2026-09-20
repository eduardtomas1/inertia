# Source usage and confirmed cleanup

Audited checkout: `d56f972b32fadfa29169bb8390401f5ca49e419b` (fresh
`origin/main`, 20 September 2026, version 0.0.60). The historical
*Inertia Dead Code and Structure Audit* describes v0.0.57 at `5aaaaac8` and
explicitly claims no executed validation. Its recommendations are not deletion
authority for this checkout.

## Reproduce the two views

With Node 22 and the reviewed `npm ci` installation:

```sh
node scripts/source-usage.mjs
node scripts/source-usage.mjs --json > source-usage.json
```

The existing Babel architecture analyzer supplies module resolution, aliases,
type imports, re-exports and literal dynamic imports. This extension adds file
reachability, not a second unused-local checker or a new dependency. It does not
claim unused-export, unused-package, side-effect or runtime execution analysis.
Export removal still requires complete-checkout caller and compatibility review.

The inventory also follows inline TypeScript `import("...").Type` references
(30 production edges here). These are opt-in inventory edges; the architecture
checker's pre-existing cycle/layer policy is unchanged.

Production roots are derived without executing the three build configurations:
13 main/runtime/worker inputs, four window-specific preloads, two desktop HTML
scripts, and Private Connect's HTML script. The Vite `new Worker(new URL(...))`
diff parser is an explicit additional source entry. All 21 roots are named in
the JSON output. Unsupported build-input syntax fails instead of silently
omitting an entry. No `src` glob is an entry root. Type-only reachability is
reported separately; a type edge does not prove emitted runtime code.

The complete view adds every checked-in test, script, benchmark and root/build
configuration, including helpers, as **conservative tooling roots**. It answers
whether source has any test/tool consumer, not whether each script or helper is
itself invoked. Computed imports in tools and tests remain visible in
`analysisLimitations`; there are 44 at the implementation checkpoint. The source
graph has no unresolved imports or parse errors. Non-module assets are excluded
from source deletion candidates, not presumed unused.

`scripts/source-usage-resources.json` records non-import owners: utility workers,
preloads, the generated Private Connect service worker/public assets, native
guardians, Windows integrity metadata, the package-resolved PDF worker and
canvas, installer/release hooks, icons, generated themes and legal resources.
The JSON report also includes the current package file/resource/native-unpack
configuration and every migration source pin. Package scripts, release config,
wrappers and packaging helpers are tooling roots. These resource records require
review when loaders change; they do not replace package-smoke or native checks.

`tests/source-usage.test.ts` checks root discovery, disconnected cycles, source
analysis failures and the exact reviewed non-production file baseline. It is
part of the existing `npm run check` gate. Review new findings rather than
adding broad ignores. Existing architecture checks continue to reject source
imports of test fixtures; the old sunset-harness ban also prevents resurrection
at its former path.

## Measured inventory

| Measure | Before | After |
| --- | ---: | ---: |
| Production entry files | 21 | 21 |
| Production-reachable source files, including types | 1,122 | 1,122 |
| Of those, reachable only through type edges | 21 | 21 |
| Source files retained only by tests/tools | 4 | 3 |
| Unreferenced non-declaration source files | 1 | 1 |
| Literal production lazy-import edges | 81 | 81 |

The unchanged production file count is expected: `adapters.ts` and the AppImage
module still own live behavior. 942 lines of fixture implementation/imports left
`src`, and 121 lines of obsolete AppImage writer/API were removed. No download,
installed-size, startup-time or rendering improvement is claimed. Tree shaking
may already have removed these implementations from shipped bundles.

## Deletion and relocation decisions

| Change | Fresh evidence and replacement |
| --- | --- |
| Move `createLegacyCliAgentHarnessForTests` and its capability table to `tests/helpers/providers/legacy-cli-harness.ts` | No production, build or resource caller; existing architecture rule prohibits production registration. Consumers are agent-harness, providers, installation-lease and platform-benchmark tests. Preserve every lifecycle, output, cancellation and owned-process assertion. |
| Move `ProviderInvocation`, `ProviderParserState`, `normalizeProviderLine`, `buildProviderInvocation` and their private closure to `tests/helpers/providers/legacy-cli-adapters.ts` | All callers are the legacy fixture, provider-core tests and the Kimi legacy-invocation rejection assertion. No migration pin or persisted-data reader refers to these symbols. No unused production re-export is retained. |
| Retain live `adapters.ts` admission/failure helpers | `validateProviderRunInput` is called by ProviderManager, run coordinator and capability authority. Failure messages serve Codex/Claude native harnesses; safe backend labels serve both backend adapters. Their retained bodies are byte-for-byte unchanged. Keeping the existing module path avoids unrelated import churn. |
| Remove `installAppImageUpdate`, `InstallAppImageUpdateOptions`, `launchAppImage` | Only the old identity test file called them. Production updater uses `prepareAppImageUpdate`; bootstrap/startup use current validators/finalization/recovery. No named build entry, resource loader or migration pin refers to the deleted exports. The removed launcher always rejected bootstrap admission. Every retained byte of the module is unchanged. |

AppImage tests now exercise preparation, staged validation, commit, committed
validation and finalization for alias/space paths, repeated stable updates and
Canary identity. They retain hostile-symlink, rollback and foreign-backup
interruption evidence. Added current-path regression cases reject candidate
content/inode substitution and a stable path occupied after staging. Actual
bootstrap-ACK rejection and acknowledged transfer remain in
`electron-app-updater.test.ts`; the filesystem helper does not simulate a real
candidate ACK. Historical schema-1 crash/recovery fixtures were preserved.

## Reviewed findings retained in the baseline

| Finding | Owner, reason and review condition |
| --- | --- |
| `src/renderer/private-connect/vite.config.ts` (tool only) | Private Connect build. Correct build-time location; retain while the separate Vite build uses it. |
| `src/server/codex/app-server-notifications.ts` (tool only) | Provider conformance. The scheduled drift probe reads its disposition table by filename, and status tests import it. Review relocation with the drift owner; never delete because the runtime graph excludes it. |
| `src/server/runtime/backends/kimi-claude-preset.ts` (test only) | Backend integration. Only its focused runtime-preset tests import it at this head; production uses the general backend adapter. Defer a separate obsolete-preset/fixture decision until its integration contract is reviewed. |
| `src/renderer/src/utils/composerToolReadiness.ts` (unreferenced) | Composer owner. A removal candidate with no import/build/resource caller found, not bundled into this provider/updater cleanup. Recheck feature intent and current callers before a separate deletion. |
| `src/main/inline-image.d.ts` (ambient) | Main TypeScript compilation. Asset declarations are compiler inputs, not runtime module entry points. Retain while those declarations are required. |

## Compatibility obligations retained

| Format / owner | Evidence and retirement condition |
| --- | --- |
| Database migrations 1–77; persistence owner | `database-migration-lineage.json`, immutable path/symbol pins, `database-migration-lineage.test.ts`, `database-migrations.test.ts` and provider migration fixtures. Never rewrite released lineage; a supported old profile still needs its historical interpretation. |
| AppImage schema 1 `preparing`/`prepared`; updater owner | `appimage-update-journal.ts` and identity/journal tests cover historical journals, rollback and known-good retention. Removing the old writer does not retire readers; the current prepare path still writes schema-1 `preparing`. No retirement is authorized here. |
| AppImage schema 2 `staged`/`ownership-committed`; updater owner | Exact operation, artifact digest, executable identity, journal checksum, bootstrap/startup and interruption tests remain. Retire only with an explicit supported-upgrade/recovery policy and replacement fixtures. |
| Layout active-tool v1; workspace owner | `workspaceStartup.ts` imports `inertia:layout:active-tool:v1` into v2 once; workspace-startup unit/DOM fixtures cover it. Keep until an explicit old-profile support decision; fresh-profile non-use is irrelevant. |
| Provider wire fallbacks; provider owner | Existing Codex legacy-review handling and deterministic portable fixtures remain. Removing a test CLI format from production source does not authorize retiring native protocol fallbacks or changing credential/process authority. |

## Disposition of every report finding

| Finding | Decision |
| --- | --- |
| F01 usage analysis | Accepted with the existing analyzer; exact roots, two views, resource/compatibility review and reviewed baseline. Knip deferred: unused-export/package analysis would add a distinct scope and dependency, with no demonstrated need for this confirmed cleanup. |
| F02 fixture separation | Accepted; all fixture callers preserved, active validation/failure helpers retained. |
| F03 obsolete AppImage writer | Accepted; current-path tests translated first, historical readers and all active code retained. Native Linux packaged evidence is still required for platform certification. |
| F04 ACP framing | Source comparison confirms matching framing mechanics except error label and Cursor vendor callback. Defer a separate live-protocol refactor with a shared byte/UTF-8/CRLF/empty/trailing/budget/envelope conformance table and portable cleanup proof; do not combine it with dead-path retirement. |
| F05 frozen migrations | Existing lineage already protects released bytes/paths/symbols. Retain all pins. New-migration dependency prevention is additive follow-up work requiring a version-scoped policy; no broad prohibition or historical rewriting here. |
| F06 IPC constants | Duplication remains, but consolidation needs its own explicit per-window API and sender/payload parity evidence. Deferred; no generic invoke surface or authority change. |
| F07 streaming adapter | Store isolation already exists. The same-source/state selector fast path remains a contract hazard to reproduce, not a measured product failure. Routed to the whole-codebase audit; no subscription rewrite here. |
| F08 formatting/structure | Broad formatting, folder moves and arbitrary abstraction are rejected for this change. Existing layer/cycle/size gates remain. Owner-specific extraction/complexity prevention needs independent evidence and migration-pin care. |
| F09 packaging/dependencies | Deferred to the package-size sibling task, including externalization, renderer dependency placement, attribution/SBOM and pruning. No package/lockfile/build-policy change here. |

## Verification record

Initial focused baseline: 43 tests passed. First expanded direct-Vitest run:
172 passed and one Kimi cancellation timeout. That invocation omitted `pretest`;
the referenced generated guardian executable was absent. Running the affected
test through `npm test` built the required guardian and passed. This was a setup
failure, retained here rather than hidden by retries or deadline changes.

Current focused regressions: 82 passed across source usage, architecture,
provider-core, AppImage identity/journal and Electron updater tests. Full gate,
portable and native/package evidence are recorded in the PR after execution.

The first typecheck also caught a missing catalog import in the relocated error
parser. The import is restored, its failure-event behavior has a regression test,
and the subsequent typecheck passed. No threshold or timeout was changed.
