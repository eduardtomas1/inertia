# Usage-limit reset actions

A failed chat on a supported native provider with a current, reported exhausted quota window gains **Resume at reset** and **Snooze until reset** above the composer. The banner uses the existing amber status treatment and composer width, in main, split and detached chats. It stays absent when there is no usable reset time.

Resume is explicit and cancellable. A durable plan pins the failed turn, route and reported account identity. At the reset, the runtime checks fresh quota and sends one continuation through the normal turn admission path. The plan's acceptance and the new turn are committed in one database transaction. A restart cannot repeat an accepted continuation; unaccepted work remains recoverable. Changed chats, account changes, unknown quota and interrupted cleanup require attention instead of guessing. Inertia must be running; reopening after a reset checks quota before proceeding. Snoozing only changes the existing sidebar snooze state and acknowledges the failed run; it never authorizes a continuation or spends reset credits.

## Reference

Inspected public [pingdotgg/t3code at c57a04b7](https://github.com/pingdotgg/t3code/tree/c57a04b722f2172e3be2c8f73c936d10b4582431), including the composer usage limits, thread error banner and sidebar snooze behavior. The supplied OV2 screenshot shows the two reset actions, but those actions were not present in that public revision. This implementation adapts the screenshot to Inertia's own persistence, runtime admission and renderer architecture.

## Account and quota limits

The scheduling path is shared across providers. Native account coverage:

| Provider | Source and scope |
| --- | --- |
| Codex | Native account/rate-limit RPCs; ChatGPT subscription routes. |
| Claude | Native SDK account and usage; first-party subscription routes. |
| Cursor | Dashboard usage API, CLI credential precedence, native macOS Keychain or the CLI's platform credential file. Overall and model-family windows are attributed separately. |
| Kimi Code | The official CLI's usage endpoint, selected managed model and configured OAuth/API credentials. The provider owns OAuth renewal; expired or rotated credentials require attention rather than a guessed account. |
| OpenCode Go | The chat workspace's effective native SDK inventory selects the Go model, endpoint and credential, including project overrides. Other OpenCode backends cannot borrow Go quota. |
| Antigravity | Its current CLI protocol exposes no subscription reset time. Limits reports this explicitly; no timer is invented. |

Inspected T3's `cursorUsageLimits.ts` and `openCodeUsageLimits.ts`, and official [MoonshotAI/kimi-cli at 9ab1286b](https://github.com/MoonshotAI/kimi-cli/tree/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82), including its shell usage reader, configuration, ACP model IDs and credential precedence. OpenCode uses Inertia's existing managed SDK process and installation ownership instead of assuming a global credential file matches the chat. Provider credentials stay in their existing stores and are never saved to Inertia's database or exposed to the renderer. Cursor's macOS Keychain read uses the native binding and keeps one outstanding OS request, with a bounded caller deadline. It may require the normal macOS access prompt.

Native API quota windows determine the time: when several applicable windows are exhausted, use the last reset. Unknown timestamps, stale reports, custom backend routes and unknown exhausted model windows do not invent an offer. Known Claude windows for other model families are excluded.

Credential fingerprints from the Cursor, Kimi and OpenCode readers pin credential continuity without granting reset-credit authority. Verified Codex account IDs are used when available. Otherwise, a private signature of the native API's reported email, organization and plan detects changes in those fields. This is not a verified account ID and is never used to authorize credit redemption. A provider workspace change that preserves all reported fields cannot be distinguished by these APIs. Missing account metadata disables automatic resume while leaving snooze available.

## Screenshots

Captured from the production Electron renderer with real persisted failed-turn and waiting-plan fixtures, theme asserted before capture. These demonstrate the scheduled state and responsive geometry; they do not claim a successful provider execution on this host.

- `limit-reset-light.png`
- `limit-reset-dark.png`
- `limit-reset-light-narrow.png`
- `limit-reset-dark-narrow.png`

## Validation

Focused tests cover durable restart, atomic acceptance, cancellation during preparation and persistence, stale routes and accounts, bounded quota retries, independent snooze, actual standard turn admission, renderer ownership and polling races, strict IPC and migration lineage. Electron appearance tests cover both themes, banner/composer alignment and narrow-window overflow. Renderer budget deltas are recorded in `renderer-bundle.json` and preserve the prior headroom.

The initial complete suite exposed old-schema test fixtures that retained the new table; those fixtures are corrected and focused upgrade tests pass. The stable reruns after provider expansion completed: full suite **11,844 passed, 74 failed, 106 skipped, one unhandled error** across 1,087 files; portable suite **2,204 passed, 15 failed, three skipped** across 144 files. All feature-owned tests passed. The remaining failing files match the native/host/baseline failures observed in the project-free branch (with its inode-specific issue-report failure absent in this worktree). The unchanged secure-file permission-race test also fails on the detached main baseline. Quality, production build, private-connect build and renderer budget checks pass; native binding packaging and Windows installer accounting checks pass. The complete provider-resume Electron scenario stops before the offer because runtime readiness fails with `owned process containment could not be confirmed (stage=linux-readiness, probe=git)`; its trace contains the runtime-state receipt. This cloud host lacks `/proc/self/task/<pid>/children`; the existing Linux native guardian fails closed during readiness. Native containment has not been bypassed. macOS, Windows and live provider accounts require their normal CI or platform validation.
