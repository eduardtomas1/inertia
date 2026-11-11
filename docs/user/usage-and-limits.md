# Usage and limits

Open **Usage** in the sidebar. It opens one popup over the app with three tabs, **Cost**, **Tokens** and **Limits**; press C, T or L to switch. The popup opens on the tab you used last, and on Limits the first time. Escape or the close button returns to where you were.

The header reads **Usage / period / providers**. On Cost and Tokens the middle part chooses the last 7, 30 or 90 days. On Limits it chooses the source (this computer or one usage hub) and only appears once a hub is configured. **All providers** hides or shows providers on all three tabs. The popup remembers the tab, the period and the hidden providers. The round arrow refreshes the tab you are on.

## Cost and Tokens

Locally recorded usage across your chats and providers for the chosen period.

- **Tokens** shows the processed tokens Inertia measured: the total, each provider's share, a daily chart, tokens by type, and a breakdown by model or by day.
- **Cost** shows the same usage as an **API estimate**: what those tokens would cost at public API list prices. It is not a bill, and a subscription is not charged this way. Input, cache reads, cache writes and output are priced separately; **Cache savings** is what cached input saved against the full input price.
- The estimate says how many requests it covers (*priced 3 of 8*). A model with no known price is marked **Unpriced** and adds nothing. A Claude alias such as `opus` is priced as the version recorded with the request (*priced as claude-opus-5-5*), and stays unpriced when no version was recorded.
- Prices come from LiteLLM's public model price list. Inertia ships a copy with each build, so Cost works offline and never waits for the network; the note under the tables says how old the prices are.
- **Network request.** When you open Cost or Tokens and the prices Inertia has are older than 24 hours, it downloads the current list in the background with one plain GET to `raw.githubusercontent.com` (`BerriAI/litellm`, `model_prices_and_context_window.json`). The request carries no account, usage, model or project information, only what any download reveals: your IP address to GitHub. The downloaded list is stored in Inertia's data folder and used from the next refresh. If the download fails, Inertia keeps the prices it has and tries again no more than once a minute while Usage is open.
- Changing the period or refreshing keeps the previous figures on screen while the new ones load.

## Limits

Subscription quota across your accounts, one section per provider and one card per reported window (Session, Weekly, Weekly · Fable…):

- The large number is what is left. The bar is filled up to that point in the provider's colour.
- The hatched end of the bar is what the next reset gives back. The chip at its right end counts down to that reset (`↻ 3d 6h`) and, after a ticket, shows the account's banked resets.
- The thin vertical line marks an even pace: where the bar would end if you had spent quota exactly as fast as the window elapses. The small icon beside the number says the same in words: an upward arrow when you are spending faster than the window elapses, a downward arrow when you have headroom, a gauge when you are within five points of even.
- Several equivalent accounts of one provider share a bar, one segment per account, and the large number is their average. Accounts on a different plan, or whose identity Inertia can't verify, keep their own cards.
- A session shows 0% while the same account's weekly limit is used up, with the countdown of the reset that brings it back.
- Select a segment (click it, or Tab to it and press Enter) to see that account's plan, sources, freshness and banked resets, and to use a reset. Email addresses stay hidden until you choose **Reveal**.
- The **i** under the cards explains how averages work. **Usage sources** below it adds or removes usage hubs.
- Limits appear at once from the last reading and update account by account as the providers answer; accounts still being read are dimmed. The popup reads the providers when Limits opens and at most every three minutes while visible.
- Cursor, Kimi Code and Grok don't report usage to Inertia; their rows say *Usage is not reported by this agent.*

Limits cover accounts. A chat that runs on an API key or a custom backend shows **Usage is not available for API keys**; the provider bills that usage to your API account.

An unavailable measurement is never shown as zero, and a countdown reaching zero doesn't refill a bar. The window shows **Reset due** until the provider reports new quota; Codex and Claude are checked again a few seconds after the reset.

A chat that stopped at a usage limit shows **Limited** in the sidebar, and its notification says **Usage limit reached**. Above the composer it says **Usage limit reached**, with **Resume at reset** and **Snooze until reset** once the provider reports when the limit resets. **Continue with another model** opens the model chooser; pick a model from another provider to keep going in the same chat. The next message starts a new session on that provider with the chat's earlier messages as context, and the reset offer from the limited provider goes away. Sending that message also ends a snooze on the chat, so its notifications and sidebar place come back.

## Quota warnings

Inertia shows a short notice when a 5-hour or weekly window drops below 25%, 15% and 5% remaining. In **Settings → Notifications**, turn off **Quota warnings**, or set **Warn when below** to 15% or 5% to be warned later.

The composer's usage indicator shows the context window. Its popover adds the selected account's quota with the same bars as Limits, says when another account of the same provider has more room, using the last Limits reading, and offers **All provider limits**, which opens the Usage popup on Limits without sending a message.

The **Usage** surface in the right panel shows the selected account's quota with the same bars and this chat's context window, with **All accounts** to open the Usage popup on Limits and **Usage history** to open it on Tokens. Open it from the usage meter beside the panel controls, or press U in the surface chooser (⌘G, Ctrl+G elsewhere). Each chat remembers whether it is open.

For accounts, averages, optional CLIProxyAPI hubs and reset credits, see [Provider usage limits](../USAGE_LIMITS.md).
