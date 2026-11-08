# Cursor SDK renderer checkpoint

The SDK renderer integration is part of draft PR #686 on `orchestrator-v2`.
This checkpoint does not complete V2 or authorize a packaged SDK release.
The exact 1.0.38 platform archive licenses/notices remain BLOCKED as documented
in [cursor-sdk-license-evidence.md](cursor-sdk-license-evidence.md).

## Integrated behavior

The main App supplies its existing command/event transport through a scoped
Cursor SDK context. The Cursor card in Accounts and API keys exposes a separate, explicitly opened
SDK section. The provider editor and account cards share the same settings page,
so there is one SDK entry rather than duplicate login controllers. Its implementation loads
lazily. It uses inline settings, preserving the settings surface's focus and
native-preview behavior without adding another modal. Close restores focus to
the entry button and unmount cancels the exact active login attempt.

Availability checks do not initiate login. Saved-credential presence explicitly
says remote validity has not been checked. Login subscribes before dispatch,
correlates command replies and targeted progress, ignores foreign/completed
attempt updates, validates browser URLs with the shared validator, and opens
only through `window.inertia.openExternal`. Cancellation remains active until
terminal progress. Offline transitions invalidate local evidence and attempts;
reconnect requires a fresh user action. Successful login refreshes status and
then the authenticated model catalogue. Existing CLI login callbacks are intact.

The actual model chooser has a lazy SDK catalogue section. Its explicit load
action runs status before authenticated discovery. Unavailable installations or
missing saved credentials cannot expose SDK choices. Only concrete runtime
catalogue IDs become choices; `default` and `provider-default` are excluded.
Clicking a model uses the existing chooser selection callback and validated
configuration path, with `harnessId: cursor-sdk`, `backendProfileId: builtin:cursor`,
null alias/reasoning/context override, and empty options/capabilities. It does
not fabricate capability evidence or execute providers in the renderer. Runtime
validation remains authoritative. Cursor ACP defaults/history remain separate.
The SDK catalogue is ephemeral and refreshed on each explicit load; closing the
chooser or disconnecting discards it. SDK favourites/custom catalogue editing
are not introduced in this checkpoint.

## Current T3 comparison

Inspected reference objects using `git show` and `git grep` at
`32ecd71726fee16f335484c1f95cbce126d461f6` in the supplied visual-reference repo:

- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` filters Cursor
  settings unless its default provider instance exists and explicitly refreshes
  models/secrets. This integration instead keeps a discoverable SDK account
  entry, with availability checked before login/model selection.
- `ProviderModelsSection.tsx` offers custom model definitions, favourites,
  hidden models and ordering, and derives option labels from capability
  descriptors. This SDK route accepts only the exact authenticated runtime
  catalogue and advertises no unverified reasoning/fast-mode options.
- `ProviderInstanceCard.test.ts` exercises sensitive environment-field secrets
  and secret references. This implementation uses the existing main-owned SDK
  browser-login/vault seam; no secret value reaches this renderer.

No T3 source was copied, and no provider-default behavior was imported.

## Files

Existing renderer wiring: `App.tsx`, `ModelBackendsSettings.tsx`,
`ModelChooser.tsx`, and
`utils/modelChooserRoutes.ts` (SDK harness label only).
New feature modules live under `src/renderer/src/components/cursor-sdk/`:
transport context, lazy account entry, account controller/view/styles,
model catalogue view, and concrete route construction.

Tests: `tests/renderer/cursor-sdk-account.dom.test.tsx`,
`cursor-sdk-models.dom.test.tsx`, `cursor-sdk-model-route.test.ts`; added an
SDK-entry screenshot scenario to the existing Electron
`tests/e2e/provider-settings-visual.spec.ts`.

## Verification and limits

Final focused regression run: **40 tests pass across five files**, including
existing model chooser and backend account suites. Edge cases include unsafe
browser links, late waiting progress after cancellation, and completion before
the login command acknowledgement. Log: `/tmp/cursor-sdk-ui-final-regression.log`.
Focused standard/type-aware lint and scoped diff checks passed. Architecture
passed initially; the later whole-tree run reports concurrent files outside this
package: `orchestration/fork-surface.tsx` ↔ `history-actions.tsx` and nonliteral
requires in `server/provider/cursor-sdk-loader.ts`. The parent was notified;
log: `/tmp/cursor-sdk-ui-final-architecture.log`.
TypeScript and Electron build/screenshot outcome are recorded below when complete.

No live provider/account calls, no full-suite/CI monitoring, no commit/push, and
no packaged release validation are performed by this renderer task. The parent
owns the integrated full gate and commit/push checkpoint. Successful synthetic
DOM cases do not certify upstream authentication or packaged SDK availability.

### Desktop verification

Web TypeScript passed. Unit-test TypeScript passed after removing three invalid
Testing Library `exact` query options (string role names are already exact).
Logs: `/tmp/cursor-sdk-ui-types.log` and
`/tmp/cursor-sdk-ui-final-unit-types.log`.

Electron build passed (`/tmp/cursor-sdk-ui-final-build.log`). The actual existing
Electron fixture ran the SDK-entry case successfully: **1 test passed**
(`/tmp/cursor-sdk-ui-final-e2e.log`). The shell's inherited
`ELECTRON_RUN_AS_NODE=1` had to be removed for Electron launch. The first launched
case exposed two entries on the same settings page; removing the redundant
provider-editor entry resolved it, followed by a rebuild and successful capture.
No provider or account call is made by this screenshot case.

The screenshot was visually inspected: the single SDK account section and its
controls are visible without clipping. Preserved at
`.cache/cursor-sdk-ui/account-entry.png`; the parent copied it to
`docs/pr-evidence/orchestrator-v2/screenshots/cursor-sdk-account.png`.
The capture shows the pre-check state, not successful authentication.

### Bundle investigation in progress

The parent additionally assigned the current bundle gate blockers, without
budget increases. Original integrated build measurements:

| Gate | Measured bytes | Limit bytes | Excess |
| --- | ---: | ---: | ---: |
| Main workbench first load | 961472 | 947062 | 14410 |
| Detached chat first load | 855274 | 841026 | 14248 |
| Core JavaScript | 2473926 | 2448860 | 25066 |

A temporary profiling plugin outside the repository records emitted modules and
static dependencies; no build configuration or budget file is changed. The SDK
account/controller/catalogue chunks are deferred, with only the 86-byte context
chunk eager. The history/fork implementation was reached eagerly through
ChatWorkspace; its owner is handling the proper lazy context/panel boundary.
The investigation distinguishes first-load reduction from total core cost:
moving code to another unbudgeted dynamic chunk does not remove it from core.

A controlled renderer build substitutes the four SDK wiring files with their
HEAD blobs through a temporary Vite load hook, leaving the working tree intact.
Before-SDK output has main 960855, detached 854838, core 2464290 bytes, all still
over their limits. This establishes substantial non-SDK costs rather than
attributing all current overages to the new SDK entry. A full saved-HEAD renderer
comparison and post-boundary measurements follow; builds use the actual
Electron renderer configuration and serialize under the shared lock.

### Final measured boundary and remaining gate failures

The saved-HEAD (`e6189b9b7be91b0aad4f917c81f38c425985e8e5`) virtual renderer
comparison substitutes modified tracked renderer/shared files with their HEAD
blobs, using the installed locked dependencies and actual Electron renderer
configuration. It creates build artifacts only, not another checkout or changes
to the integration worktree. Its inherited overages are main **6149 bytes**,
detached **6168 bytes**, and core **6432 bytes**:

| Build snapshot | Main first load | Detached first load | Core bytes |
| --- | ---: | ---: | ---: |
| Saved HEAD source | 953211 | 847194 | 2455292 |
| Current phase before SDK wiring | 960855 | 854838 | 2464290 |
| Current phase with SDK, before chooser boundary | 951726 | 845509 | 2475349 |
| Final chooser boundary | 902267 | 796031 | 2477844 |

The before-SDK and before-chooser rows are separate controlled snapshots, not
an additive attribution: the history owner completed its lazy boundary between
them. The last two rows are the matched chooser comparison. The counterfactual
restores the original full chooser with the SDK entry while leaving the current
history boundary in place. It measures **49459 / 49478 bytes less startup JS**,
with **2495 additional core bytes** for the persistent intent wrapper, separate
module and preload metadata. No claim is made that deferred code disappears.

`ModelChooser.tsx` now retains the actual trigger DOM node, anchor, open intent
and preview suspension. `ModelChooserLoaded.tsx` contains the existing searching,
favourites, navigation, virtualization and results implementation, loaded only
on explicit activation. Pending Escape/outside dismissal cannot reopen after
loading. Keeping preview suspension in the persistent wrapper avoids a transient
resume while the loaded surface mounts. Existing focus restoration and source
prefetch behavior are covered by regressions; the source-prefetch test now waits
for the intentional chooser chunk boundary before checking its first commit.

The now-deferred shared virtualization dependency increases incremental Files
cost by **35327 bytes** and transcript cost by **35383 bytes** compared with the
matched pre-chooser build. These are real route transfers, not additional total
code. Renderer-owner freeze results before the later parent integration and
reviewed allocation correction (`/tmp/cursor-sdk-final-measurements.log`):

| Gate | Final bytes | Limit | Outcome |
| --- | ---: | ---: | --- |
| Main first load | 902267 | 947062.8 | Pass |
| Detached first load | 796031 | 841026.2 | Pass |
| Files incremental first load | 145998 | 117760 | Fail by 28238 |
| Transcript incremental load | 621863 | 614400 | Fail by 7463 |
| Deferred composer queue | 13302 | 13276 | Fail by 26 |
| Core | 2477844 | 2448860 | Fail by 28984 |

That whole bundle gate was **not green**. No unrelated redesign, budget increase,
new accounting exclusion, or forced eager import was used to conceal these
costs in the renderer package.

The later frozen parent integration measures main 902,353, detached 796,117 and
core 2,478,063 bytes; Files, transcript and queue are unchanged. Independent
Astra High review accepted the measured Files/transcript allocation transfer,
an explicit total-core allowance with 256 bytes of headroom and a measured
26-byte queue correction. The parent also narrowed both startup limits to their
final measurements plus 512 bytes. Existing accounting is unchanged. The core
residual is 6,432 bytes inherited at saved HEAD, 2,495 bytes from the matched
chooser split and 20,276 bytes of remaining integrated growth; this last amount
is not independently isolated SDK cost. The gate passes on that built output.
Final application rebuild verification and exact limit values are recorded in
[phase3-verification.md](phase3-verification.md) and
[renderer-bundle.json](../pr-evidence/orchestrator-v2/renderer-bundle.json).

Final focused run: **53 tests / 9 files pass**
(`/tmp/cursor-sdk-final-all-renderer.log`). After moving preview ownership to the
persistent wrapper, the two relevant preview/pending-load files pass all three
cases (`/tmp/cursor-sdk-final-preview.log`); these overlap the 53 and are not
added to that count. Web and unit-test TypeScript pass
(`/tmp/cursor-sdk-lazy-chooser-types.log`); focused standard/type-aware lint and
diff checks pass. Final architecture passes (1836 source files / 7625 edges),
resolving the earlier concurrent failures (`/tmp/cursor-sdk-final-architecture.log`).
The actual Electron chooser regression passed before the final preview-ownership
refinement; its final rebuilt recheck is recorded below. Final renderer-only
build uses the normal Electron renderer config, with two Terser workers and the
shared heavy lock (`/tmp/cursor-sdk-chooser-final-build.log`).

Additional files for the measured boundary: `ModelChooserLoaded.tsx`,
`tests/renderer/model-chooser-lazy.dom.test.tsx`; updated chooser unit/DOM tests,
`accessibility-focus-policy.dom.test.tsx`, and
`native-preview-suspension.dom.test.tsx`. No shared contract, server, main,
packaging, runtime-command-policy, or peer-owned history source was edited.

Final rebuilt Electron chooser recheck: **1/1 passed in 24.2 seconds**
(`/tmp/cursor-sdk-chooser-final-e2e.log`), after the persistent-wrapper preview
refinement. Source is frozen for parent integration. Account screenshot remains
valid and unchanged; no live-account or packaged SDK execution is claimed.
