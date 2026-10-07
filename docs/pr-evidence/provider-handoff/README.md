# Provider handoff evidence

`handoff-dark.png` and `handoff-light.png` are 1440 x 920 captures written by
`tests/e2e/provider-handoff.spec.ts` (Playwright `isolated` project) when
`INERTIA_CAPTURE_PR_ASSETS=1` is set. The database, workspace and Electron
profile are synthetic, and no provider turn runs: before launch the spec seeds
one chat through `RuntimeStore` with a completed Claude turn followed by a
completed Codex turn that records `continuationReasonCode: "harness-changed"`
and `sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0 }`.

| Surface | Dark | Light |
| --- | --- | --- |
| Context handoff divider between the Claude and Codex turns | [Dark](handoff-dark.png) | [Light](handoff-light.png) |

Before each capture the spec asserts:

- a `separator` named
  `Context handoff: Claude · claude-sonnet-4-6 to Codex · gpt-5.5 · 2 earlier messages restored`;
- its row has `tabindex="-1"` and a `data-response-row-id` starting with
  `handoff:`, and the visible pill is `aria-hidden`;
- the divider sits below the Claude answer and above the Codex request;
- the Codex request shows `Provider changed · 2 earlier messages restored`;
- the renderer reported no errors.
