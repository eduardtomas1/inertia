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
| Expanded row, light | | ![](diagnostics-expanded-light-wide.png) |
| Capture off, dark | | ![](diagnostics-capture-off-dark-wide.png) |
| Capture off, light | | ![](diagnostics-capture-off-light-wide.png) |
| Clear history dialog, dark | | ![](diagnostics-clear-dialog-dark-wide.png) |
| Clear history dialog, light | | ![](diagnostics-clear-dialog-light-wide.png) |
| No matching events, dark | | ![](diagnostics-empty-dark-wide.png) |
| Read failed, dark | | ![](diagnostics-read-failed-dark-wide.png) |

The read-failed state is produced by exhausting the per-minute read limit in the
spec, then reopening the page.

## Archive & data

| State | Before | After |
| --- | --- | --- |
| Local data, dark | ![](before-archive-data-dark-wide.png) | ![](archive-data-dark-wide.png) |
| Local data, light | | ![](archive-data-light-wide.png) |
| Local data, light, 1000×800 | | ![](archive-data-light-narrow.png) |

## Shared switch

The off thumb now uses `--text-muted` and the on thumb `--accent-text`; the spec
measures at least 3:1 against the track in both themes and states. General →
Workspace shows the other switches with the same change.

| Light | Dark |
| --- | --- |
| ![](settings-switches-light-wide.png) | ![](settings-switches-dark-wide.png) |

## What changed

- Every Settings page keeps at least a 20 px gutter beside the navigation
  (the shared `.settings-content` width now subtracts the 205 px navigation).
- Diagnostics uses the shared Settings header (icon, title, one line), column,
  type scale, field fill and select picker. The large heading, privacy strip,
  outcome pills, footer sentence and lock copy are gone.
- One header card: the *Capture diagnostics* switch, *Export…*, *Copy support
  summary*, *Reveal log folder*, *Clear history…*, and a two-line process
  health block. The last three moved here from Archive & data, which now shows
  storage only.
- *Recent events* lists lifecycle events and incidents together, newest first,
  filtered by level, source and time, with search. Rows are buttons; the outcome
  moved into the expanded detail.
- The spec also checks the navigation gutters, the shared field fill and
  picker, no viewport overflow, no nested buttons, untruncated row titles,
  44 px rows, control sizes, keyboard expansion, focus return after the dialog,
  the capture switch keeping focus and switch thumb contrast.

## Report an issue

Spec: `tests/e2e/issue-report.spec.ts` (`capture()` per state; the same spec asserts no viewport overflow, controls inside the shared 810 px column, no nested buttons, the primary button aligned with the fields, one baseline for the action row, and focus order). The renderer clock is frozen at 2026-10-03T16:20:00Z; GitHub CLI is a stub in the fixture provider folder and no issue was published. Before images come from the same states on a build of `origin/main` (1053edf2); the old flow has no signed-out state.

| State | Before | After |
| --- | --- | --- |
| Form, light, 1440×920 | ![](before-issue-report-form-light-wide.png) | ![](issue-report-form-light-wide.png) |
| Form, dark, 1440×920 | ![](before-issue-report-form-dark-wide.png) | ![](issue-report-form-dark-wide.png) |
| Form, light, 1000×800 | ![](before-issue-report-form-light-narrow.png) | ![](issue-report-form-light-narrow.png) |
| Form, dark, 1000×800 | ![](before-issue-report-form-dark-narrow.png) | ![](issue-report-form-dark-narrow.png) |
| Form, dark, 760×600 | ![](before-issue-report-form-dark-760x600.png) | ![](issue-report-form-dark-760x600.png) |
| Preview, light, 1440×920 | ![](before-issue-report-preview-light-wide.png) | ![](issue-report-preview-light-wide.png) |
| Preview, dark, 1440×920 | ![](before-issue-report-preview-dark-wide.png) | ![](issue-report-preview-dark-wide.png) |
| Preview, dark, 1000×800 | ![](before-issue-report-preview-dark-narrow.png) | ![](issue-report-preview-dark-narrow.png) |
| Preview, dark, 760×600 | | ![](issue-report-preview-dark-760x600.png) |
| GitHub CLI not signed in, dark | | ![](issue-report-signed-out-dark-wide.png) |

What changed: the page uses the shared Settings type scale and column instead of its own 20 px heading and full-width layout. The step list, privacy box, model and reasoning selects, project scope and the simulated report chat are gone with the validation run. The form is What happened, Steps to reproduce, Provider and Attach diagnostics; Preview issue shows the exact title and body in an editor with Back, Copy, Open GitHub manually and Create on GitHub. A GitHub CLI problem shows under the form when the page opens. The Storage & backups and Welcome guide cards now sit below the form.
