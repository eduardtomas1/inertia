# Continue with another model

Platform: macOS 27.0.1, Electron at device scale 2, window 1440x920. Spec: `tests/e2e/conversation-continuation.spec.ts`. The model chooser fixture keeps provider execution disabled and reports Codex and Claude as ready at the renderer transport, so no provider CLI runs. The seeded chat "Fix the release parser" has one request, one answer and a turn that stopped at its usage limit; the provider reports no reset time, so the row has no resume actions. Before images come from a build of main at `b6865e11` with the same seed, opening the model chooser from its chip because main has no row action.

"Claude harness could not start" in the new chat comes from the fixture, which never starts a provider. It is the same before and after.

## What changed

- The usage-limited row: before, main showed nothing above the composer for a limit without a reset time (the plain "Usage limit reached" row comes from area 1); after, the row has **Continue with another model**, which opens the model chooser with the search field focused.
- The offer after choosing a model from another provider: before, "Open a new chat for Kimi · K3?" with **New chat**; after, "Continue in a new chat with Kimi · K3?" with **Continue**. The reason line and the settings are unchanged.
- The new chat: before, empty, on the project defaults; after, on the same checkout and branch, with "From Fix the release parser · 2 messages" above the composer. The image shows the preview opened from it.

| State | Before | After |
| --- | --- | --- |
| row, light | ![](before-continuation-limited-row-light.png) | ![](continuation-limited-row-light.png) |
| row, dark | ![](before-continuation-limited-row-dark.png) | ![](continuation-limited-row-dark.png) |
| offer, light | ![](before-continuation-offer-light.png) | ![](continuation-offer-light.png) |
| offer, dark | ![](before-continuation-offer-dark.png) | ![](continuation-offer-dark.png) |
| new chat, light | ![](before-continuation-new-chat-light.png) | ![](continuation-new-chat-light.png) |
| new chat, dark | ![](before-continuation-new-chat-dark.png) | ![](continuation-new-chat-dark.png) |

The usage-limit row images in `../usage-limits` were taken before this change and do not show **Continue with another model**.
