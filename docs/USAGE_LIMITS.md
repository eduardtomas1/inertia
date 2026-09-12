# Provider usage limits

Open **Usage → Limits** to inspect subscription quota. The existing composer
usage indicator also offers **All provider limits**, which opens the same
cached account information without sending a message or running an agent.
Use **Refresh limits** to request new observations.

Each provider shows its reported windows, remaining percentages, reset time
and countdown. Expand an account row or select a numbered quota segment to
inspect its plan, sources, freshness and banked reset credits. Email addresses
stay hidden until you choose **Reveal**, or deliberately open a reset
confirmation. Details work with keyboard and touch; no hover is required.

An unavailable measurement is never treated as zero. A reset countdown reaching
zero does not refill a quota bar: refresh to obtain the provider's answer.
Failed reads can retain stale observations only when the account identity is
still verified. The Limits page refreshes at most every three minutes while
visible; the composer dialog reads the cache until you explicitly refresh.
No additional background worker, persistent provider process or startup probe
is created by this feature.

## Accounts and averages

Accounts with the same provider-issued account ID are counted once, including
accounts visible both locally and through a hub. Their details list all known
sources. Equal email addresses alone do not establish account identity.

Equivalent windows with the same reported plan show an **account average**:
each distinct, verified account contributes equally. This is an average of
remaining percentages, not an estimate of combined token capacity. Different
plans, scopes, unknown durations and unknown identities stay separate. An
unreported window does not become an empty account allowance.

Native Codex reports account and plan details through App Server. Inertia
checks the provider-owned account ID before the control process starts and again
before redemption. It binds that ID only when App Server explicitly reports
`cli_auth_credentials_store = "file"` and there is no external token override.
Keyring, auto, ephemeral, unknown and implicit-default stores still show quota,
but stay separate and cannot redeem from Inertia because App Server does not
expose their stable account ID.
Claude's SDK can report email, plan and windows but does not provide the
stable account ID needed here for pooling, so those rows stay separate.
Custom routes and providers without a supported subscription quota API explain
that limitation. API-key, cloud backend and proxy authentication may not expose
subscription quota. Reset credits are distinct from API spending credits.

## Optional CLIProxyAPI hubs

Expand **Usage sources** under Limits, enter a name, the hub's HTTPS origin and
its management key, then choose **Add hub**. HTTP is accepted only for localhost
or a literal loopback address. A URL cannot contain credentials, a query, a
fragment or a custom path. The standard `/v0/management/` API must be available.

Keys are saved through Inertia's existing encrypted credential vault. They are
not stored in the application database or sent through runtime commands. Hub
connections supply usage only and do not change agent routing. Changing a
hub's address requires removing it and adding the new address with a new key.
**Remove** removes the source and its saved key.

Up to four hubs and 32 accounts per hub are supported. Requests reject redirects,
limit each response to 1 MiB and share a 20-second refresh deadline, with at most
four account reads in flight. Codex and Claude quota APIs are supported; other
hub accounts remain visible with an unsupported status. A failed credit read
does not hide successfully read quota. Hub-local routing cooldowns remain
managed by the hub.

## Deliberate reset redemption

Choose **Use reset** in an account's details, check the displayed account and
plan, then choose **Confirm reset**. Inspection, refresh, chat sends and startup
never redeem credits automatically.

Native Codex can select a credit server-side when it reports only an available
count. Hub redemption requires the displayed credit ID. Every attempt stores
its account identity, selected credit when available and stable idempotency key
before contacting the provider. Overlapping confirmations for one account reuse
one attempt, even when different sources expose different credit detail.

If the result is uncertain, **Retry same reset** checks the original attempt.
The attempt survives a renderer reconnect and runtime restart. **Check pending
reset** remains available even when a fresh read reports zero credits. Removing
and reconnecting a hub can rebind the attempt only to a freshly verified copy of
the same provider account; it retains the original credit and retry key. A switched account
is rejected before redemption. `nothingToReset` and `noCredit` are shown plainly;
only the provider's `reset` or `alreadyRedeemed` response establishes success.
Quota is refreshed after an outcome instead of assuming windows were refilled.

The interface and protocol were studied from the [reference post and its three
images](https://x.com/jullerino/status/2097129757888663827),
[T3 Code usage documentation at c542b781](https://github.com/pingdotgg/t3code/blob/c542b781c6c4c766e66dcb764b2142d95600e890/docs/user/usage.md),
and the [official Codex App Server account and reset API](https://learn.chatgpt.com/docs/app-server).
The implementation uses Inertia's existing runtime, credential and provider
lifecycle boundaries. Automated tests use synthetic accounts and credits only.
