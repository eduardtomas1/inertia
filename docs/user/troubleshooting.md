# Troubleshooting

Find what you're seeing below.

## An agent isn't listed, won't start or stops responding

- Open **Settings → Agents** and refresh the provider. The page shows whether it's installed and signed in.
- Each provider keeps its own sign-in. If it reports that you need to sign in, sign in with the provider's own tools, then refresh.
- The welcome guide's **Connect an agent** step shows the same readiness at a glance. Replay it from **Settings → Help → Welcome guide → Show welcome guide**.

## A chat is waiting and nothing happens

In **Supervised** mode the agent pauses for your approval. Open the chat and answer the request. The **Work** tab marks chats that need input.

OpenCode keeps admitted approval and question requests open while you decide. Its inactivity limit resumes after you answer; the overall run limit still applies.

## A provider feature is unavailable

Open **Settings → Agents**, choose the provider and open **Details** to see which features are ready, need setup, or are checked when a chat starts. The installation status above it shows the version Inertia verified. Some features depend on the selected model; Cursor only offers reasoning choices observed for that model.

## I can't open another chat window

Up to eight chats can have their own windows at once. Close one, or bring a chat back into the main window, then try again.

## A chat can't be added to split view

A chat that already has its own window can't join split view. Choose the chat in the sidebar to focus its window, or close that window first.

## Find earlier messages in a long chat

Chats open with recent history. Choose **Load earlier messages** at the top of the transcript to read more. Message search and turn links load their destination when it is outside the current page, including in split and detached windows. Loading a page preserves your reading position.

If an individual turn is too large to display, Inertia reports that without disconnecting your other chats. Its saved history remains in the database and can be included in a data export from Settings.

## Pull, push or commit fails

Inertia explains Git failures, such as authentication, connectivity, a rejected non-fast-forward push, an index lock, a branch checked out elsewhere or a missing author identity, without exposing credentials. Pull only fast-forwards, and Inertia never force-pushes. See [Git workflows](../GIT_WORKFLOWS.md).

## Limits look stale, or a countdown reached zero

A countdown reaching zero doesn't refill the bar. The window shows **Reset due** until the provider reports new quota, and Codex and Claude are checked again a few seconds after the reset. When a provider is limiting quota checks, Limits says how long the provider asked Inertia to wait. It keeps the last reported numbers, marked stale, when it can confirm the same account; a Cursor login read from the macOS Keychain or a login without a stable account shows the message without numbers. **Refresh limits** asks right away. See [Provider usage limits](../USAGE_LIMITS.md).

## Inertia says it restored a backup or started with empty data

The recovery notice explains what happened and offers recovery actions, including copying a report. See [Database recovery](../DATABASE_RECOVERY.md).

## Check local storage and backups

Open **Settings → Data → Storage**. **Local storage** and **Full local database backup** measure the database, browser cache and temporary attachments while open, and show backup retention and the last validated backup. Backup files and saved attachment files are excluded from those measured totals. Clearing browser cache keeps chats and backups; archiving a chat keeps its data.

## Startup is blocked on Windows after an update

Follow the [profile recovery steps](../WINDOWS_STARTUP_RECOVERY.md).

## Report a problem

- **Settings → Help → Report an issue** builds the exact issue for you to review and edit. Nothing is submitted until you choose **Create on GitHub**. See [Issue reporting](../ISSUE_REPORTING.md).
- **Settings → Help → Diagnostics → Copy support summary** copies a bounded summary you can attach to a [bug report](https://github.com/eduardtomas1/inertia/issues/new?template=bug_report.yml).

Don't share raw logs, databases or credentials.
