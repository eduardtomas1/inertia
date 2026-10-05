# Chats and agents

## Give the agent context

- **Attach** images, documents and spreadsheets, and mention project files.
- **Choose** the model, reasoning level and access mode for each chat. The composer border animates at the selected model’s highest supported reasoning level; reduced motion keeps it still.
- **Switch provider** in a chat that already has messages: a chat stays with its provider, so choosing a model from another provider asks **Continue in a new chat with** that model. **Continue** opens the new chat on the same checkout and branch, carries your unsent text, and attaches this chat as context. Preview or remove it above the composer before the first message. Chats without a project start an ordinary new chat instead.
- **Invoke a skill** by typing `$` and part of its name. Use ↑/↓ to choose, Tab or Enter to insert, and Escape to dismiss. You can edit a skill token anywhere in your draft.
- **Follow up** while an agent is working: send a message right away or queue it for the next turn. The composer shows *Enter sends · Tab queues* while this is possible. If the turn ends or the agent refuses the message before it arrives, the message is queued for the next turn instead. Cursor, Kimi and Antigravity cannot take a message mid-turn: the composer shows *Enter stops and sends · Tab queues*, and **Stop and send** stops the agent and sends your message as the next turn.
- **Keep queued work moving.** Up to three queued messages, including images, are saved by the local service and continue after a successful turn even when another chat is open. They survive an app restart. A stopped, failed or interrupted turn leaves its queue waiting for **Send now**. Changing the model, access or workspace pauses the affected message; remove and queue it again to confirm the new settings. Older local queues remain available for manual review.
- **Capture a window.** Turn on [Snapshots](../SNAPSHOTS_AND_COMPACTION.md) in **Settings → Devices & integrations → Snapshots** to attach a screenshot of the foreground window with its accessibility context.
- **Compact long chats** with `/compact`. A successful compaction leaves a receipt in the timeline with the provider-reported context counts.

## Follow the work

- The **Work** tab lists your chats. Running chats show the agent pixels and elapsed time, and a chat that needs your input or finishes gets a brief cue.
- The **Plan** and **Goal** panels show the plan and objective that the provider reports. Inertia doesn't invent a goal from the chat text.
- **Daily work** in the sidebar summarizes processed tokens, agent runtime and conversations.
- Switching between chats in the same window preserves your reading position. **Jump to latest** resumes following new content. This navigation memory lasts while the window remains open.

If a Claude provider update requires a fresh native session, Inertia supplies a bounded excerpt of this chat’s recent visible messages as historical reference. The execution context records any truncation. Recovery is omitted if it cannot fit alongside your selected context within the turn limits. Hidden provider state, attachment contents and tool output are not recovered; compatible native sessions continue normally.

## Keep work organized

Right-click a chat in the sidebar, or focus it and press Shift+F10 or the Menu key, to open its actions:

- **Pin** or **unpin** it.
- **Snooze** it for one or three hours, until this evening, tomorrow or next week.
- **Settle** finished work, or **reopen** it.
- **Rename** it, **regenerate the title** from the latest message, or **mark it unread**.
- **Copy** its path or thread ID.
- **Archive** it with **Archive thread**.
- **Open it in a new window** or **add it to split view**. See [Working side by side](working-side-by-side.md).

## Right-click menus

Right-click inside Inertia, or focus an item and press Shift+F10 or the Menu key, for the actions that fit where you are:

- **Messages:** **Copy** when text is selected, **Copy message** as plain text, and **Copy as Markdown** for agent answers.
- **Code blocks:** **Copy code**.
- **File links in answers, files in Files and changed files in Changes:** **Open**, **Reveal in Finder** (File Explorer on Windows, your file manager on Linux), **Copy path** and **Copy relative path**. Folders leave out **Open**.
- **Web links:** **Copy link address** and **Open link**. Images offer **Copy image**.
- **Text fields:** the usual editing actions, with up to five spelling suggestions for a misspelled word.
- **Terminal:** **Copy** the selection, **Paste**, **Select all** and **Clear**. On Windows, Ctrl+V also pastes into the terminal; on Linux, Ctrl+V still reaches terminal programs, so paste with Ctrl+Shift+V.
- **Browser pane:** the page's editing actions, **Copy link address**, **Back**, **Forward** and **Reload**. Pages that show their own menu keep it. A right-click the agent sends opens nothing, and **Back**, **Forward** and **Reload** are unavailable while an agent Browser command runs.

## Find anything

Press ⌘K (Ctrl+K elsewhere) to find commands, projects, chats and saved messages. Type at least two characters to search your messages and final agent answers across unarchived chats, then open a result to jump to its turn, including in a separate chat window. Search matches literal phrases, ignores case and shows up to 20 of the newest matches.

## Optional desktop mascot

Turn on the mascot in **Settings → Notifications** for a movable companion that previews progress, questions, approvals and results in a small bubble. Click the bubble to open the chat; right-click to pause or hide it. **Animate mascot** in the same place pauses or resumes its animation.

## Notifications

Desktop notifications tell you when a chat finishes, fails or needs your approval or answer, without prompt or response text. In **Settings → Notifications**, **Only when Inertia is in the background** skips them while any Inertia window is focused; completion sounds are not affected.
