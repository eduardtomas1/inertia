# Watcher: attach, dock, receipts, findings and notes

Real screenshots of the built Electron app on Linux (Xvfb, 1920 × 1080 display,
window content resized to 1440 × 900), captured by `tests/e2e/watcher.spec.ts`
with `animations: "disabled"`. The spec starts from the shared `conversation`
fixture (one project in a temporary workspace, the watched chat renamed to
"Parser cleanup", three more seeded chats for split view) and a fake Codex app
server written into the fixture workspace. The same fake serves both the
watched chat and its watcher; the test scripts every watcher reply (`SILENT` or
one finding) and releases each of the watched turn's commands. No real provider
CLI, credentials, private prompt, user repository or account data appears in
these images; the timestamps are the capture run's local clock.

`renderer-bundle.json` in this folder is the separate renderer bundle
measurement and is not part of this capture.

## Attach a watcher to a running chat

The chat's actions offer **Add a watcher…** while its turn runs. The dialog
offers only ready routes on watcher agents, defaults to **Reviewer** and says in
its description, above the fold, that the watcher is read-only.

![Add a watcher dialog with the Reviewer preset selected](attach-dialog-light.png)

## The dock: checking, then a grouped receipt

The dock opens beside the chat. Its bar names the chat (read as **Watching
Parser cleanup**), with only More and Collapse beside the title, the muted line
**Watching · Codex · Reviewer**, the phase with **Pause** and **Check now**, and
the counters **N of 12 checks left this turn · K events seen · P waiting**. A
settled command wakes the watcher; the bar shows the check in progress, and the
Work tab marks the watcher **Checking**. Two quiet checks (`SILENT`) fold into
one receipt with a chevron, opened here to list each check.

| Checking | Receipt |
| --- | --- |
| ![Check 1 checking now, with the elapsed timer in the bar](dock-checking-light.png) | ![Checked 2 times … nothing to report, expanded](dock-receipts-light.png) |

## A finding, light and dark

A check that finds something becomes a card headed **Finding · <time>** with the
watcher's lifetime **Check 3** muted on the right, and **Send** and **Dismiss**.
The card sits on the strong surface with a line border in both themes.

| Light | Dark |
| --- | --- |
| ![Finding card with Send and Dismiss](dock-finding-light.png) | ![The same finding in the dark theme](dock-finding-dark.png) |

## Send, then the note in the main chat

**Send** queued the note while the turn ran (**Queued · sends after the current
turn**). When the turn ended, the note started the next turn under a **Note from
watcher · Reviewer · Codex** divider, the bubble itself says only **From
watcher**, and the main agent replied. The card's single status line now reads
**Sent <time> · after the turn ended**. The **Watched by** chip sits above the
composer, and the final checks of both turns fold into a new receipt above the
sent card.

![Main chat with the Note from watcher divider and the reply](main-chat-note-light.png)

## Work tab

The watcher is listed directly under its chat, indented, joins the Work tab's
arrow-key order (keyboard focus is on its row here) and offers the same thread
actions as other rows (right-click or Shift+F10).

![Watcher · Reviewer nested under Parser cleanup in the Work tab](work-tab-nested-light.png)

## Four split panes plus the dock

With four chats in split view, a pane would leave the chat less than 360 px
beside the dock, so the dock becomes a sheet inside the watched chat's pane. A
sheet starts collapsed; here the chip opened it over a light scrim. It stops
above the pane's composer, which stays usable, and a press outside collapses
it. It takes no fifth pane.

![Four split panes with the watcher sheet in the primary pane](split-panes-with-dock-light.png)

## Animation

`watcher-dock.gif` (960 × 600, 8.4 s, seven moments each held 1.2 s) steps
through the same run: the attach dialog, the dock appearing, a check in progress, the quiet
receipt, the finding, the queued note after **Send**, and the note divider in
the main chat. It is assembled from PNG frames the spec captured at those
moments, because the Electron fixture does not record video.

![Watcher flow from attach to the note in the main chat](watcher-dock.gif)
