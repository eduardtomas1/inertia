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
- **Refresh limits** asks the providers again. The page refreshes itself at most every three minutes while it's visible.

An unavailable measurement is never shown as zero, and a countdown reaching zero doesn't refill a bar: refresh to get the provider's answer.

The composer's usage indicator shows the context window and the selected account's quota. When a quota window drops below half, the indicator adds its percentage. The popover says when another account of the same provider has more room, using the last Limits reading, and offers **All provider limits**, which opens the same information without sending a message.

For accounts, averages, optional CLIProxyAPI hubs and reset credits, see [Provider usage limits](../USAGE_LIMITS.md).
