# Usage and limits

Open **Usage** in the sidebar. It has two tabs.

## History

Locally recorded usage across your chats and providers.

## Limits

Subscription quota across your accounts:

- Each provider is one row: its accounts and plan, then a meter for every reported window with the remaining percentage and a countdown. Equivalent accounts are averaged.
- Health shows in the dot, meter and number: green from 50% left, amber below 50%, red below 20%. Stale readings are hatched and unreported windows are dashed.
- Select a row to list its accounts in the same columns, then select an account to see its plan, sources, freshness and banked reset credits.
- The **i** next to the title explains how averages work.
- Email addresses stay hidden until you choose **Reveal**.
- **Refresh limits** asks the providers again. The page and the **All provider limits** dialog read the providers when they open and refresh themselves at most every three minutes while visible. On macOS, opening either can read a Cursor login from the Keychain.

An unavailable measurement is never shown as zero, and a countdown reaching zero doesn't refill a bar. The window shows **Reset due** until the provider reports new quota; Codex and Claude are checked again a few seconds after the reset.

A chat that stopped at a usage limit shows **Limited** in the sidebar, and its notification says **Usage limit reached**. Above the composer it says **Usage limit reached**, with **Resume at reset** and **Snooze until reset** once the provider reports when the limit resets. **Continue with another model** opens the model chooser; pick a model from another provider to keep going in the same chat. The next message starts a new session on that provider with the chat's earlier messages as context, and the reset offer from the limited provider goes away.

## Quota warnings

Inertia shows a short notice when a 5-hour or weekly window drops below 25%, 15% and 5% remaining. In **Settings → Notifications**, turn off **Quota warnings**, or set **Warn when below** to 15% or 5% to be warned later.

The composer's usage indicator shows the context window. Its popover adds the selected account's quota in the same colours, says when another account of the same provider has more room, using the last Limits reading, and offers **All provider limits**, which opens the same information without sending a message.

The **Usage** section of the Environment panel opens by default in every chat. If you collapse it, it stays collapsed until you open it again.

For accounts, averages, optional CLIProxyAPI hubs and reset credits, see [Provider usage limits](../USAGE_LIMITS.md).
