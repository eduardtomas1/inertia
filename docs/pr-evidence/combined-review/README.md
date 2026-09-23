# Combined review and validation

This integration replaces seven open PRs with one review and CI target, based
on main `558395da97498dd06201d7e5802b446272afd56c`. It also carries the reviewed
repairs and bounded diagnostic for the failures observed after #454 merged.
The original PRs remain open until this combined change has merged.

## Included sources

Each complete source head is an ancestor of the combined branch; no partial
feature copies were used.

| PR | Change | Integrated head |
| --- | --- | --- |
| [#458](https://github.com/eduardtomas1/inertia/pull/458) | Four Claude question answers | `f5010035df2eca922352fbb52b9ec58f72c20686` |
| [#457](https://github.com/eduardtomas1/inertia/pull/457) | Toolbar focus and failure evidence | `a0e20dbdee44a54f53151953361a3f6490015dbc` |
| [#456](https://github.com/eduardtomas1/inertia/pull/456) | Project colours and favourites | `a3436855f0e902d6e775f3f4dbb446969a2d86ca` |
| [#448](https://github.com/eduardtomas1/inertia/pull/448) | Unified composer surface | `4ef8ab5db494527ed9ffe15cb32a0fb538eb9283` |
| [#435](https://github.com/eduardtomas1/inertia/pull/435) | Attachment zoom and gallery | `9f7a0517f748f1f1da787220f955f7a9a5013750` |
| [#431](https://github.com/eduardtomas1/inertia/pull/431) | Confirmed source cleanup | `76bcb3300396a9de2758e07163edc565f319d610` |
| [#427](https://github.com/eduardtomas1/inertia/pull/427) | Package contents and transcript following | `f5cf5b1a38cfdd0ee49db96f5791af16c1fd9afb` |

## Integration review

- Build configuration retains both the working-indicator and project-colour
  deferred chunks. Bundle allowances from the reviewed feature branches are
  combined once, without an additional integration allowance.
- The explicit attachment admission predicate is applied to the single Attach
  button in the new composer layout. Existing Stop, attachment-kind/count,
  command authority, and import cancellation behavior remain intact.
- Two identical transcript resize observers share one callback and observer;
  existing reader-intent cleanup is reused. Two DOM regressions exercise both
  targets, reader history, conversation changes, and unmount cleanup. This saves
  252 emitted bytes in each affected aggregate and restores the bundle gate.
- Independent reviews covered configuration conflict resolutions, the
  composer admission integration, and the final transcript simplification.
  All seven original PRs had zero unresolved
  GitHub review threads when their source heads were rechecked.

## Main CI failures and evidence limits

[Main CI 35827187837](https://github.com/eduardtomas1/inertia/actions/runs/35827187837)
failed on Windows x64 pending attachment visibility, macOS Intel panel geometry,
and macOS ARM runtime resource shutdown.

The pending attachment fixture now observes the short-lived pending row in the
renderer before dispatch, retaining the nonzero geometry and no-premature-image
assertions. A controlled runner delay reproduced the old failure and passed
with the correction; hidden, missing, and prematurely populated pending rows
still fail. The layout fixture waits for its panel's finite animation before
measuring, retaining the strict bounds; a persistent 24-pixel offset still fails.
These controls establish the mechanisms, not the exact hosted event timing.

The macOS ARM shutdown owner remains unknown. A fixture-only bounded trace
records shutdown owners and elapsed intervals if the existing deadline fails;
it does not change deadlines, cleanup order, authority, or errors. A successful
local run does not reproduce or explain the hosted failure.

A prior individual-branch later-image-paste failure also remains unexplained.
One temporary same-dispatch observer run on the combined build passed in 19.5s;
the original fixture was restored immediately. No production instrumentation,
retry, delay, or admission relaxation was retained from that experiment.
The earlier Windows N-1 first-install failure likewise has no established cause.

## Initial combined validation

Source implementation: `7e416596f454e43c6c5855aad32254081b23cab5`, followed by
formatting-only `1ad1a7e3c0cffdedfbc8bf1f053952d49f1ab997` to retain the existing
Composer line ceiling. The normalized TypeScript/JSX syntax trees before and
after formatting are identical. Validation uses Node 22 on local macOS ARM64.
Historical per-PR reports and screenshots are supporting evidence, not fresh
certification of this combined source.

| Gate | Result |
| --- | --- |
| Reviewed dependency graph, `npm ci` | Passed; 670 packages, zero audit findings |
| Focused integration cohort | 302 tests, 21 files passed |
| Transcript/composer DOM cohort after size simplification | 57 tests, 3 files passed |
| Provider portable contract suite | 1,620 passed, 9 platform skips, 113 files |
| Linux packaging unit suite | 13 tests, 2 files passed |
| `npm run build:packaged` | Passed, including notices, guardian and bundle gates |
| Final desktop integration cohort | 26 scenarios passed in 2.7 minutes |
| Full `npm run check` | Passed: 9,868 tests, 146 skips, 919 passing files; 7 separate child-process controls also passed; final build and bundle gate passed |
| Local `package:dir`, package smoke and Electron fuse checks | Passed on macOS ARM64; ad-hoc signed local package, no notarization |

The portable cohort predates only the renderer observer simplification; provider
and server source were unchanged afterward. The new four-answer Claude
regression is also in the focused and full ordinary test gates.

The 26 desktop cases cover attachment gallery visibility and zoom, composer
height after navigation, responsive layout and popovers, image send and
follow-ups, project appearance and pinning, retained attachments, toolbar focus,
six workspace layouts, terminal/runtime recycling, transcript following,
working-indicator settings, and secure attachment validation and recovery.
The packaged smoke also verified the process guardian, Private Connect assets,
manual updater fallback, PDF extraction, image retention, and clean exit
(952ms launch to readiness; 722ms shutdown).

| Renderer aggregate | Measured bytes | Existing combined cap |
| --- | ---: | ---: |
| Main first load | 832,594 | 832,605.8 |
| Detached first load | 638,399 | 638,550.2 |
| Core CSS and JavaScript | 2,157,749 | 2,157,935.4 |

Native Windows, native Linux, Intel macOS, signing/notarization, and live provider
services are not certified by these local checks. Hosted CI must validate the
exact published combined head. Release signing, checksum and provenance
requirements remain unchanged; no release or version changes are included.

## Follow-up to the first combined CI run

At `862fdf9f`, the quality, lineage, minimum Node, four Windows unit shards,
Linux x64/ARM64, Windows x64 and macOS ARM64 jobs passed. Windows ARM64 failed
at the queued two-image paste in `image-follow-up-regression.spec.ts`, before
the later-paste stage. Its fake provider completed the held turn on a fixed
2.5-second timer. A controlled native run with a three-second attachment import
delay reproduced that exact missing-row failure. The fixture now releases the
provider only after observing two queued images and the active Stop control.
With the same three-second import delay, the corrected scenario passed in 30.2s.
The temporary delay was removed; all digests, queue-drain, later-image, error,
authority, and timeout checks remain.

The hosted trace places paste dispatch approximately 181ms after Send, before
the timer elapsed. It does not capture import/commit or admission timing, so it
cannot prove that timer expiration during import caused the hosted failure.
The controlled experiment establishes a fixture race and its correction; fresh
hosted validation is still required. This does not explain the distinct earlier
local later-paste failure.

[Review feedback](https://github.com/eduardtomas1/inertia/pull/459#discussion_r4080424522)
also found that Project Settings appearance writes bypassed its existing save
lock. Appearance and full-preference edits now share `mutate`/`savingRef`, and
both sets of controls disable during a save. Narrow appearance patches and
optimistic field updates in the separate customisation panel are unchanged.
Two DOM controls failed before the fix and now prove serialization in both
directions, refreshed revision/preferences after success, and unlocking/error
recovery after failure. All 17 project settings/appearance DOM tests passed.

Both follow-ups received independent source review. The final follow-up tree
passed `npm run check`: 9,870 tests, 146 platform skips, 919 passing files, plus
seven separate child-process controls; architecture, lint, types, build and
unchanged bundle budgets all passed. The fresh built app passed all three
affected native scenarios (queued/steered/later images and both project-colour
scenarios) in 19.7s. The earlier portable and packaged checks remain evidence
for the unchanged provider and packaging implementation; they were not rerun
for this renderer-and-fixture follow-up.

## Follow-up to the second combined CI run

At `8574a3a6`, Windows ARM64 passed the corrected queued-image scenario. Linux
x64, Windows x64, macOS ARM64, quality, lineage, minimum Node and all four Windows
unit shards also passed. Linux ARM64 failed only after the native attachment
send/restart test body completed: privileged cleanup could not confirm the
replacement runtime's process-tree exit. macOS Intel remained in progress at
the diagnostic review checkpoint.

The [shutdown evidence report](../main-runtime-shutdown/terminal-shutdown-diagnostic.md)
records the preserved failure and its limits. The affected image scenario now
enables the existing worker shutdown trace. A bounded, allowlisted test helper
collects any trace before fixture deletion, alongside existing runtime records.
It preserves all cleanup errors, deadlines and process authority. Missing trace
evidence is explicit and cannot identify the unfinished owner. This is an
evidence improvement; the Linux ARM failure's cause remains unproven.


The collector and existing failure-reporting cohort passed 34 tests; the
native attachment lifecycle scenario passed in 21.6s. An intermediate full
check passed 9,893 tests but failed the unchanged benchmark-readiness welcome
test: observation returned `unavailable` after 10ms. A single focused diagnostic
run passed all nine benchmark tests and showed a successful connection from
IPv4 loopback to the fixture's IPv6 wildcard listener. It did not establish the
cause of the full-suite failure. The fixture now includes only fixed scalar
connection/welcome/close observations in a failed assertion; its listener,
one-second deadline and required result are unchanged. The final focused
cohort passed all 43 tests across three files. None of these passes establishes
the cause of the earlier WebSocket failure.


The final diagnostic tree passed `npm run check`: 9,895 tests, 146 platform
skips, 920 passing files, plus seven separate child-process controls. All
architecture, lint, type, build and unchanged bundle-budget gates passed.
Only tests and evidence documents changed from `8574a3a6`; the earlier provider
portable and packaged checks remain scoped evidence for unchanged product code.
The Linux ARM shutdown and intermediate benchmark socket failures remain
unexplained. The exact newly published head still requires hosted validation.
