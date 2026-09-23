# Right-panel geometry after sheet entrance motion

The Intel Mac job in [run 35822583812](https://github.com/eduardtomas1/inertia/actions/runs/35822583812/job/107057631827)
failed `layout.spec.ts` at PR head
`a77e2e12a3f361338ab5d0b5283a8e7f249a5cfa`: the panel's right edge was
915px, above the allowed frame edge plus 1px (893px).

The saved artifact includes a successful light-wide screenshot before the
failure, locating it in the next light-sheet iteration at 900×700. Its trace
contains test/API timings and prior screenshots, but no browser snapshots,
computed animation state, or failing light-sheet screenshot. It does not prove
the exact animation clock state in that hosted run.

## Diagnosis and controls

The sheet has a 150ms CSS entrance animation, `workspace-panel-sheet-in`,
starting at `translateX(24px)`. The test previously sampled geometry without
waiting for this motion; its later screenshot disables animations only after
the geometry assertions.

- The unchanged scenario passed locally in 8.6 seconds.
- A native control restarted the actual CSS animation and held its current time
  at zero. The original `panelGeometry` returned the same failing bounds:
  panel right **915**, frame right **892**, with transform
  `matrix(1, 0, 0, 1, 24, 0)`. After playing that animation to its natural finish,
  the same element's right edge was **891** and transform was `none`. The original
  strict assertion rejected its earlier sample.
- The corrected helper waits for the panel's own finite animations before
  reading all geometry. Replaying the same real entrance motion now returns
  **891** and the whole scenario passes (8.5 seconds).
- A negative control applied a persistent `translateX(24px)` to the panel.
  The corrected helper still returned **915**, and the unchanged **≤893**
  assertion failed immediately (geometry read: 1ms). Waiting for animation
  completion therefore does not conceal persistent out-of-bounds layout.

These controls establish a mechanism producing the exact reported failure;
they do not reconstruct the hosted compositor's timing. No production layout
defect was demonstrated, so the correction changes only the native test's
measurement ordering. Every containment inequality, width minimum, sheet-mode
check, and timeout is unchanged. All temporary replay, translation, and logging
instrumentation was removed before final validation.

## Main integration and validation

Ordinary merge `425f2eb7c1e090f19363318d2aac1fc3a29417b3` incorporates exact
reviewed main `558395da97498dd06201d7e5802b446272afd56c` into this branch.
The only conflict was in two bundle-budget rows. Resolution retains the existing
composer allowance of 164 bytes alongside main's already reviewed working
indicator allowances of 1,744 first-load bytes and 13,884 core bytes. All other
main changes and its deferred-orb checks are preserved. No new allowance was
introduced.

Measured combined output on Node 22.23.2 / Electron 44.4.3 / macOS ARM64:

| Budget | Measured bytes | Limit |
| --- | ---: | ---: |
| Main workbench first load | 827,622 | 827,630.8 |
| Core JavaScript | 2,152,345 | 2,152,955.4 |
| Detached chat first load | 633,626 | 633,675.2 |
| Deferred working orb | 21,815 | 22,528 |

- Integrated focused unit/DOM tests: **151 passed / 8 files**.
- Integrated native Electron: **14 passed**, one worker, 37.4 seconds. Includes
  six layout cases, Settings/split host replacement, responsive composer,
  split-pane popovers, and four working-indicator settings/restart cases.
- Integrated `npm run check`: **9,759 passed / 146 platform skips**, 905 files
  passed / 16 skipped, plus **7 separate-process tests** (test phase: 121.07s).
  Lint, types, architecture, migration lineage, builds, and all bundle gates pass.

Local evidence: `/tmp/inertia-pr448-layout-baseline.log`,
`/tmp/inertia-pr448-layout-motion-before.log`,
`/tmp/inertia-pr448-layout-motion-after.log`,
`/tmp/inertia-pr448-layout-negative.log`,
`/tmp/inertia-pr448-integrated-focused.log`,
`/tmp/inertia-pr448-integrated-native.log`, and
`/tmp/inertia-pr448-integrated-check.log`.

Native Intel Mac, Windows, Linux, signed packages, and live providers were not
exercised in this local follow-up. Hosted CI and merge decisions remain with
the parent review task. The earlier host-lifecycle evidence records the previous
base; the integrated measurements and results here supersede those gate totals.
