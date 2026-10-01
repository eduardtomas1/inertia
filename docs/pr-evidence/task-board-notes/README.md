# Task board and chat notes

Real screenshots of the built Electron app on macOS 27.0 (arm64) at device
scale 2, captured by `tests/e2e/task-board-notes.spec.ts` ("captures the board
and notes in both appearances and three sizes") with `animations: "disabled"`
and a frozen renderer clock. The spec seeds an isolated synthetic database
through `RuntimeStore` before launch: two projects, a pinned chat, a completed
chat on a branch, a failed chat, a settled chat, a snoozed chat and one
88-character title. The palette is Ocean unless the name says otherwise. No
live profile, credentials, provider CLI or user repository content is used.

## What the polish changed

- The board has no hero. The window title already says "Task board", so the
  page opens on one compact toolbar: search, project, "Show snoozed" and the
  one primary action, "New task".
- Columns are a heading, a plain count ("Ready 5"), one muted line that says
  what the column holds and a hairline. The coloured dots and bordered count
  pills are gone; each card already states its status in words with an icon.
- Cards follow the Background tasks card: a 5% text tint, no border, no
  shadow. Project and harness share the first line ("Inertia · Codex"), the
  title wraps, the status and branch follow, and "Notes" and "Settle" are quiet
  text links.
- Empty columns say what is empty in one sentence ("No agents working.",
  "Nothing needs your attention."). A search with no results says it once
  above the columns.
- The create form uses a quiet tinted block, labelled fields with the help text
  linked to the title, and a right-aligned footer with Cancel then
  "Create task" on one baseline.
- Notes sit on tokens throughout. "Save notes" is a quiet button while there is
  nothing to save and becomes the primary action when the draft differs; it,
  Settle and Refresh stay focusable while busy (`aria-disabled`) so keyboard
  focus is never dropped. A concurrent edit shows an inline warning notice with
  a "Show saved notes" disclosure whose copy is a labelled, bounded, focusable
  block.
- Column count follows the board's own width (container queries), so opening
  notes moves the board to two columns instead of squeezing four.

## Board

| Before | After |
| --- | --- |
| ![Before: board dark](before-task-board-dark.png) | ![After: board dark](task-board-dark.png) |
| ![Before: board light](before-task-board-light.png) | ![After: board light](task-board-light.png) |
| ![Before: new task](before-task-board-create-dark.png) | ![After: new task](task-board-create-dark.png) |
| ![Before: no results](before-task-board-no-results-dark.png) | ![After: no results](task-board-no-results-dark.png) |
| ![Before: 760 × 600](before-task-board-760x600-dark.png) | ![After: 760 × 600](task-board-760x600-dark.png) |

| 1000 × 800 light | 1000 × 800 dark |
| --- | --- |
| ![Narrow light](task-board-narrow-light.png) | ![Narrow dark](task-board-narrow-dark.png) |

![New task, light](task-board-create-light.png)

## Notes beside the board

| Before | After |
| --- | --- |
| ![Before: notes dark](before-task-board-notes-dark.png) | ![After: notes dark](task-board-notes-dark.png) |

| Light | Unsaved draft | Ember palette, light |
| --- | --- | --- |
| ![Notes light](task-board-notes-light.png) | ![Unsaved](task-board-notes-unsaved-dark.png) | ![Ember](task-board-notes-ember-light.png) |

| 1000 × 800 light | 1000 × 800 dark | 760 × 600 dark |
| --- | --- | --- |
| ![Narrow light](task-board-notes-narrow-light.png) | ![Narrow dark](task-board-notes-narrow.png) | ![760 × 600](task-board-notes-760x600-dark.png) |

At 900 px and below the notes replace the board, with "Close task notes"
returning to it, as before.

## Notes in the right panel

| Before | After |
| --- | --- |
| ![Before: panel notes](before-task-board-chat-notes.png) | ![After: panel notes](task-board-chat-notes.png) |
| ![Before: conflict](before-chat-notes-conflict-dark.png) | ![After: conflict](chat-notes-conflict-dark.png) |

| Light | Conflict, saved copy open, light |
| --- | --- |
| ![Panel light](chat-notes-light.png) | ![Conflict light](chat-notes-conflict-light.png) |

| 1000 × 800 light | 1000 × 800 dark | 760 × 600 dark |
| --- | --- | --- |
| ![Narrow light](chat-notes-narrow-light.png) | ![Narrow dark](chat-notes-narrow-dark.png) | ![760 × 600](chat-notes-760x600-dark.png) |

## Command palette entry

![Palette](task-board-palette-dark.png)

## What the spec asserts

- At every captured size: no viewport overflow, no horizontal overflow in the
  board scroller, no nested buttons, no truncated card titles, and no card or
  empty state drawn with a border or shadow.
- The create form's Cancel and "Create task" share one top edge and height.
- The notes footer keeps its status and Save button on one centred row, and the
  notes body never scrolls sideways.
- The composer still ends at its dock beside the Notes panel.
- Opening notes focuses "Close task notes"; after a conflicting save, focus
  stays on "Save notes"; "Show saved notes" reveals a region named
  "Saved notes".

## Runs on this machine

- `tests/e2e/task-board-notes.spec.ts` with `--repeat-each=3`: 15 passed, and
  15 passed again under 12 CPU-burning processes.
- `tests/renderer/task-board.dom.test.tsx` and
  `tests/renderer/conversation-notes.dom.test.tsx` cover the focus, label and
  empty-state changes.

## Not exercised

- Linux and Windows rendering, forced colours and reduced motion in a real
  window, and a custom accent colour.
- The offline banner and a failed save in the real app (covered by DOM tests).

See [renderer-bundle.json](renderer-bundle.json) (`uiPolish`) for the bundle
measurements.
