# Troubleshooting

Find what you're seeing below.

## An agent isn't listed, won't start or stops responding

- Open **Settings → Providers** and refresh the provider. The page shows whether it's installed and signed in.
- Each provider keeps its own sign-in. If it reports that you need to sign in, sign in with the provider's own tools, then refresh.
- The welcome guide's **Connect an agent** step shows the same readiness at a glance. Replay it from **Settings → Report an issue → Show welcome guide**.

## A chat is waiting and nothing happens

In **Supervised** mode the agent pauses for your approval. Open the chat and answer the request. The **Work** tab marks chats that need input.

## I can't open another chat window

Up to eight chats can have their own windows at once. Close one, or bring a chat back into the main window, then try again.

## A chat can't be added to split view

A chat that already has its own window can't join split view. Choose the chat in the sidebar to focus its window, or close that window first.

## Pull, push or commit fails

Inertia explains Git failures, such as authentication, connectivity, a rejected non-fast-forward push, an index lock, a branch checked out elsewhere or a missing author identity, without exposing credentials. Pull only fast-forwards, and Inertia never force-pushes. See [Git workflows](../GIT_WORKFLOWS.md).

## Limits look stale, or a countdown reached zero

A countdown reaching zero doesn't refill the bar. Choose **Refresh limits** to get the provider's answer. See [Provider usage limits](../USAGE_LIMITS.md).

## Inertia says it restored a backup or started with empty data

The recovery notice explains what happened and offers recovery actions, including copying a report. See [Database recovery](../DATABASE_RECOVERY.md).

## Startup is blocked on Windows after an update

Follow the [profile recovery steps](../WINDOWS_STARTUP_RECOVERY.md).

## Report a problem

- **Settings → Report an issue** guides you through a private report. You review the exact text before anything is submitted to GitHub. See [Guided issue reporting](../ISSUE_REPORTING.md).
- **Settings → Diagnostics → Copy support summary** copies a bounded summary you can attach to a [bug report](https://github.com/eduardtomas1/inertia/issues/new?template=bug_report.yml).

Don't share raw logs, databases or credentials.
