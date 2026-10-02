# Chats without a project: screenshots

Real screenshots of the built Electron app on macOS 27.0.1 (arm64) at device
scale 2, captured by `tests/e2e/scratch-appearance.spec.ts` with
`animations: "disabled"` and the renderer clock frozen at 2026-09-30 16:20 UTC.
The spec seeds an isolated synthetic database through `RuntimeStore` and
`ScratchWorkspace`: two projects (Companion and Inertia) with two open chats and one
done chat, and four chats without a project (two open, one of them with a long
title, one done and one snoozed). No live profile, credential, provider CLI or
user repository is used. Implementation notes are in [review.md](review.md).

## What changed in the polish

- Sidebar: the "No project" heading starts on the row text edge, and its Done
  and Snoozed toggles sit exactly where the project Done and Snoozed toggles
  sit (the extra 14px indent is gone). Label style, counts and the chevron are
  the existing section recipe.
- Sidebar rows: under the "No project" heading a row no longer repeats
  "No project" and "Local workspace". The first line reads "Chat folder" with a
  plain folder icon (its full path is in the tooltip); the workspace line keeps
  only the provider mark, because a chat folder has no branch or worktree. The
  accessible name still says "No project".
- The dashed-square icon read as an empty placeholder. "No project" now uses a
  plain chat bubble everywhere (breadcrumb, composer chip, selector, new-chat
  chooser), and "Chat folder" uses a plain folder (sidebar and the composer
  checkout row, which previously showed the Git folder icon).
- Selector: "No project" gets the same two-line layout as the projects
  ("Start in a separate local folder", also its accessible description), and a
  muted icon like "All projects".
- Command palette: "Start without a project" now follows "New chat" and
  "New chat in…" instead of displacing "New chat" as the first action, so Enter
  in a freshly opened palette starts a chat in the current project again, as it
  does on main. It uses the same chat-plus icon as the first-run button.
- The disclosure toggles under "No project" are named "Done 1, No project" and
  "Snoozed 1, No project", so the accessible name starts with the visible label.

## Sidebar, header and composer of a chat without a project

| Before | After |
| --- | --- |
| ![Before: light wide](before-no-project-chat-light-wide.png) | ![After: light wide](no-project-chat-light-wide.png) |
| ![Before: dark narrow](before-no-project-chat-dark-narrow.png) | ![After: dark narrow](no-project-chat-dark-narrow.png) |
| ![Before: 760 × 600 drawer](before-no-project-sidebar-dark-760x600.png) | ![After: 760 × 600 drawer](no-project-sidebar-dark-760x600.png) |

The before captures come from the same spec at `faf4d53c`; in them one project
chat still had the fixture's default title.

| Dark wide | Light narrow | Dark 760 × 600 |
| --- | --- | --- |
| ![Dark wide](no-project-chat-dark-wide.png) | ![Light narrow](no-project-chat-light-narrow.png) | ![Dark 760 × 600](no-project-chat-dark-760x600.png) |

## New chat without a project and the selector

| Before | After |
| --- | --- |
| ![Before: selector](before-no-project-picker-light-wide.png) | ![After: selector](scratch-project-selector.png) |

| Light | Dark | Dark narrow |
| --- | --- | --- |
| ![Draft light](scratch-draft-light.png) | ![Draft dark](scratch-draft-dark.png) | ![Draft dark narrow](scratch-draft-narrow.png) |

![Selector dark](no-project-picker-dark-wide.png)

## New chat chooser and command palette

| Before | After |
| --- | --- |
| ![Before: chooser](before-no-project-new-chat-chooser-light-wide.png) | ![After: chooser](no-project-new-chat-chooser-light-wide.png) |
| ![Before: palette](before-no-project-palette-dark-wide.png) | ![After: palette](no-project-palette-dark-wide.png) |

![Palette light](no-project-palette-light-wide.png)

## First run

| Light wide | Dark narrow | After "Start without a project" |
| --- | --- | --- |
| ![First run light](no-project-first-run-light-wide.png) | ![First run dark narrow](no-project-first-run-dark-narrow.png) | ![First draft](no-project-first-draft-dark-wide.png) |

## What the spec asserts

- The "No project" heading's text starts on the row text edge, and both of its
  disclosure toggles start exactly where the project Done toggle starts.
- Every row under "No project" reads "Chat folder" and never "Local workspace";
  the composer checkout row reads only "Chat folder" (no branch).
- The selector marks "No project" selected with its description; the project
  filter never offers it; the palette's first action is still "New chat".
- No viewport overflow at 1440 × 920, 1000 × 800 and 760 × 600, no nested
  buttons, and the composer still ends at its dock.

## Runs on this machine

- `scratch-appearance.spec.ts` with `--repeat-each=3`: 6 passed normally and 6
  passed under 12 CPU-burning processes.
- `scratch-chat.spec.ts` (fake Codex in the fixture's provider directory): 1
  passed.

## Not exercised

Linux and Windows rendering, forced colours and custom colour themes in a real
window. Bundle measurements against main `46cbe6c3` are in
[renderer-bundle.json](renderer-bundle.json).
