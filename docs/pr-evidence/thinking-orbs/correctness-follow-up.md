# Working indicator correctness follow-up

Reviewed PR #454 from `18ebce8ca8174fbb1e030f6da4d5206708f388ff`, based on
main `be12f1e28ba784b62f2b3ca149519c99a8d34deb`, on macOS ARM64 with a real
Node 22 dependency installation. The existing screenshots and bundle measurements
describe the original feature; this note records the September 23 follow-up.

## Save rejection and concurrent edits

`WorkingIndicatorSettings` already handles a rejected save by discarding its
optimistic value, provided that request still owns the draft. However,
`SettingsView` passed its fire-and-forget wrapper, which swallowed the rejection
and returned `void`. The picker therefore continued showing an unsaved choice,
and clicking that same choice could not retry it.

The view now passes the original settings request promise. The runtime action's
existing error reporting still runs before it rethrows. A regression through
the real Settings view fails on the original wiring and verifies rollback and
retry after the fix. A second regression rejects an older request while a newer
choice is pending, then checks successful acknowledgement and a subsequent
authoritative update. The older failure cannot erase the newer choice.

## Popover containment diagnosis

The saved Mac ARM CI failure first passed the containment poll, then failed a
separate unpolled read after awaiting the menu animation: menu top `84.71875`,
workspace top `94`. The existing placement implementation was unchanged by the
working indicator feature.

The original native scenario passed locally. Frame-by-frame instrumentation
showed textarea autosizing changing the composer's geometry after split-pane
resizing, followed by the popover's scheduled placement frame. In a controlled
native textarea shrink, the menu moved from top `102` to `84.6015625` while the
workspace stayed at `94`; the existing observer restored top `102` on the
placement frame. This reproduces the transient overflow pattern without a
persistent placement defect. It does not prove the precise scheduling order of
the original hosted failure.

The test now awaits finite animations and the ResizeObserver-to-animation-frame
handoff before its existing three-second containment poll. It returns the
geometry that passed instead of sampling again without polling. The diagnostic
fallback likewise asserts and returns its own sample. Workspace padding, pane
and viewport containment, scrollability, visibility and keyboard assertions are
unchanged. The native scenario also exercises a late textarea resize while the
menu is already open, then restores its original height and checks containment
again. No production placement code or timeout was changed.

A separate negative control first passed normal containment, then forced a
persistent incorrect translation with a temporary `!important` CSS rule. The
updated helper rejected it in 2,920 ms under the unchanged three-second poll:
menu top `21`, workspace top `94`, with both workspace and pane containment
false. The temporary rule and timing instrumentation were removed before final
verification. An earlier successful sample therefore does not conceal a later
persistent placement defect.

## Review scope

The follow-up reviewed settings propagation and failure ownership, terminal
versus live rendering, phase identity and remote expiry, orb channel cleanup,
visibility/reduced-motion scheduling, canvas allocation and painting, the
vendored geometry integration, styling and existing bundle evidence. The save
rejection wiring was the confirmed production finding. No speculative changes
were made to the phase registry or animation engine.

The separately owned activity-toolbar focus fix in PR #457 is not copied here.
Hosted CI and later main integration remain the maintainer's responsibility.

## Local verification

Environment: macOS ARM64, Node 22.23.2, Electron 44.4.3; `npm ci`, with no shared
or symlinked dependency directory.

- The Settings-view rollback regression failed against the original prop wiring.
- Focused indicator, settings and placement coverage: 107 passed in ten files.
- Full `npm run check`: passed, 9,751 tests in 904 files, 146 platform skips and
  16 skipped files, plus seven separately executed subprocess tests. The test
  phase took 122.90 seconds. Lint, types, architecture, migrations, builds and
  the existing PR bundle budgets passed (core 2,100.5 / 2,102.3 KiB).
- The controlled native resize reproduced transient overflow and recovery;
  the negative control rejected persistent overflow within the same deadline.
- Final real Electron scenarios: all five passed with one worker in 13.3 seconds.
  They cover all composer utility popovers in both split panes, late textarea
  resizing, Classic rendering, keyboard setting changes, Automatic live phases
  shared with the sidebar, reduced motion and persistence after restart.
  The final bottom-left scratch-menu capture was visually inspected.

Windows, Linux and Intel Mac were not exercised locally. These checks use
synthetic provider events and do not certify live provider services or signed
packages. This renderer/test-only follow-up does not change provider protocols,
packaging, release assets or bundle caps. Hosted CI was not polled or rerun.
