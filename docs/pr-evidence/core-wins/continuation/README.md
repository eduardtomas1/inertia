# Continue with another model

Platform: macOS 27.0.1, Electron at device scale 2, window 1440x920. Spec: `tests/e2e/conversation-continuation.spec.ts`. The model chooser fixture keeps provider execution disabled and reports Codex and Claude as ready at the renderer transport, so no provider CLI runs. The seed adds one native Claude model, "Fixture Sonnet", to the cached catalog. The seeded chat "Fix the release parser" has one request, one answer and a turn that stopped at its usage limit; the provider reports no reset time, so the row has no resume actions. Before images come from a build of main at `b6865e11` with the same seed and the same model, opening the model chooser from its chip because main has no row action.

## What changed

- The usage-limited row: before, main showed nothing above the composer for a limit without a reset time (the plain "Usage limit reached" row comes from area 1); after, the row has **Continue with another model**, which opens the model chooser with the search field focused.
- The offer after choosing a model from another provider: before, "Open a new chat for Anthropic · Fixture Sonnet?", the reason "Start a new chat to use a different provider…" and **New chat**; after, "Continue in a new chat with Anthropic · Fixture Sonnet?", "The new chat uses the same checkout and gets this chat as context." and **Continue**. The settings line is unchanged. While the offer is open the row action is unavailable, and Cancel returns focus to it.
- The new chat: before, empty, on the project defaults; after, on the same checkout and branch, with "From Fix the release parser · 2 messages" above the composer. The image shows the preview opened from it.

| State | Before | After |
| --- | --- | --- |
| row, light | ![](before-continuation-limited-row-light.png) | ![](continuation-limited-row-light.png) |
| row, dark | ![](before-continuation-limited-row-dark.png) | ![](continuation-limited-row-dark.png) |
| offer, light | ![](before-continuation-offer-light.png) | ![](continuation-offer-light.png) |
| offer, dark | ![](before-continuation-offer-dark.png) | ![](continuation-offer-dark.png) |
| new chat, light | ![](before-continuation-new-chat-light.png) | ![](continuation-new-chat-light.png) |
| new chat, dark | ![](before-continuation-new-chat-dark.png) | ![](continuation-new-chat-dark.png) |

## The usage-limit row with this change

The images in `../usage-limits` were taken before this change and do not show **Continue with another model**. These are the same scenes from `tests/e2e/limit-reset-appearance.spec.ts` on this branch: the plain row ("limited") and the row with a reset time ("offer"), where the action wraps below the resume actions at narrow sizes.

| Size | Limited | Offer |
| --- | --- | --- |
| dark-wide | ![](usage-limit-reset-limited-dark-wide.png) | ![](usage-limit-reset-offer-dark-wide.png) |
| light-wide | ![](usage-limit-reset-limited-light-wide.png) | ![](usage-limit-reset-offer-light-wide.png) |
| light-narrow | ![](usage-limit-reset-limited-light-narrow.png) | ![](usage-limit-reset-offer-light-narrow.png) |
| dark-narrow | ![](usage-limit-reset-limited-dark-narrow.png) | ![](usage-limit-reset-offer-dark-narrow.png) |
| dark-760x600 | ![](usage-limit-reset-limited-dark-760x600.png) | ![](usage-limit-reset-offer-dark-760x600.png) |
