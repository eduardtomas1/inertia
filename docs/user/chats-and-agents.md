# Chats and agents

## Give the agent context

- **Attach** images, documents and spreadsheets, and mention project files.
- **Reference a chat** by typing `@` and part of its title, or `@this` for this chat's earlier messages. The agent gets a size-limited copy taken when you pick the chat, refreshed if that chat was still working and finishes before you send. Select a reference in the composer or on a sent message to see exactly what the agent gets. Inertia asks before it shares a chat from another workspace.
- **Choose** the model, reasoning level and access mode for each chat. The composer border animates at the selected model’s highest supported reasoning level; reduced motion keeps it still.
- **Switch provider** in a chat that already has messages: choose a model from another provider and keep going in the same chat. The next message starts a new session on that provider with the chat's earlier visible messages and a list of the files its turns changed as context; tool output, file contents, and hidden provider state stay behind, and secrets are redacted only where they match known patterns. The timeline marks the switch with a **Context handoff** divider that names both providers and how many earlier messages were carried, or left behind when they did not fit. Start a goal only after that first message.
- **See the shortcuts** in the empty composer: *Ask anything. @ files, $ skills, / commands* in a new chat and *Follow up. @ files, $ skills, / commands* once it has messages. *$ skills* appears only when the chat's agent supports skills.
- **Invoke a skill** by typing `$` and part of its name. Use ↑/↓ to choose, Tab or Enter to insert, and Escape to dismiss. You can edit a skill token anywhere in your draft.
- **Stop** a working agent with the round red button that replaces Send while it works (**Stop agent**).
- **Follow up** while an agent is working: send a message right away or queue it for the next turn. The composer shows *Enter sends · Tab queues* while this is possible. If the turn ends or the agent refuses the message before it arrives, the message is queued for the next turn instead. Cursor, Kimi and Antigravity cannot take a message mid-turn: the composer shows *Enter stops and sends · Tab queues*, and **Stop and send** stops the agent and sends your message as the next turn. While another message is queued, send or remove it first.
- **Keep queued work moving.** Up to three queued messages, including images, are saved by the local service and continue after a successful turn even when another chat is open. They survive an app restart. A stopped, failed or interrupted turn leaves its queue waiting for **Send now**. Changing the model, access or workspace pauses the affected message; remove and queue it again to confirm the new settings. Older local queues remain available for manual review.
- **Capture a window.** Turn on [Snapshots](../SNAPSHOTS_AND_COMPACTION.md) in **Settings → Devices & integrations → Snapshots** to attach a screenshot of the foreground window with its accessibility context.
- **Compact long chats** with `/compact`. A successful compaction leaves a receipt in the timeline with the provider-reported context counts.

### Compact on return

An API key bills every turn for the chat's whole history. While the provider's prompt cache is warm, that history is cheap to resend; once the cache expires, the next turn pays for all of it again. When you come back to a chat of 200K tokens or more on an Anthropic or OpenAI API key and its cache has expired, the composer's send button reads **Compact and send**. Point at it to see *Summarize ‹N› tokens of history, then send*.

- **Compact and send** summarizes the history first, then sends your message on the shorter chat. Enter follows the button, so it does the same. The composer and the timeline show *Compacting before sending…* while it runs, and your draft stays in the composer until the message is sent.
- Compacting is itself a model call, and the summary keeps less detail than the full chat; choose **Full history** when you need exact earlier details. Press **Full history** beside the button and it reads **Send**: this message goes with the whole history. The next message offers compaction again.
- If compacting fails, nothing is sent. Your draft stays, the composer shows why, and you can choose **Send without compacting** or **Try again**.
- The timeline marks it with one line, such as *Compacted on return · 252K → 18.3K tokens*, without a `/compact` message.
- It applies to Claude on an Anthropic API key, whose cache lasts 5 minutes or 1 hour (see [Prompt cache](getting-started.md#prompt-cache)); to Claude Code signed in for API billing, which uses Claude Code's 5-minute default unless Claude reports a longer one; and to Codex on an OpenAI API key. Inertia assumes about 30 minutes for OpenAI keys; OpenAI does not publish a fixed lifetime. If you often come back within the hour, a 1-hour Prompt cache avoids most of these offers.
- Chats on a subscription, custom backends, Kimi, watcher chats and Duo judge chats are never offered it, nor is a chat whose last turn stopped on a usage limit, a billing or sign-in problem, or a rate limit. Queued messages and limit-reset resumes are sent as they are. A message from Private Connect is sent as it is too, and one that arrives while the chat is compacting is refused until compacting ends.
- The usage meter shows *Prompt cache warm, expires in ‹N› min* or *Prompt cache expired ‹N› min ago* for these chats, with *about* before the time when Inertia assumes the lifetime.
- To stop the offer, set **Settings → Chats → Compact large API chats when you return** to **Never**.

## Follow the work

- The **Work** tab lists your chats. Running chats show the agent pixels and elapsed time, and a chat that needs your input or finishes gets a brief cue.
- The **Plan** and **Goal** panels show the plan and objective that the provider reports. Inertia doesn't invent a goal from the chat text.
- The **Browser** panel shows the local pages the agent works on. Its **Viewport** menu chooses **Fit**, which follows the panel's size, or a fixed **Desktop**, **Tablet** or **Mobile** size that is scaled down when the panel is smaller; the agent can change the same setting.
- **Daily work** in the sidebar summarizes processed tokens, agent runtime and conversations.
- Switching between chats in the same window preserves your reading position. **Jump to latest** resumes following new content. This navigation memory lasts while the window remains open.

If a Claude provider update requires a fresh native session, Inertia supplies a bounded excerpt of this chat’s recent visible messages as historical reference. The execution context records any truncation. Recovery is omitted if it cannot fit alongside your selected context within the turn limits. Hidden provider state, attachment contents and tool output are not recovered; compatible native sessions continue normally.

## Visual replies

An agent can answer with a page as well as text: a chart, a table, a diagram or an interface mockup. Ask for it in plain words, for example *“Chart the test durations by package and explain the slowest ones.”* The page appears in the chat above the agent’s written reply for that turn and follows your light or dark mode and color theme.

- Point at the page and choose **Open full size** (or Tab to the button) to view it in a larger dialog. Escape closes it.
- HTTPS links in the page open in your default browser when you click them.
- The page runs in a sandbox. It cannot fetch from the network, load remote content, or reach your files, the project or the rest of Inertia, so everything it shows must be inside the page itself. A script in the page can still open a WebRTC connection through a relay server over TCP.
- Private Connect clients, chats you share as context, and another model continuing the chat see only a one-line *[page: title]* note in its place, so the agent’s reply also says in one sentence what the page shows.

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

Turn on the mascot in **Settings → Notifications** for a movable companion that previews progress, questions, approvals and results in a small bubble. Click the bubble to open the chat; right-click to pause or hide it. **Animate mascot** in the same place pauses or resumes its animation. The bubble shows the chat that needs you most and lists up to five other active or unread chats; click one to open it. Hiding lasts until you choose **Unhide** in Settings, **Show mascot** in the Window menu or the macOS Dock menu, or restart Inertia.

## Notifications

Desktop notifications tell you when a chat finishes, fails or needs your approval or answer, without prompt or response text. In **Settings → Notifications**, **Only when Inertia is in the background** skips them while any Inertia window is focused; completion sounds are not affected.
