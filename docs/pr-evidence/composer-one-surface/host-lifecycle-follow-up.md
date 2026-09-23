# Composer reserve across Settings and split navigation

Review of PR #448 at `47729b58fc20b3eab9cb7e6a19966e141606eb3b` found that
`useChatMinimumHeight` depended on stable React ref objects even though Settings
and split navigation replace their DOM elements. Starting outside the ordinary
chat left the hook unbound; returning to chat left it observing a detached host.
The new host then lacked the composer height reserve, allowing a large terminal
to cover controls in a tall composer.

The hook now compares the actual host and scope after each commit. It stops the
previous binding and observes the replacement only when that pair changes.
Ordinary renders retain their observers. Removing the host or unmounting removes
the reserve and disconnects both observers. The measurement and terminal sizing
formulas are unchanged.

## Regression evidence

- Five new DOM cases failed before the fix: initial Settings and split scenes,
  return from each scene, and replacing the scope under the same host. These
  cases also check cleanup and observer reuse on an unchanged render.
- Both native navigation cases failed against the original build after leaving
  Settings or split view: the attachment button's center hit the terminal instead
  of the button. The same geometry checks passed before navigation.
- The final native cases pass with a 1440×760 window, large interface scale,
  125% Electron zoom, a twelve-line draft, and the terminal resize handle set to
  its 640px maximum with the keyboard. They check the reserve, composer bounds,
  control/resize-handle hit testing, draft retention, and viewport overflow.
  The split case also checks the primary pane with its own terminal open.
- The existing native composer-responsive scenario passes across its themes,
  menus, attachment/queue states, and responsive layouts.

The bounded integration review found no additional confirmed issue in the
toolbar's handlers and disabled states, DOM keyboard order, reserve measurement,
or reduced-motion styles.

## Validation

Run on macOS ARM64 with Node 22.23.2, Electron 44.4.3, and `npm ci`.

- Focused unit/DOM tests: **120 passed across 6 files** (`chat-minimum-height`,
  `composer-lifecycle`, `composer-dock`, `workspace-scene-lifecycle`,
  `workspace-scene-rendering`, and `visual-contrast`).
- Native Electron: **3 passed**, one worker, 14.9 seconds:
  `chat-minimum-height-lifecycle.spec.ts` and `composer-responsive.spec.ts`.
- `npm run check`: **9,684 passed / 146 platform skips**, 898 files passed /
  16 skipped, plus **7 separate-process tests**. Lint, types, architecture,
  migration lineage, builds, and renderer bundle gates all pass.
- Main workbench first-load JavaScript: **825,878 bytes / 825,886.8-byte limit**.
  Core JavaScript: **2,138,270 bytes / 2,139,071.4-byte limit**.

Local logs: `/tmp/inertia-pr448-host-before.log`,
`/tmp/inertia-pr448-native-before.log`, `/tmp/inertia-pr448-focused.log`,
`/tmp/inertia-pr448-native-final.log`, and
`/tmp/inertia-pr448-final-check.log`. Native screenshots are Playwright
attachments named `composer-after-settings` and `composer-after-split`.

All existing test thresholds and renderer bundle limits remain unchanged by
this follow-up. The earlier screenshots in this directory document the original
visual change. Native Windows, Linux, and Intel Mac behavior, signed packages,
and live providers were not exercised in this follow-up. It changes no provider
protocol or package behavior; hosted CI and merge decisions remain with the
parent review task.
