# Watcher

A watcher is a read-only second agent that sits beside a chat and follows its work as it happens. It reviews what the main agent does, keeps its findings in a side dock, and sends nothing to the main chat until you choose **Send**.

## Add a watcher

1. Open the chat's actions and choose **Add a watcher…**. The same item is in the chat header and on the chat's row in the **Work** tab. You can also search for **Add a watcher** with ⌘K (Ctrl+K elsewhere).
2. Choose a model route. Only ready routes on [agents that can be watchers](#which-agents-can-be-watchers) are offered.
3. Choose a [preset](#presets): **Reviewer**, **Scope guard** or **Explainer**.
4. Optionally add your own instructions, up to 2,000 characters.
5. Under **What the watcher sees**, choose what each check includes: the brief, activities, changed files and partial replies. The main agent's plan is shared with **Activities**.
6. Optionally open the budgets and change them. See [Budgets and cost](#budgets-and-cost).
7. If Private Connect is set up, choose whether the watcher follows the chat's visibility or stays hidden. See [Private Connect](#private-connect).
8. Turn on **Review the last turn now** to have the watcher check the chat's most recent turn right away.
9. Attach the watcher.

The dialog states that the watcher is read-only and never sends anything without you. **What is shared with the watcher?** shows exactly what it receives.

The watcher is its own chat, named **Watcher · *preset* · *chat title***. It works in the same checkout and branch as the chat it watches, and Inertia doesn't rename it. In the **Work** tab it is nested under its chat.

A chat has at most one watcher, and Inertia keeps up to eight active watchers at a time. A watcher can't watch another watcher, an archived chat or a chat without a project.

## The watcher dock

The watcher opens in a dock beside the chat. **Watched by *model* · *preset*** near the composer shows that the chat has a watcher; choose it to open the dock. It shows a badge when there are new findings.

The bar at the top of the dock shows:

- the agent's icon and model, and **Watching *chat title***;
- what the watcher is doing now, such as reading a file, and how long the current check has run;
- how many checks this turn has used, and how many events the watcher has seen and how many are still waiting for the next check;
- **Main chat quiet since…** when the main chat has produced no output for 10 minutes.

Its buttons:

- **Pause** and **Resume**.
- **Check now** runs a check without waiting.
- **Stop watching** detaches the watcher. See [Stop, detach and delete](#stop-detach-and-delete).
- **Open watcher chat** opens the watcher's own chat in [split view](working-side-by-side.md). There you can see each check as a **Check *N* · *K* events** row, open **What the watcher was shown**, and ask the watcher a question directly. Its composer shows **Read-only watcher · Plan · Supervised**.
- **Collapse** hides the dock. Inertia remembers this for each chat. Escape inside the dock also collapses it and returns focus to the chip.

Drag the dock's edge to resize it, or focus the edge and use the arrow keys. In a narrow window the dock opens as a sheet over the chat.

### Checks and receipts

The watcher doesn't read every word as it streams. Inertia wakes it when something in the main chat settles: a tool call, command or file change finishes, the plan changes, an error occurs, or a turn starts or ends. Events that arrive close together are gathered into one check, and a new check waits for the cooldown after the previous one. Events that arrive while the watcher is checking wait for the next check. If you are typing to the watcher in its own chat, your turn goes first.

When a turn in the main chat ends, the watcher makes a final check that includes the files the turn changed.

When the watcher has nothing to report, it answers with exactly `SILENT`. The dock groups these quiet checks into one receipt, such as **Checked 3 times since 10:42 · nothing to report**. Open a receipt to see each check. A receipt also says when a check ran read-only commands.

Watcher checks don't send desktop notifications, play completion sounds or mark the watcher unread, and the desktop mascot ignores quiet checks. A finding only adds the badge to the chip.

## Presets

Each preset tells the watcher what to look for. Your own instructions are added to it.

- **Reviewer** looks for mistakes and risks in the work as it happens.
- **Scope guard** checks that the work stays within what the chat asked for.
- **Explainer** describes what the main agent is doing and why.

Every preset tells the watcher to answer `SILENT` when it has nothing to add.

## Send a note to the main chat

A finding appears in the dock as a card with **Send** and **Dismiss**.

- **Send** queues the note for the main chat's next turn. If the main chat is idle, the note starts its next turn right away.
- When the main chat is running on an agent that can take a message mid-turn (Claude Code, Codex or OpenCode), the menu next to **Send** also offers **Steer now**, which delivers the note into the running turn. If the turn ends or the agent refuses the note before it arrives, it is queued instead and the card says so.
- **Dismiss** removes the card without sending anything.

After **Send**, the card shows its status, such as **Queued · sends after the current turn**. A card can be sent only once.

Your own queued messages always go before watcher notes. The main chat can hold three queued messages; when it is full, the card says so, and you can send the note once the queue has room. In the main chat's queue, notes are labelled **From watcher**.

In the main chat, a delivered note follows a **Note from watcher** divider that names the preset and model, and a steered note carries the same tag. The main agent is told that the note comes from the watcher. It is never presented as your own words.

## Read-only guarantees

A watcher can read the chat it watches and the project's files. It can't change them. Inertia enforces this in several independent layers:

- **Locked mode and access.** The watcher always runs in Plan mode with Supervised access, which can't be changed. You can switch its model only to another agent that can be a watcher.
- **Approvals are declined.** Every approval request is declined automatically, and the watcher chat records what was declined. The watcher never shows you an approval card. A second declined request in one check stops that check, and a question from the watcher stops the check too.
- **Edits are attempts, never changes.** If the watcher asks to edit a file, the request is declined, Inertia records it as an attempt, and the check continues. If the watcher actually starts to edit, create or delete a file, or asks to edit a second time in the same check, Inertia stops that check. A second attempt during the same turn of the main chat pauses the watcher.
- **Commands stay read-only.** Codex may run known-safe read-only commands inside its own read-only sandbox, without network access; any other command needs approval and is declined. On Claude Code and OpenCode every command needs approval, so it is declined. Receipts show how many commands the watcher ran.
- **Changed files pause the watcher.** Before and after each check, Inertia takes a fingerprint of the checkout's Git state. If files changed that no running agent accounts for, the watcher pauses and a banner lists the changed paths. **Resume** asks you to confirm: if you edited those files yourself, resume. When another agent, a terminal or a Git operation was busy at the same time, the receipt notes that the result was inconclusive and the watcher keeps going. Outside a Git repository the fingerprint is unavailable and the other layers still apply.
- **The watcher's instructions** tell it that it is read-only.

Watcher turns create no checkpoints and record no changed files, so nothing in the watcher chat can revert the main chat's work. Taking the fingerprint doesn't write to your repository.

## Budgets and cost

Each check is a turn on the watcher's own account and uses that account's quota, not the main chat's. The budgets limit how much it can use:

| Budget | Default | Range |
|---|---|---|
| Checks per turn | 12 | 2 to 40 |
| Cooldown between checks | 45 s | 15 to 600 s |
| Digest size | 24 KiB | 4 to 48 KiB |
| Context reads per check | 4 | 0 to 8 |

- **Checks per turn** counts checks during one turn of the main chat, including the final check. When the checks are used up, the watcher pauses and says why, and it still makes its final check when the turn ends. **Resume** tops the checks back up to the full allowance, whatever the reason for the pause.
- **Digest size** caps what one check sends: newer activity is kept in full, older activity is shortened and the oldest is left out, and the check says what was left out.
- **Context reads per check** limits how often the watcher may read more of the watched chat on its own during one check.

If the watcher reaches its own account's usage limit, it pauses with the same explanation as **Limits**, and it can resume once its route is ready again. A watcher paused because its route is unavailable likewise resumes only when the route is ready. Neither stops or slows the main chat.

## Which agents can be watchers

- **Claude Code** (Agent SDK)
- **Codex** (app-server)
- **OpenCode**

Cursor, Kimi Code and Antigravity can't be watchers yet. A custom backend on one of these agents can watch, but it can only review what each check sends: it can't read more of the watched chat, and the dock says so.

The watched chat can use any agent, and it can [switch provider](chats-and-agents.md#give-the-agent-context) mid-chat. The watcher keeps following.

## Private Connect

On a device paired with [Private Connect](../PRIVATE_CONNECT.md), a watcher is visible when the chat it watches is visible, unless you set it to **Hidden**. Change this in the dock's menu. The device shows the watcher as an ordinary chat titled **Watcher · …**, and in Settings it is listed under its chat as **Follows *chat title***. A Collaborate device can prompt the watcher, which stays read-only. Sending a note to the main chat is available only on the desktop.

## Stop, detach and delete

- **Pause** stops new checks and keeps the watcher attached. **Resume** continues.
- **Stop watching** asks you to confirm, stops any running check and detaches the watcher. It becomes an ordinary chat in the **Work** tab, and its mode is no longer locked.
- **Archiving the watched chat** pauses the watcher, and **Resume** is refused until you unarchive the chat. Unarchiving the chat offers to resume it.
- **Deleting the watched chat** detaches its watcher.
- **Deleting the watcher** removes it. The shared checkout and worktree stay.

While a check is running, the watched chat can't be deleted. Wait for the check to finish, or choose **Stop watching**, then delete the chat.

After Inertia restarts, watchers continue where they were. If a turn of the main chat ended while Inertia was closed, the watcher makes its final check once.

## Troubleshooting

### Add a watcher is unavailable or refused

- The chat may already have a watcher, be archived, be a watcher itself, or have no project.
- Inertia already has eight active watchers. Stop one first.

### The dialog offers no model

Only ready routes on Claude Code, Codex and OpenCode can be watchers. Open **Settings → Agents** and check that one of them is installed and signed in.

### The watcher never reports anything

- Quiet receipts mean the watcher checked and found nothing to report.
- Checks wait for settled events and the cooldown, so a long stretch of streaming text alone doesn't start one. Choose **Check now** to check right away.
- Check whether the watcher is paused; the dock shows why.

### The watcher paused

The dock says why:

- you paused it;
- it used its checks for this turn: choose **Resume**;
- it reached its account's usage limit: it can resume once its route is ready;
- its route stayed unavailable through three retries: check **Settings → Agents**; it can resume once the route is ready;
- it tried to edit a file twice during one turn;
- files changed that no running agent accounts for (see below);
- the watched chat was archived: unarchive it, then resume.

### A banner lists changed files

Files in the checkout changed during a check, and no running agent accounts for them. Look at the listed paths. If you edited them yourself, choose **Resume** and confirm.

### Send doesn't queue the note

The main chat already has three queued messages. Send or remove one, then send the note again.

### Steer now is missing

**Steer now** appears only while the main chat is running on Claude Code, Codex or OpenCode. Otherwise the note is queued for the next turn.

### A chat can't be deleted

Its watcher is running a check. Wait for the check to finish, or choose **Stop watching** in the dock.

### The watcher isn't on my other device

It is set to **Hidden**, or the chat it watches isn't visible on that device.

### The dock says the watcher can't read the watched chat

The watcher runs on a custom backend. It reviews only what each check sends.
