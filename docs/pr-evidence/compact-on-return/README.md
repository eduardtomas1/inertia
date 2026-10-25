# Compact on return

Screenshots of the built Electron app on Windows (x64), taken by
`tests/e2e/compact-on-return.spec.ts` at 1280 × 820 with
`animations: "disabled"` and the pointer moved away. The fixture is synthetic:
a seeded project and one chat, "Billing service migration", with one completed
turn on Claude Code's own route (**Provider default**). The spec rewrites the
runtime's messages to the renderer so that Claude Code reads as installed and
signed in with a **Console API key**, and the chat reports 252K of 1M context
tokens with a 5-minute prompt cache last used 47 minutes ago. No live profile,
provider account, API key or user repository is shown.

The runtime's answer to **Compact and send** is simulated at the WebSocket
boundary: the spec checks the exact `conversation.compact-and-send` payload the
composer sends (content, attachments, `activate` and `reason: "on-return"`),
holds it to capture the in-progress state, answers with a `sent` result, and
then adds an on-return compaction receipt (252K → 18.3K tokens) to the chat
detail and reloads. The message itself is therefore not sent to a provider in
this fixture.

## Compact and send

`compact-and-send-offer-light.png`, `compact-and-send-offer-dark.png`

With a draft in the composer, the send button reads **Compact and send**. Its
description, checked by the spec, is "Summarize 252K tokens of history, then
send". Beside it, the **Compact** chip (named "History: Compact") switches the
message to full history.

## Full history for this message

`full-history-chosen-dark.png`

After the chip is pressed it reads **Full**, keeps keyboard focus, and the send
button returns to the plain round **Send message**. Pressing the chip again
brings **Compact and send** back.

## Prompt cache in the usage meter

`usage-meter-cache-expired-dark.png`

The usage meter's **Usage & context** popover shows "252K used of 1M" and
"Cache expired 42 min ago" under the context value.

## Compacting before sending

`compacting-before-sending-light.png`

After Enter, the composer shows "Compacting before sending…" above the draft,
which stays in place, and the send button turns into a busy spinner named
"Compacting before sending". The timeline shows the live divider
"Compacting before sending · 0.0s" below the last turn.

## Compacted on return

`compacted-on-return-light.png`, `compacted-on-return-dark.png`

Once the message is sent the draft clears. After the reload, the timeline
shows one divider, "Compacted on return · 252K → 18.3K tokens", with no
`/compact` request bubble. The chat now reports 18.3K tokens and a warm cache,
so the composer offers the plain send button again.

## The setting

`chats-setting-light.png`

Settings → Chats, under **Usage display**: **Compact large API chats when you
return**, "Offers to summarize a chat of 200K tokens or more on an API key once
its prompt cache has expired, so the next turn costs less.", with **Offer**
chosen and **Never** beside it.

## Prompt cache on an Anthropic key

`add-api-key-prompt-cache-light.png`

**Add API key** on the Claude Code card opens **Add Anthropic API key**, which
now ends with **Prompt cache**: **5 minutes (default)**, chosen, or **1 hour**,
and "A 1-hour cache costs more to write and less to resume after a break;
worth it when you return to a chat after 5 to 60 minutes." Escape closes it
and returns focus to **Add API key**.

The spec also asserts no viewport overflow at the chat captures and no
renderer errors.
