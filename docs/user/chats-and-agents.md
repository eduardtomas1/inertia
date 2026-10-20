# Chats and agents

## Give the agent context

- **Attach** images, documents and spreadsheets, and mention project files.
- **Reference a chat** by typing `@` and part of its title, or `@this` for this chat's earlier messages. The agent gets a size-limited copy taken when you pick the chat, refreshed if that chat was still working and finishes before you send. Select a reference in the composer or on a sent message to see exactly what the agent gets. Inertia asks before it shares a chat from another workspace.
- **Choose** the model, reasoning level and access mode for each chat. The composer border animates at the selected model’s highest supported reasoning level; reduced motion keeps it still.
- **Switch provider** in a chat that already has messages: choose a model from another provider and keep going in the same chat. The next message starts a new session on that provider with the chat's earlier visible messages and a list of the files its turns changed as context; tool output, file contents, and hidden provider state stay behind, and secrets are redacted only where they match known patterns. The timeline marks the switch with a **Context handoff** divider that names both providers and how many earlier messages were carried, or left behind when they did not fit. Start a goal only after that first message.
- **Invoke a skill** by typing `$` and part of its name. Use ↑/↓ to choose, Tab or Enter to insert, and Escape to dismiss. You can edit a skill token anywhere in your draft.
- **Follow up** while an agent is working: send a message right away or queue it for the next turn. The composer shows *Enter sends · Tab queues* while this is possible. If the turn ends or the agent refuses the message before it arrives, the message is queued for the next turn instead. Cursor, Kimi and Antigravity cannot take a message mid-turn: the composer shows *Enter stops and sends · Tab queues*, and **Stop and send** stops the agent and sends your message as the next turn. While another message is queued, send or remove it first.
- **Keep queued work moving.** Up to three queued messages, including images, are saved by the local service and continue after a successful turn even when another chat is open. They survive an app restart. A stopped, failed or interrupted turn leaves its queue waiting for **Send now**. Changing the model, access or workspace pauses the affected message; remove and queue it again to confirm the new settings. Older local queues remain available for manual review.
- **Capture a window.** Turn on [Snapshots](../SNAPSHOTS_AND_COMPACTION.md) in **Settings → Devices & integrations → Snapshots** to attach a screenshot of the foreground window with its accessibility context.
- **Compact long chats** with `/compact`. A successful compaction leaves a receipt in the timeline with the provider-reported context counts.

## Follow the work

- The **Work** tab lists your chats. Running chats show the agent pixels and elapsed time, and a chat that needs your input or finishes gets a brief cue.
- The **Plan** and **Goal** panels show the plan and objective that the provider reports. Inertia doesn't invent a goal from the chat text.
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
- **Move it to an initiative**, or remove it from one. See [Initiatives](#initiatives).

## Initiatives

An initiative groups chats that belong to one larger piece of work, from any project and from chats without a project. A chat is in at most one initiative, and moving it never changes its project, checkout, agent or session.

- **Create one** from the **Initiatives** page, with **New initiative…** in a chat's **Move to initiative** menu, in the new-chat initiative picker, or in the command palette. Name it and pick a colour.
- **Move chats in or out** with **Move to initiative** in a chat's actions, or **Move chat to initiative…** in the command palette for the chat you have open. Once you have an initiative, a new chat offers an initiative picker next to the project; **No initiative** is the default. A chat that an agent starts from another chat joins that chat's initiative while the initiative is active.
- **In Work**, each active initiative is a section at the top, above Recent, with its colour, name and the number of chats in it. It holds the initiative's chats that are in progress: a snoozed chat stays in **Snoozed** and a settled chat in **Done**, exactly as without an initiative. A count in the status colour shows chats waiting on you (approval, input, failed or limited, and not settled), and the working glyph shows that a member chat is running. Choose the header, or press Enter or Space on it, to fold or unfold it; Inertia remembers your choice. Chats outside an initiative stay in Recent, Yesterday and Earlier. The project filter applies inside each section, and a section with no matching chats is hidden.
- **Done** initiatives fold after Earlier and list all of their chats, snoozed and settled ones included. **Archived** initiatives have no section: their chats return to the usual sections and rejoin the initiative when you unarchive it.
- **The Initiatives page**, from the **Initiatives** row under Tasks, the arrow on a section header, or an initiative's name in the command palette, lists initiatives as Active, Done and Archived; with none yet, it explains initiatives and offers **New initiative**. Rename an initiative, change its colour, **Mark done**, **Reopen**, **Archive**, **Unarchive** or **Delete** it, write its **Brief** and **Notes**, and open any of its chats, grouped as Waiting on you, Working, Done and Idle. Deleting an initiative removes only the grouping and its brief and notes: its chats, archived ones included, keep their history and leave the initiative.
- **The brief** holds what every chat in the initiative should know: the objective, constraints and decisions, in Markdown, up to 8 KiB. Edit it on the Initiatives page and choose **Save brief** or press Ctrl+Enter (Cmd+Enter on macOS); **Discard**, or Escape after a confirmation, drops your changes. The page shows the brief's revision and when it last changed. If the brief changed elsewhere since you started, saving keeps your text and says so; **Reload** shows the latest brief.
- **Notes** are short facts worth keeping, each a title and up to 2 KiB of text, at most 64 per initiative. Add, edit and delete them on the Initiatives page; each shows who wrote it, **You** or **Agent**. Text-direction control characters and Unicode line or paragraph separators are refused; each title and text keeps its own direction, so right-to-left notes read correctly. Notes an agent proposes arrive under **Needs review**, where you **Accept**, **Edit and accept** or **Reject** each one; only accepted notes are shared. See [Agents and initiatives](#agents-and-initiatives).
- **What agents receive:** each chat in an initiative that is not archived (Active or Done) gets the brief and a list of its accepted notes (each note's title and first line) as reference material, on the first message of a new session and after you change them. Messages in between send nothing extra. After the chat's context is compacted, with `/compact` or by the provider on its own, the next message shares them again. The agent is told they are shared context from you, not new instructions or approval. Chats in an archived initiative, and chats outside any initiative, receive nothing.
- **Leaving an initiative:** when a chat leaves its initiative (you move it to another one or to none, or the initiative is archived or deleted), its next message tells the agent once that the earlier brief and notes no longer apply, and, after a move, shares the new initiative's brief and notes.
- **The receipt:** when a message carried the brief or notes, the chat shows it under your message, for example **Initiative context: Shared the initiative brief (revision 3) and 5 notes with the agent.**, or **Told the agent this chat left the initiative “Checkout”.** The receipt stays after a restart. A message that never reached the agent (it failed to start or you stopped it first) leaves no receipt, and the next message shares the material instead.
- **In the chat:** the line under the composer names the chat's initiative; choose it to open the Initiatives page.
- **Tools & defaults**, on the Initiatives page, are settings every chat in the initiative shares. A value you leave unset comes from the chat's project, then from Settings, and the row says so, for example **Inherited from project**, **Inherited from Settings** or, for settings Settings doesn't have, **Allowed by default**.
  - **Default model** and **Default access** apply to chats you start in the initiative. A default model that is no longer offered, or whose backend is turned off, is skipped. When you pick the initiative for a new chat, its model and access replace the inherited ones (a model or access you already chose stays), and the composer says **From initiative “Checkout”** while it uses the initiative's model.
  - **Default project** is chosen for you when you pick the initiative for a new chat.
  - **Access limit** caps every chat in the initiative, whether it is created in the initiative, moved into it, or already in it when you lower the limit, which lowers those chats and their queued messages at once. In the chat, including a chat in its own window, the access options above the limit are unavailable and say why, for example **“Checkout” limits chats to Auto-accept edits.** The limit holds even when the initiative is done or archived.
    - A reply that is already running keeps the access it started with until it ends. The chat's next message runs at or below the limit; to apply a lower limit right away, stop the running reply.
    - Antigravity can't pause for approval, so it can't run under a **Supervised** limit: the composer says **“Checkout” limits chats to Supervised. Antigravity cannot run supervised.** Choose another model for that chat.
    - A chat waiting to resume automatically after a usage limit checks its access again before it resumes. If you lowered the limit in the meantime, resume that chat yourself.
    - A chat an agent starts joins its initiative and keeps its limit. If the initiative has a limit but no longer takes chats (it is done or archived), the agent is told it cannot start one.
  - **Agent browser access**: **Block** stops the agent browser tools in every chat in the initiative. **Allow** cannot reopen them for a project that blocks them.
  - **Claude spend limit per turn**: when the initiative and the chat's project both set one, the lower applies.
  - **Skills folder**: turn it on and choose **Open folder** to add skills Claude chats in the initiative can use with `$`. Put each skill in its own folder with a `SKILL.md` (the folder Inertia opens is `<Inertia data folder>/initiatives/<initiative id>/skills/.claude/skills/`). Inertia manages the folder and refuses it if a link leads elsewhere. Turning it off, or deleting the initiative, keeps your files. Codex chats don't use the folder yet. Chats in an archived initiative don't use it either.

### Agents and initiatives

Besides the brief and notes it receives, an agent in a chat that belongs to an initiative (Active or Done, not Archived) has three initiative tools. Codex, Claude, Cursor, Kimi and OpenCode have them; Antigravity and custom backends do not, and still receive the brief and notes. A Codex chat you move into an initiative gets the tools when it next starts a new session; the others get them on their next message. The agent cannot pick an initiative: the tools always work on the chat's own initiative, and stop working as soon as you move the chat out or archive the initiative.

- **What agents can see:** the initiative's name and status, the brief's revision with its first lines, the accepted notes (title and first line) and the initiative's chats that are not archived, from every project in the initiative, with their title, project, status (waiting for approval or input, working, failed, limited by a usage limit, done or idle) and when they last changed: its own chat first, then up to 49 others, most recent first. That is by design, so agents can coordinate across the initiative; seeing a chat in the list does not let an agent read it. An agent can read a whole accepted note. It never sees proposals or rejected notes, folder paths, archived chats, or anything about chats outside the initiative.
- **Reading another chat asks you first.** When an agent wants to read another chat in the initiative, the chat shows the usual **The agent asked to read another chat** card, naming the initiative, with **Share chat**, **Decline** and **Preview**, and the extra confirmation when that chat works in another folder. Once you share it, the agent can read that chat's turns until its reply ends. A chat outside the initiative, or an archived one, is refused without asking you, and if either chat leaves the initiative while the card is open, nothing is read even if you share it.
- **Proposals:** an agent can propose a note for a lasting fact, decision or constraint the other chats need. The proposal appears under **Needs review**, marked **Agent**, with what it records (**Fact**, **Decision** or **Constraint**) when the agent said so and the chat it came from (choose it to open that chat), and the chat shows **Initiative note: Proposed an initiative note: …** with the reply. Nothing reaches other chats until you **Accept** it (or **Edit and accept**). Text in a proposal that looks like instructions is escaped before it is stored, and titles with invisible, text-direction or separator characters are refused. A title the initiative already has, or one you rejected, is not proposed again, even with invisible characters added. One reply can propose at most five notes, and at most 16 proposals, 5 from one chat, wait for your review at a time. Proposals don't count toward the 64 notes an initiative can hold until you accept them; with 64 accepted notes, delete one before accepting another.
- **Rejected notes** stay in a folded **Rejected** list under the notes so the same title is not proposed again. **Delete** one to allow it again.

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
