# Usage-limit reset actions

A failed native Codex or Claude chat with a current, reported exhausted quota window gains **Resume at reset** and **Snooze until reset** above the composer. The banner uses the existing amber status treatment and composer width, in main, split and detached chats. It stays absent when there is no usable reset time.

Resume is explicit and cancellable. A durable plan pins the failed turn, route and reported account identity. At the reset, the runtime checks fresh quota and sends one continuation through the normal turn admission path. The plan's acceptance and the new turn are committed in one database transaction. A restart cannot repeat an accepted continuation; unaccepted work remains recoverable. Changed chats, account changes, unknown quota and interrupted cleanup require attention instead of guessing. Inertia must be running; reopening after a reset checks quota before proceeding. Snoozing only changes the existing sidebar snooze state and acknowledges the failed run; it never authorizes a continuation or spends reset credits.

## Reference

Inspected public [pingdotgg/t3code at c57a04b7](https://github.com/pingdotgg/t3code/tree/c57a04b722f2172e3be2c8f73c936d10b4582431), including the composer usage limits, thread error banner and sidebar snooze behavior. The supplied OV2 screenshot shows the two reset actions, but those actions were not present in that public revision. This implementation adapts the screenshot to Inertia's own persistence, runtime admission and renderer architecture.

## Account and quota limits

Native API quota windows determine the time: when several applicable windows are exhausted, use the last reset. Unknown timestamps, stale reports, custom backend routes and unknown exhausted model windows do not invent an offer. Known Claude windows for other model families are excluded.

Verified Codex account IDs are used when available. Otherwise, a private signature of the native API's reported email, organization and plan detects changes in those fields. This is not a verified account ID and is never used to authorize credit redemption. A provider workspace change that preserves all reported fields cannot be distinguished by these APIs. Missing account metadata disables automatic resume while leaving snooze available.

## Screenshots

Captured from the production Electron renderer with real persisted failed-turn and waiting-plan fixtures, theme asserted before capture. These demonstrate the scheduled state and responsive geometry; they do not claim a successful provider execution on this host.

- `limit-reset-light.png`
- `limit-reset-dark.png`
- `limit-reset-light-narrow.png`
- `limit-reset-dark-narrow.png`

## Validation

Focused tests cover durable restart, atomic acceptance, cancellation during preparation and persistence, stale routes and accounts, bounded quota retries, independent snooze, actual standard turn admission, renderer ownership and polling races, strict IPC and migration lineage. Electron appearance tests cover both themes, banner/composer alignment and narrow-window overflow. Renderer budget deltas are recorded in `renderer-bundle.json` and preserve the prior headroom.

The complete checks and provider-resume Electron scenario are being finalized; the PR description records their final results. This cloud host lacks `/proc/self/task/<pid>/children`; the existing Linux native guardian fails closed during readiness. Native containment has not been bypassed. macOS, Windows and live provider accounts require their normal CI or platform validation.
