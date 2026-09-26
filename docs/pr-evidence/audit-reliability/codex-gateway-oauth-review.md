# Codex gateway OAuth notification review

The [provider canary](https://github.com/eduardtomas1/inertia/actions/runs/36261824794)
reported one additional notification, `account/gatewayOAuth/changed`.
Its latest SDK type/runtime and other CLI checks passed.

Reviewed the official generated
[notification](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server-protocol/schema/typescript/v2/GatewayOAuthChangedNotification.ts)
and [status](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server-protocol/schema/typescript/v2/GatewayOAuthStatus.ts)
schemas at `rust-v0.157.1`. The payload contains `providerId`, nullable `authUrl`
and `error`, and one of `notReady`, `started`, `succeeded`, or `failed`.
The [login processor](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/app-server/src/request_processors/account_processor/gateway_oauth.rs)
sends the authorization URL only to the initiating connection; background
status broadcasts omit it. The URL is an authorization handoff, not transcript
content or permission to start a login.

Inertia does not initiate this gateway login flow. The notification is explicitly
ignored after checking its structure and reviewed status. Its URL, provider
error and account details are never projected, persisted, opened or placed in
the credential vault. Existing transport limits bound the discarded payload.
Malformed fields and unknown statuses fail with constant diagnostic text that
does not include the payload. Other notification discriminants still require
an explicit review in the exhaustive canary comparison.

The reviewed notification table exactly matches all 85 discriminants in the
official versioned `ServerNotification.ts`. Synthetic stdio regressions cover
every valid status with sensitive marker payloads, no additional outbound
requests or state projections, normal completion afterward, and six malformed
or unknown-status cases with confirmed provider cleanup.
