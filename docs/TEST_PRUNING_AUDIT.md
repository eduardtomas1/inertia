# Test pruning, 26 September 2026

Initial audit: `12b0ded67630a73a3dc9dfd266f294a4e73dad14` (v0.0.63).
Final comparison base: `bab54e9b89d383bcf760c041bf7d1fc93124407b`, after
integrating PR #474's fixture isolation from fresh `main`.

## Removed checks and surviving coverage

Paths in this table are relative to `tests/`.

| Removal | Reason and remaining coverage |
| --- | --- |
| `renderer/composer-control-family.test.ts`, `composer-dock.test.ts`, `composer-zones.test.ts`, `composer-below-dock.test.ts` | These reread TSX/CSS to freeze component names/order, hooks, padding, icon sizes, shadows and literal media queries. `renderer/composer-lifecycle.dom.test.tsx` exercises the labelled input/control groups, keyboard order, reasoning/access updates, queue, mentions, skills, goals and route confirmation. `renderer/dismissible-menu-focus.dom.test.tsx` covers focus restoration. `e2e/composer-responsive.spec.ts` measures actual dock/control/attachment bounds, textarea growth, overflow, menu placement, keyboard dismissal and focus across themes, scales and narrow panes. The repeated usage-mode assertions are already in `renderer/usage-display.test.ts`. Exact decorative values are no longer frozen separately from these behavior/layout checks. |
| `renderer/composer-backend-picker.test.ts` and the final source-reading case in `renderer/model-chooser.test.ts` | Source substrings did not prove correct route selection, autofocus or focus restoration. `renderer/model-chooser-routes.test.ts` checks exact routes and exclusion of credential/endpoint metadata; `renderer/model-chooser.dom.test.tsx` exercises accessible results, keyboard selection, availability and restored focus. `renderer/composer-lifecycle.dom.test.tsx` and `e2e/model-chooser.spec.ts` retain fresh-session confirmation, history and draft preservation. `e2e/settings.spec.ts` and `e2e/model-chooser-appearance.spec.ts` retain the responsive settings/chooser layouts. All executable cases in `model-chooser.test.ts` remain. |
| `renderer/composer-stream-boundary.test.ts` | Checking `react.memo` and absent prop names duplicates the stronger `renderer/streaming-render-isolation.dom.test.tsx`: real streamed events must commit the transcript without rendering Composer or the surrounding workspace. |
| `renderer/command-palette-selection.test.ts` | `renderer/command-palette.dom.test.tsx` already tests synchronous focus, action/query reset, focus trapping and restoration. Its selection case now keeps the old option in the filtered results, proves selection resets, and distinguishes mouse entry from pointer movement. The old case filtered down to the already-selected option and could miss a broken reset. |
| Fixed-style case in `e2e/working-indicator.spec.ts` | Component selection and switch state need no native geometry. `renderer/working-indicator.dom.test.tsx` already checks fixed styles on the working cue, unchanged tool icons, and synchronized sidebar/timeline designs for every phase. A small settings case now checks disabling the activity switch for Shaping and restoring its saved value for Automatic. Four native cases remain for default CSS, Settings-to-runtime updates, real canvas animation/reduced motion, and restart persistence. |
| Eleven deleted-file keys in `.github/test-durations/windows-x64.json` | Seven belong to this deletion; four already pointed to absent files (`app-update-notice.test.ts`, `conversation-context-dialog.dom.test.tsx`, `sidebar-current-state.test.ts`, `sidebar-project-quick-chat.test.ts`). All 585 surviving timings, provenance, scheduling defaults and worker/deadline policies are unchanged. The sharding test replaces its arbitrary minimum of 590 files with nonempty/current-discovery assertions, while retaining provenance, exhaustive/disjoint membership and weight-spread checks. |

## Reachability and retained tests

The audit traced test discovery in `vitest.config.ts` and `playwright.config.ts`,
package scripts, Windows shard discovery/timings, portable manifests, workflows,
and repository-wide fixture/helper references, including documentation tools.
The deleted files had no import consumers or script selectors; the seven timing
keys were their only explicit external filename references.

No orphan fixture file was confirmed. In particular, the retired CLI helpers
still support agent-harness, provider-manager, installation-lease and benchmark
tests. They and their failure, cancellation and process-ownership assertions
remain. Database migration fixtures, platform-specific native fixtures,
packaging gates and provider protocol fixtures remain. Source-reading tests
with distinct accessibility, security or lifecycle contracts also remain.

## Size and runtime

Counts use tracked files under `tests/`; text lines use `splitlines()` and exclude
the six SQLite files containing NUL bytes. Documentation and the timing manifest
are outside these counts.

| Measure | Before | After |
| --- | ---: | ---: |
| Test-tree files | 1,184 | 1,177 |
| Test-tree text files | 1,178 | 1,171 |
| Test-tree text lines | 345,049 | 344,257 |

Seven deleted files contain 760 lines. The whole test-tree change removes a net
792 lines: 24 unit cases retired, one DOM case added, and one native case removed.
This reduces maintenance without claiming that slow or platform-specific tests
are dead.

The focused native indicator run passed before (5 cases, 10.8 seconds) and after
(4 cases, 8.7 seconds). These are single local observations, not a controlled
benchmark: the baseline also prepared the Electron binary. No whole-suite or
Windows runtime reduction was measured or extrapolated.

## Verification

- Baseline deleted/edited unit group: 9 files, 34 cases passed.
- Final focused behavior group: 9 files, 134 cases passed, including Composer
  lifecycle, streaming isolation, palette, model routes/chooser, usage display,
  focus restoration and indicator settings.
- Native indicator before/after and surviving composer-responsive/model-chooser:
  5/5, 4/4 and 2/2 cases passed on macOS arm64.

Native runs used the exact temporary patch from open PR #474 at
`09778b8068466cebb7c303be852aab2b8137a0f3`, based on the same baseline. Its patch
SHA-256 was `a16193042c4c5568e5f06090698c36e9b2dabbedda88928fa0ae8af926e4d9b9`.
That confines discovery to fixture executables. The patch was reversed and the
diff checked before final validation. These initial native results were
integration evidence with #474. After it merged, this branch rebased onto fresh
`main`; final validation uses the committed isolation code. No personal provider
accounts were exercised. Linux and Windows native execution were not performed
locally.
