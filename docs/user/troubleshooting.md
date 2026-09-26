# Troubleshooting

Find what you're seeing below.

## An agent isn't listed, won't start or stops responding

- Open **Settings → Providers** and refresh the provider. The page shows whether it's installed and signed in.
- Each provider keeps its own sign-in. If it reports that you need to sign in, sign in with the provider's own tools, then refresh.
- The welcome guide's **Connect an agent** step shows the same readiness at a glance. Replay it from **Settings → Report an issue → Show welcome guide**.

## A chat is waiting and nothing happens

In **Supervised** mode the agent pauses for your approval. Open the chat and answer the request. The **Work** tab marks chats that need input.

OpenCode keeps admitted approval and question requests open while you decide. Its inactivity limit resumes after you answer; the overall run limit still applies.

## A provider feature is unavailable

Open **Settings → Providers → Feature availability** to see which features are ready, need setup, or are checked when a chat starts. The installation status above it shows the version Inertia verified. Some features depend on the selected model; Cursor only offers reasoning choices observed for that model.

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

A countdown reaching zero doesn't refill the bar. Choose **Refresh limits** to get the provider's answer. See [Provider usage limits](../USAGE_LIMITS.md).

## Inertia says it restored a backup or started with empty data

The recovery notice explains what happened and offers recovery actions, including copying a report. See [Database recovery](../DATABASE_RECOVERY.md).

## Check local storage and backups

Open **Settings → Report an issue → View storage & backups** (also under **Archive & data**). The page measures the database, browser cache and temporary attachments while open, and shows backup retention and the last validated backup. Backup files and saved attachment files are excluded from those measured totals. Clearing browser cache keeps chats and backups; archiving a chat keeps its data.

## Startup is blocked on Windows after an update

Follow the [profile recovery steps](../WINDOWS_STARTUP_RECOVERY.md).

## Report a problem

- **Settings → Report an issue** guides you through a private report. You review the exact text before anything is submitted to GitHub. See [Guided issue reporting](../ISSUE_REPORTING.md).
- **Settings → Diagnostics → Copy support summary** copies a bounded summary you can attach to a [bug report](https://github.com/eduardtomas1/inertia/issues/new?template=bug_report.yml).

Don't share raw logs, databases or credentials.
