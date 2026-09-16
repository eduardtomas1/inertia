# Chats and agents

## Give the agent context

- **Attach** images, documents and spreadsheets, and mention project files.
- **Choose** the model, reasoning level and access mode for each chat. The composer border animates at the selected model’s highest supported reasoning level; reduced motion keeps it still.
- **Invoke a skill** by typing `$` and part of its name. Use ↑/↓ to choose, Tab or Enter to insert, and Escape to dismiss. You can edit a skill token anywhere in your draft.
- **Follow up** while an agent is working: send a message right away or queue it for the next turn. The composer shows *Enter sends · Tab queues* while this is possible.
- **Capture a window.** Turn on [Snapshots](../SNAPSHOTS_AND_COMPACTION.md) in the composer to attach a screenshot of the foreground window with its accessibility context.
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

## Find anything

Press ⌘K (Ctrl+K elsewhere) to find commands, projects, chats and saved messages. Type at least two characters to search your messages and final agent answers across unarchived chats, then open a result to jump to its turn, including in a separate chat window. Search matches literal phrases, ignores case and shows up to 20 of the newest matches.

## Optional desktop mascot

Turn on the mascot in **Settings → General** for a movable companion that previews progress, questions, approvals and results in a small bubble. Click the bubble to open the chat; right-click to pause or hide it.
