# Diagnostics and Report an issue

Platform: macOS (Apple silicon), device scale 2, Electron 44.4.5, Node 22.23.2.

Diagnostics captures come from `tests/e2e/diagnostics-appearance.spec.ts`
(after) and the same seeded journal run against a build of `origin/main` at
1053edf2 (before, files prefixed `before-`). The fixture writes a synthetic
journal before launch (app start, runtime states, a runtime failure, a database
backup stderr code, and provider, Git, Discord and reconnect incidents) and uses
no real provider, account or network. The newest rows are the fixture app's own
start events, so their times and the process health numbers differ per run.
Wide is 1440×920, narrow 1000×800, and the tight size 760×600.

## Diagnostics

| State | Before | After |
| --- | --- | --- |
| Light, wide | ![](before-diagnostics-light-wide.png) | ![](diagnostics-light-wide.png) |
| Dark, wide | ![](before-diagnostics-dark-wide.png) | ![](diagnostics-dark-wide.png) |
| Expanded row, dark | ![](before-diagnostics-expanded-dark-wide.png) | ![](diagnostics-expanded-dark-wide.png) |
| Light, narrow | ![](before-diagnostics-light-narrow.png) | ![](diagnostics-light-narrow.png) |
| Dark, narrow | ![](before-diagnostics-dark-narrow.png) | ![](diagnostics-dark-narrow.png) |
| Dark, 760×600 | ![](before-diagnostics-dark-760x600.png) | ![](diagnostics-dark-760x600.png) |
| Capture off, dark | | ![](diagnostics-capture-off-dark-wide.png) |
| Clear history dialog, dark | | ![](diagnostics-clear-dialog-dark-wide.png) |

## Archive & data

| State | Before | After |
| --- | --- | --- |
| Local data, dark | ![](before-archive-data-dark-wide.png) | ![](archive-data-dark-wide.png) |

## What changed

- Diagnostics uses the shared Settings column and type scale. The tagline,
  icon tile, privacy strip, outcome pills, footer sentence and lock copy are gone.
- One header card: the *Capture diagnostics* switch, *Export…*, *Copy support
  summary*, *Reveal log folder*, *Clear history…*, and a two-line process
  health block. The last three moved here from Archive & data, which now shows
  storage only.
- *Recent events* lists lifecycle events and incidents together, newest first,
  filtered by level, source and time, with search. Rows are buttons; the outcome
  moved into the expanded detail.
- The spec also checks no viewport overflow, no nested buttons, untruncated row
  titles, 44 px rows, control sizes, keyboard expansion, focus return after the
  dialog and the capture switch keeping focus.
