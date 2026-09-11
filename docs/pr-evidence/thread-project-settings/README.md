# Thread actions, project defaults and appearance

This feature branch adds thread organization and project-level defaults to
Inertia's existing runtime, workspace authority, settings and navigation.
It also makes scratch prompts chat-owned and adopts T3 Code's system font stacks.

## Behavior and boundaries

- Thread rows open their menu with right-click, Shift+F10 or the Context Menu key.
  The redundant row ellipsis is removed; unrelated project menus are retained.
  Escape restores row focus. Snooze and Settle/Reopen remain inline for inactive
  threads; running work keeps its status visible.
- The menu preserves split/window ownership and destructive-action guards.
  It adds calendar-based snooze choices, explicit unread marking, original
  checkout-path/thread-ID copy, and navigation to the original project's settings.
  Regenerate title uses a bounded excerpt of the latest user message locally;
  it does not issue an AI request. Hover/focus previews appear after two seconds,
  with one timer for the virtualized index, not one per row.
- Settings → Projects has the existing searchable project chooser, no machine
  selector. Name, bounded symbol/raster icon, exact native/custom model route and
  reasoning, default checkout mode, grouping, browser-tool policy and manual
  actions persist locally. Saving does not change existing provider sessions,
  move worktrees or execute actions. Stale project revisions cannot overwrite
  another window's changes. The merge-method setting is deliberately excluded.
- Automatic pull is opt-in and checks the recorded upstream/default branch.
  Unknown default branches, dirty/untracked files, local commits, active work and
  changed checkout identities prevent a merge. It uses existing bounded Git
  execution and exclusive workspace ownership, disables local Git hooks for
  fetch/merge, and only fast-forwards. It never stashes, resets, rebases or pushes.
  A single rotating scheduler is cancelled during runtime shutdown/update.
- Custom actions use the existing terminal/run lifecycle and canonical saved
  action ID. Executable and argument fields are separate; arguments are passed
  literally through the existing platform-safe process adapter. Saving an action
  refreshes the selected project's action list without switching chats. Browser
  policy applies at the original conversation's broker boundary across harnesses;
  it does not claim to control a provider CLI's independent tools.
- Each theme circle sets only that appearance; its card applies the pair.
  Migration and first-paint caches preserve the existing theme, and independent
  choices survive restart. The font stacks are system sans and system monospace,
  including terminal/auth terminal and Private Connect. Actual font faces vary
  with OS availability. Two bundled font packages are removed, no font is fetched.
- Scratch storage is scoped to the source conversation, including split views,
  storage events, restoration and explicit draft-to-created-chat transfer.
  Old ownerless storage is retained on disk but not exposed in an arbitrary chat.
  There is no automatic prompt replay or provider request.

## Source reference

The upstream reference inspected was
[pingdotgg/t3code at 6c583620ff7ad3235b135af7107c0543467eecfa](https://github.com/pingdotgg/t3code/tree/6c583620ff7ad3235b135af7107c0543467eecfa).
Its `apps/web/src/index.css` defines the adopted font stacks.
Thread/project behavior is implemented using Inertia's own contracts and
components; this is not a transplant of T3's machine or backend architecture.
Upstream source is MIT-licensed, copyright T3 Tools Inc.

## Reproduction and verification

The screenshots below come from a real built Electron app with an isolated,
temporary profile and synthetic projects. No personal chats, credentials or
user desktop screenshots are included. The user's running profile was untouched.
Captured on Linux x64, Electron 44.2, Node 22.23.2, at 1440×920 and 900×700.
The plain square image is the deliberately minimal image-upload fixture.

```sh
npm run check
INERTIA_E2E_WORKERS=1 npx playwright test tests/e2e/thread-project-settings.spec.ts --project=display-sensitive
INERTIA_E2E_WORKERS=1 npx playwright test tests/e2e/theme-library.spec.ts --project=isolated
```

Local results: `npm run check` passed (8,251 tests passed, 83 skipped;
766 passing test files, 8 skipped), including lint, types, migration lineage,
architecture and bundle gates. The focused Electron command passed all five
scenarios. Native CI results are tracked on the PR for its exact published head.

The four new Electron scenarios prove menu focus/copy/navigation and geometry,
settings and theme restart persistence, chat-owned stash restoration, and explicit
execution of a saved `node --version` action. The action ends successfully;
the terminal screenshot shows the normal ended-session overlay, not a live task.
Additional unit/DOM coverage exercises migration from main, malformed/oversized
preferences, custom model identity, approval/active-work exemptions, controlled
preview/snooze clocks, literal process arguments and early process exit, browser
policy, scheduler deadlines/cancellation, and real-repository Git safety.

Local screenshots are Linux evidence, not native Windows/macOS or signed-package
proof. Authenticated provider turns are not part of this feature's tests; provider
protocols, releases and version numbers are unchanged.

The project editor and thread menu are lazy loaded and individually budgeted.
The bundle gate also rejects either surface entering the initial window closure.
Small measured allowances cover the new shared preferences, appearance and
thread-state contracts; architecture ceilings and existing security gates remain.

## Screenshots

### Thread controls and menus

| Light | Dark |
| --- | --- |
| ![Thread context menu](thread-context-menu-light.png) | ![Thread context menu](thread-context-menu-dark.png) |
| ![Calendar snooze choices](thread-snooze-light.png) | ![Calendar snooze choices](thread-snooze-dark.png) |

![Two-second preview and inline controls](thread-preview-light.png)
![Keyboard-accessible copy submenu](thread-copy-light.png)

### Project settings

| Light | Dark |
| --- | --- |
| ![Project defaults](project-defaults-light.png) | ![Project defaults](project-defaults-dark.png) |
| ![Action editor and save controls](project-action-editor-light.png) | ![Checkout actions and safe removal](project-checkout-dark.png) |

![Searchable project chooser](project-chooser-light.png)
![Project symbol picker](project-icons-light.png)
![Normalized raster icon upload](project-image-icon-light.png)
![Narrow settings layout](project-defaults-narrow-dark.png)
![Saved action in the workspace menu](saved-project-action-menu-dark.png)
![Real action completes through the terminal](project-action-terminal-dark.png)

### Independent themes and font stacks

| Light | Dark |
| --- | --- |
| ![Ocean light with independently selected Iris dark](independent-themes-light.png) | ![Iris dark without changing the light choice](independent-themes-dark.png) |

### Chat-owned scratch prompts

| Source chat | Different chat |
| --- | --- |
| ![Saved prompt in its owner chat](chat-owned-scratch-prompt-dark.png) | ![No cross-chat prompt leakage](other-chat-scratch-prompts-empty-dark.png) |
