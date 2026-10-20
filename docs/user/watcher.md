# Watcher

A watcher is a read-only second agent that sits beside a chat and follows its work as it happens. It reviews what the main agent does, keeps its findings in a side dock, and sends nothing to the main chat until you choose **Send**, unless you turn on [automatic sending](#send-findings-automatically).

## Add a watcher

1. Open the chat's actions and choose **Add a watcher…**. The same item is in the chat header and on the chat's row in the **Work** tab. You can also search for **Add a watcher** with ⌘K (Ctrl+K elsewhere).
2. Choose a [preset](#presets): **Reviewer**, **Scope guard** or **Explainer**.
3. Choose a model route on an [agent that can be a watcher](#which-agents-can-be-watchers). A route that isn't ready can't be chosen, and the dialog says why.
4. Optionally add your own instructions, up to 2,000 characters.
5. Under **What the watcher sees**, choose what each check includes: the brief, activities, changed files and partial replies. The main agent's plan is shared with **Activities**.
6. Optionally turn on **Send findings to the main chat automatically**. See [Send findings automatically](#send-findings-automatically).
7. Turn on **Review the last turn now** to have the watcher check the chat's most recent turn right away. It is available while that turn runs and after it has completed.
8. If Private Connect is set up, choose under **On paired devices** whether the watcher follows the chat's visibility or stays hidden. See [Private Connect](#private-connect).
9. Optionally open **Budgets** and change them. See [Budgets and cost](#budgets-and-cost).
10. Choose **Attach watcher**.

The dialog says that the watcher is read-only.

The watcher is its own chat, named **Watcher · *preset* · *chat title***. It works in the same checkout and branch as the chat it watches, and Inertia doesn't rename it. In the **Work** tab it is nested under its chat.

A chat has at most one watcher, and Inertia keeps up to eight active watchers at a time. A watcher can't watch another watcher, an archived chat or a chat without a project.

## The watcher dock

The watcher opens in a dock beside the chat. When the dock is collapsed, a slim handle with the watcher's icon stays at the chat's edge; choose it (**Open watcher**) to open the dock again. The handle and the watcher's row in the **Work** tab show how many findings are new, such as **2 new**, when findings arrived while the dock wasn't in view. **Open watcher** in the chat's actions or in ⌘K (Ctrl+K elsewhere) also opens the dock. The dock appears only in the main window; a chat open in its own window has no dock.

The bar at the top of the dock has two lines: the title of the chat it watches, and one line with the watcher's agent, its preset and what it is doing, for example **Codex · Reviewer · Watching**. While a check runs, that line says what the watcher is doing, such as reading a file, and how long the check has run. Between checks it reads **Watching**, or **Sends findings automatically** with automatic sending on, and while the watcher is paused it reads **Paused**.

Beside the title, **Check now** runs a check without waiting. While the watcher is paused, the same button reads **Resume**.

The **More watcher actions** menu holds:

- **Pause**, which stops new checks.
- **Review the last turn**, which has the watcher review the chat's latest turn again from its start, even while that turn is still running. It is unavailable while a check runs or the watcher is paused.
- **Open watcher chat**, which opens the watcher's own chat in [split view](working-side-by-side.md). There you can see each check as a **Check *N* · *K* events** row, open **What the watcher was shown**, and ask the watcher a question directly. Its composer shows **Read-only watcher · Plan · Supervised**.
- **Send findings automatically**. See [Send findings automatically](#send-findings-automatically).
- **Hide from paired devices**, when Private Connect is set up. See [Private Connect](#private-connect).
- **Collapse**, which hides the dock. Inertia remembers this for each chat.
- **Stop watching…**, which detaches the watcher. See [Stop, detach and delete](#stop-detach-and-delete).

Below them the menu lists the watcher's numbers, for example **28 of 30 checks left this turn**, **3 events seen**, **0 waiting** and **Last check 9:04 PM**. It adds **Main chat quiet since 9:04 PM** when the main chat has produced no output for 10 minutes, and **Used 48.2K tokens** once the watcher's agent has reported its token use.

Escape inside the dock collapses it and returns focus to the handle. Drag the dock's edge to resize it, or focus the edge and use the arrow keys. When the dock would leave the chat less than 360 pixels, it opens as a sheet over the chat instead. A sheet starts collapsed, stops above the composer, and collapses when you press outside it.

### Checks and receipts

The watcher doesn't read every word as it streams. Inertia wakes it when a turn of the main chat starts or ends, a file change finishes, the plan changes or an error occurs. Finished tool calls and commands are gathered until six have settled or the oldest has waited three cooldowns. Events that arrive close together are gathered into one check, and a new check waits for the cooldown after the previous one. Late in a long turn the wait grows so the remaining checks last to the end: at least the time the turn has run divided by the checks left, and at most ten cooldowns. **Check now** and the final check of a turn don't wait for the cooldown. **Check now** runs even when nothing is new, and the watcher is then told that nothing new happened since its last check. Events that arrive while the watcher is checking wait for the next check. While the watcher answers a message you sent in its own chat, checks wait until it has finished.

When a turn in the main chat ends, the watcher makes a final check. With **Changed files** shared, the final check includes the turn's unified diff, shortened to fit the digest size; when the diff isn't available, it lists the changed paths instead. If Inertia couldn't capture the turn's changes at all, the final check says so. If the next turn has already started, for example from a queued message, the final check still reviews the turn that ended, and the next turn is reviewed on its own.

Each check reminds the watcher of up to five of its findings from earlier checks of the same turn, and whether each was sent or dismissed, so it doesn't report them again. When a later check says that an earlier finding is fixed, that card shows **Resolved in check *N*** and moves below the open findings.

Each card and each row in the watcher chat carries the watcher's lifetime check number, **Check *N***. That number counts every check, including **Check now** and reviews of the last turn, so it can be higher than the checks used this turn.

When the watcher has nothing to report, it answers with exactly `SILENT`. The dock groups these quiet checks into one receipt, such as **Checked once · 9:04 PM · nothing to report** or **Checked 3 times · 9:04–9:12 PM · nothing to report**. When the watcher ran read-only commands, the receipt adds them, for example **ran 2 read-only commands · 1 declined**. Open a receipt to see each check: why it ran, how many events it covered, the commands it ran, how much it sent, such as **24 KiB sent**, and what was shortened or left out. A check that fails or is stopped shows its own line saying why, such as **The check failed.**

Watcher checks don't send desktop notifications, play completion sounds or mark the watcher unread, and the desktop mascot ignores quiet checks. A new finding is shown only by the **new** count on the handle and on the watcher's row in the **Work** tab.

## Presets

Each preset tells the watcher what to look for. Your own instructions are added to it.

- **Reviewer** looks for mistakes and risks in the work as it happens.
- **Scope guard** checks that the work stays within what the chat asked for.
- **Explainer** describes what the main agent is doing and why.

Every preset tells the watcher to answer `SILENT` when it has nothing to add.

## Send a note to the main chat

A finding appears in the dock as a card. Its first line is the card's title, the rest follows below, and **Check *N* · *time*** says which check found it. The card offers **Send** and **Dismiss**.

- **Send** queues the note for the main chat's next turn. If the main chat is idle, the note starts its next turn right away.
- When the main chat is running on an agent that can take a message mid-turn (Claude Code, Codex or OpenCode), the arrow next to **Send** opens **Queue for next turn** and **Steer now**. **Steer now** delivers the note into the running turn. If the turn ends or the agent refuses the note before it arrives, the note is queued instead, or starts the main chat's next turn when the chat is idle and nothing else waits, and the card says so.
- **Dismiss** removes the card without sending anything.

After **Send**, the card shows its status, such as **Queued · sends after the current turn** or **Sent 9:12 PM · after the turn ended**. When **Steer now** fell back, the status says why, for example **Queued · the turn ended before the note arrived** or **Sent 9:12 PM · the turn ended before the note arrived**. If Inertia can't confirm that a steered note arrived, the card says **Not sent** with the reason. A card can be sent only once.

If a queued note leaves the main chat's queue without being sent, because you removed it there or a change to the chat's model, access or workspace blocked it, the card says **Not sent** with the reason, and you can send or dismiss it again. Sending it again or dismissing it withdraws a blocked copy from the queue. A blocked note never holds back the messages queued after it.

Your own queued messages always go before watcher notes. The main chat can hold three queued messages; when it is full, the card says **Not sent** with the reason, and you can send the note once the queue has room. In the main chat's queue, notes are labelled **From watcher**.

In the main chat, a delivered note follows a **Note from watcher** divider that names the preset and the watcher's agent, and a steered note carries the same tag. The main agent is told that the note comes from the watcher and, for a note sent automatically, that you didn't choose to send it. The note's **From watcher** label says the same when you point at it. A note is never presented as your own words.

### Send findings automatically

With **Send findings automatically** on, each finding is sent as soon as its check ends, the same way as **Send** but marked as sent automatically: the note is queued for the main chat's next turn, after your own queued messages, or starts that turn when the main chat is idle. It never steers a running turn. Turn it on when you attach the watcher or later in the dock's menu; it is off by default.

A finding from a turn that a watcher note started is never sent automatically, so the watcher and the main agent can't keep each other going. Its card waits for you to choose **Send** or **Dismiss**. If the main chat's queue is full, the card says **Not sent**, and you can send it yourself once the queue has room.

## Read-only guarantees

A watcher can read the chat it watches and the project's files. It can't change them. Inertia enforces this in several independent layers:

- **Locked mode and access.** The watcher always runs in Plan mode with Supervised access, which can't be changed. You can switch its model only to another agent that can be a watcher.
- **Approvals are declined.** Every approval request is declined automatically, and the watcher chat records what was declined. The watcher never shows you an approval card. A second declined request in one check stops that check, and a question from the watcher stops the check too.
- **Edits are attempts, never changes.** If the watcher asks to edit a file, the request is declined, Inertia records it as an attempt, and the check continues. If the watcher actually starts to edit, create or delete a file, or asks to edit a second time in the same check, Inertia stops that check. A second attempt during the same turn of the main chat pauses the watcher.
- **Commands stay read-only.** On Claude Code and OpenCode, the watcher runs commands from Inertia's read-only allowlist without asking: read-only Git commands such as `git diff`, `git log`, `git show`, `git status` and `git blame`, and `rg`, `grep`, `cat`, `head`, `tail`, `ls`, `find`, `wc`, `diff`, `stat`, `tree`, `jq` and a few similar tools. Inertia declines, without an approval card, any other command that reaches it and any form of these that could write, follow a file, run another program or read outside the workspace, including redirection, chaining and command substitution; a pipe between allowed commands is fine. Claude Code also runs the commands that its own plan mode treats as read-only, and its own read and search tools, without asking Inertia. See [Commands](#commands). Codex runs its own known-safe read-only commands inside its read-only sandbox, without network access; any other command needs approval and is declined. On OpenCode the watcher can also read, search and list files; every other OpenCode tool, including edits, is turned off. Receipts show how many commands the watcher ran and how many were declined.
- **Changed files pause the watcher.** Before and after each check, Inertia takes a fingerprint of the checkout's Git state. If files changed that no running agent accounts for, and during the check the watcher started an edit or ran a command outside the read-only allowlist, the watcher pauses and a banner lists the changed paths. **Resume…** asks you to confirm: if you edited those files yourself, resume. If the watcher only read, or another agent ran a command, or a terminal, a check or a Git operation was busy on the checkout at the same time, the check counts as inconclusive: the watcher keeps its finding and keeps going, and the card or receipt names the files that changed during the check. Outside a Git repository the fingerprint is unavailable and the other layers still apply.
- **The watcher's instructions** tell it that it is read-only and which commands it may run.

Watcher turns create no checkpoints and record no changed files, so nothing in the watcher chat can revert the main chat's work. Taking the fingerprint doesn't write to your repository.

### Commands

A content search across the workspace stays within the files Git and ripgrep normally search: recursive `grep` and `diff`, `rg --hidden`, `rg -u`, the `--no-ignore` options, and `git grep --untracked` or `--no-index` are declined.

Commands that read a `.env`, `*.env` or `*.env.*` file are declined in any letter case, including a pattern file given with `-f`. A search pattern that only mentions such a name, such as `rg 'process.env.API_URL' src`, is allowed.

Inertia checks the command's text, so some limits remain. A command can still read any other workspace file it names, including one that Git ignores. A symbolic link inside the workspace that points outside it isn't noticed, and programs still follow their own configuration, such as Git's external diff or textconv settings, `RIPGREP_CONFIG_PATH`, jq's `~/.jq`, or shell aliases on OpenCode. Claude Code's own read-only commands and read tools, and Codex's sandboxed commands, follow their agent's rules instead of this allowlist.

On Claude Code and OpenCode, watcher commands run with Git's optional locks off, so `git status` leaves `.git/index` alone. `git diff` can still refresh the index briefly after you change files, so a `git add` or `git commit` running at the same moment in the watched chat may report that `index.lock` exists. Running it again works.

## Budgets and cost

Each check is a turn on the watcher's own account and uses that account's quota, not the main chat's. The budgets limit how much it can use:

| Budget | Default | Range |
|---|---|---|
| Checks per turn | 30 | 2 to 100 |
| Cooldown between checks | 45 s | 15 to 600 s |
| Digest size | 24 KiB | 4 to 48 KiB |
| Context reads per check | 4 | 0 to 8 |

- **Checks per turn** counts the checks the watcher starts on its own during one turn of the main chat, including the final check. **Check now** and reviews of the last turn don't use this allowance. When the checks are used up, the watcher pauses and says why, and it still makes its final check when the turn ends. The next turn of the main chat starts with a full allowance and the watcher resumes by itself. **Resume** also tops the checks back up to the full allowance, whatever the reason for the pause.
- **Digest size** caps what one check sends: newer activity is kept in full, older activity is shortened and the oldest is left out, and the check says what was left out.
- **Context reads per check** limits how often the watcher may read more of the watched chat on its own during one check. Those reads follow **What the watcher sees**: with a choice turned off, the watcher can't read that part of the chat this way either.

The dock's menu shows the watcher chat's token use so far, such as **Used 48.2K tokens**, once its agent has reported it. Inertia keeps the newest 500 checks of each watcher; older checks and their transcripts are removed, and their token use still counts.

If the watcher reaches its own account's usage limit, it pauses and says so, and it can resume once its route is ready again. A watcher paused because its route is unavailable likewise resumes only when the route is ready. Neither stops or slows the main chat.

## Which agents can be watchers

- **Claude Code** (Agent SDK)
- **Codex** (app-server)
- **OpenCode**

Cursor, Kimi Code and Antigravity can't be watchers yet. A custom backend on one of these agents can watch, but it can only review what each check sends: it can't read more of the watched chat, and the dock says so.

The watched chat can use any agent, and it can [switch provider](chats-and-agents.md#give-the-agent-context) mid-chat. The watcher keeps following.

## Private Connect

On a device paired with [Private Connect](../PRIVATE_CONNECT.md), a watcher is visible when the chat it watches is visible, unless you hide it: choose **Hidden** under **On paired devices** when you attach it, or **Hide from paired devices** in the dock's menu. The device shows the watcher as an ordinary chat titled **Watcher · …**. A Collaborate device can prompt the watcher, which stays read-only. **Send** and **Dismiss** are available only on the desktop.

## Stop, detach and delete

- **Pause** stops new checks and keeps the watcher attached. **Resume** continues.
- **Stop watching…** asks you to confirm, stops any running check and detaches the watcher. It becomes an ordinary chat in the **Work** tab, and its mode is no longer locked.
- **Archiving the watched chat** pauses the watcher and stops a running check, and **Resume** is refused until you unarchive the chat.
- **Archiving the watcher chat** pauses the watcher and stops a running check too, and **Resume** is refused until you unarchive the watcher chat.
- **Deleting the watched chat** detaches its watcher.
- **Deleting the watcher** removes it. The shared checkout and worktree stay.
- **Removing the project** removes the watcher with the project's other chats.

While the watcher has a turn running, a check or an answer to a message you sent it, the watched chat can't be deleted. Wait for that turn to finish, or choose **Stop watching…**, then delete the chat.

After Inertia restarts, watchers continue where they were. If a turn of the main chat ended while Inertia was closed, the watcher makes its final check once.

## Troubleshooting

### Add a watcher is unavailable or refused

- The chat may already have a watcher, be archived, be a watcher itself, or have no project.
- Inertia already has eight active watchers. Stop one first.

### The dialog offers no model

Only ready routes on Claude Code, Codex and OpenCode can be watchers. Open **Settings → Agents** and check that one of them is installed and signed in.

### The watcher never reports anything

- Quiet receipts mean the watcher checked and found nothing to report.
- Checks wait for settled events and the cooldown, and come further apart late in a long turn, so streaming text or a run of quick reads doesn't start one. Choose **Check now** to check right away.
- Check whether the watcher is paused; the dock shows why.

### The watcher paused

The dock says why:

- you paused it;
- it used its checks for this turn: it resumes by itself when the next turn starts, or choose **Resume**;
- it reached its account's usage limit: it can resume once its route is ready;
- its route stayed unavailable through three retries, or three checks in a row could not start: check **Settings → Agents**; it can resume once the route is ready;
- it tried to edit a file twice during one turn;
- files changed that no running agent accounts for (see below);
- the watched chat was archived: unarchive it, then resume;
- the watcher chat itself was archived: unarchive it, then resume.

### A banner lists changed files

Files in the checkout changed during a check in which the watcher started an edit or ran a command outside the read-only allowlist, and no running agent accounts for them. Look at the listed paths. If you edited them yourself, choose **Resume…** and confirm.

### Send doesn't queue the note

The main chat already has three queued messages. Send or remove one, then send the note again.

### Steer now is missing

**Steer now** appears only while the main chat is running on Claude Code, Codex or OpenCode. Otherwise the note is queued for the next turn.

### A finding wasn't sent automatically

It came from a turn that a watcher note started, or the main chat's queue was full. Choose **Send** on its card.

### A chat can't be deleted

Its watcher has a turn running: a check, or an answer to a message you sent it. Wait for that turn to finish, or choose **Stop watching…** in the dock's menu.

### The watcher isn't on my other device

It is hidden from paired devices, or the chat it watches isn't visible on that device.

### The dock says the watcher sees only what each check sends

The watcher runs on a custom backend. It reviews only what each check sends.
