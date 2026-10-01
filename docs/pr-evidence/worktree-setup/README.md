# Worktree setup

Real screenshots of the built Electron app on macOS 27.0.1 (arm64) at device
scale 2, captured by `tests/e2e/worktree-setup.spec.ts` ("captures every setup
state in light, dark and narrow windows") with `animations: "disabled"` and a
frozen clock. The spec seeds an isolated synthetic project through
`RuntimeStore` with one saved action, `node setup-worktree.cjs`, which waits for
a release file and then fails with 200 lines of output or succeeds. No live
profile, credentials, provider CLI or user repository content is used. The same
spec asserts the layout: no viewport overflow, the composer dock invariant, no
nested buttons and no clipped card text at every size, and the focus moves below.

Sizes: wide is 1440 × 920, narrow is 1000 × 800, and 760 × 600 is the drawer
layout. The four card-only images in `docs/screenshots/worktree-setup-*.png`
come from the same run.

## What changed

The setup card is now a quiet card in the timeline, like the background task
cards: a 5% text tint, `--radius-medium`, no border and no shadow. Status colour
appears only on the 16px icon (accent spinner while running, warning triangle
when setup needs attention, success check when ready, a muted minus when
skipped), always next to the title word. The private spinner keyframe is gone;
the card uses the shared `loading-mark`. Type uses the scale tokens: title, then
action and attempt in muted text, then the detail sentence.

"Output" is a quiet disclosure aligned with the title. Its accessible name is
its visible label, and it carries `aria-expanded` and `aria-controls`. The
output opens on `--code-surface` in the mono font, without a nested border,
bounded to 200px with its own labelled scroll, and scrolled to the end so the
failure line is visible first.

Stop setup and Retry setup are compact secondary buttons; Continue without setup
is a quiet text link. While a command is in flight the clicked control stays
focusable with `aria-disabled="true"`, and repeated clicks are ignored. When the
clicked control disappears because the state changed, focus moves to the card's
next action: Stop setup to Retry setup, Retry setup to Stop setup (and back to
Retry setup if the attempt fails), and Continue without setup to Output. The
redundant "Your first prompt will wait." line was removed because the detail
sentence already says it.

In Project settings, the explanatory paragraph that sat under the row as a
second block is folded into the row description, so "Run when creating a
worktree" is one ordinary row.

## Before and after

"Before" is the branch at `25a19054`, captured with the first version of this spec (which used the old "Show setup output" name).

| Before | After |
| --- | --- |
| ![Before: running, dark](before-worktree-setup-running-dark-wide.png) | ![After: running, dark](worktree-setup-running-dark-wide.png) |
| ![Before: running, light](before-worktree-setup-running-light-wide.png) | ![After: running, light](worktree-setup-running-light-wide.png) |
| ![Before: failed with output, dark](before-worktree-setup-failed-dark-wide.png) | ![After: failed with output, dark](worktree-setup-failed-dark-wide.png) |
| ![Before: failed with output, light](before-worktree-setup-failed-light-wide.png) | ![After: failed with output, light](worktree-setup-failed-light-wide.png) |
| ![Before: failed, 760 × 600](before-worktree-setup-failed-dark-760x600.png) | ![After: failed, 760 × 600](worktree-setup-failed-dark-760x600.png) |
| ![Before: skipped, dark](before-worktree-setup-skipped-dark-wide.png) | ![After: skipped, dark](worktree-setup-skipped-dark-wide.png) |
| ![Before: settings, light](before-worktree-setup-settings-light-wide.png) | ![After: settings, light](worktree-setup-settings-light-wide.png) |

## Every state after the change

| State | Dark | Light |
| --- | --- | --- |
| Running, wide | ![](worktree-setup-running-dark-wide.png) | ![](worktree-setup-running-light-wide.png) |
| Running, 1000 × 800 | ![](worktree-setup-running-dark-narrow.png) | ![](worktree-setup-running-light-narrow.png) |
| Running, 760 × 600 | ![](worktree-setup-running-dark-760x600.png) | |
| Stopped | ![](worktree-setup-stopped-dark-wide.png) | |
| Failed with output, wide | ![](worktree-setup-failed-dark-wide.png) | ![](worktree-setup-failed-light-wide.png) |
| Failed with output, 1000 × 800 | ![](worktree-setup-failed-dark-narrow.png) | ![](worktree-setup-failed-light-narrow.png) |
| Failed with output, 760 × 600 | ![](worktree-setup-failed-dark-760x600.png) | |
| Failed, Ember palette | ![](worktree-setup-failed-ember-dark-wide.png) | ![](worktree-setup-failed-ember-light-wide.png) |
| Skipped | ![](worktree-setup-skipped-dark-wide.png) | ![](worktree-setup-skipped-light-wide.png) |
| Ready | ![](worktree-setup-ready-dark-wide.png) | ![](worktree-setup-ready-light-wide.png) |
| Settings, wide | ![](worktree-setup-settings-dark-wide.png) | ![](worktree-setup-settings-light-wide.png) |
| Settings, 1000 × 800 | ![](worktree-setup-settings-dark-narrow.png) | ![](worktree-setup-settings-light-narrow.png) |
| Settings, 760 × 600 | ![](worktree-setup-settings-dark-760x600.png) | |

The Ember captures switch only the palette attribute on the document, to check
that the card follows palette tokens.

## Known issue visible in these captures

After Stop setup, the app shows the toast "This filesystem authorization expired
or no longer matches the request." Diagnostics records it as a Git operation
failure (`git.command-failed`) for the chat. It appears in the before captures
too and is not caused by the presentation change; it stays visible in the later
captures of the same run.
