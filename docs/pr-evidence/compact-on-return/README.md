# Compact on return

Screenshots of the built Electron app on Windows (x64), and for the
subscription scenario, idle compaction and Context settings on Linux (x64),
taken by
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
composer sends (content, attachments, `activate: false` and
`reason: "on-return"`),
holds it to capture the in-progress state, answers with a `sent` result, and
then adds an on-return compaction receipt (252K → 18.3K tokens) to the chat
detail and reloads. The message itself is therefore not sent to a provider in
this fixture.

## Compact and send

`compact-and-send-offer-light.png`, `compact-and-send-offer-dark.png`

With a draft in the composer, the send button reads **Compact and send**. Its
description, checked by the spec, is "Summarize 252K tokens of history, then
send". Beside it, the **Full history** toggle (not pressed) sends the message
with the whole history instead.

## Full history for this message

`full-history-chosen-dark.png`

The spec presses **Full history** with Space. The toggle shows as pressed and
keeps keyboard focus, and the send button reads **Send**, which is what Enter
now does. Pressing Space again brings **Compact and send** back.

## Prompt cache in the usage meter

`usage-meter-cache-expired-dark.png`

The usage meter's **Usage & context** popover shows "252K used of 1M" and
"Prompt cache expired 42 min ago" under the context value. The fixture reports
the lifetime, so the line has no "about".

## Compacting before sending

`compacting-before-sending-light.png`

After Enter, the composer shows "Compacting before sending…" above the draft,
which stays in place, and the send button turns into a busy spinner named
"Compacting before sending". The timeline shows the live divider
"Compacting before sending · 0.0s" below the last turn.

## Compacted on return

`compacted-on-return-light.png`, `compacted-on-return-dark.png`

The send in these shots was simulated at the WebSocket boundary; no provider
compacted or answered.

Once the message is sent the draft clears. After the reload, the timeline
shows one divider, "Compacted on return · 252K → 18.3K tokens", with no
`/compact` request bubble. The chat now reports 18.3K tokens and a warm cache,
so the composer offers the plain send button again.

## The setting

`chats-setting-light.png`

Settings → Chats → **Context**: **Compact large chats**, with **When you
return** chosen, **Before the cache expires** and **Never** beside it, and
**Auto-compact Claude chats after** below it. The second scenario in the same
spec shows both settings changed (see below).

## Prompt cache on an Anthropic key

`add-api-key-prompt-cache-light.png`

**Add API key** on the Claude Code card opens **Add Anthropic API key**, which
now ends with **Prompt cache**: **5 minutes (default)**, chosen, or **1 hour**,
and "A 1-hour cache costs more to write and less to resume after a break;
worth it when you return to a chat after 5 to 60 minutes." Escape closes it
and returns focus to **Add API key**.

## On a Claude subscription

`subscription-compact-and-send-light.png`, `subscription-compact-and-send-dark.png`,
`subscription-usage-meter-dark.png`

The second scenario signs Claude Code in with a **Claude account** and reports
412K of 1M tokens with a 1-hour prompt cache last used 75 minutes ago. The send
button reads **Compact and send** with "Summarize 412K tokens of history, then
send", and the usage meter reads "Prompt cache expired 15 min ago".

## Compacted while idle

`compacted-while-idle-light.png`, `compacted-while-idle-dark.png`

The chat detail then carries an idle compaction receipt (412K → 21.4K tokens),
as the runtime records it when **Before the cache expires** compacts a chat two
minutes before its cache expires. The timeline shows one divider, "Compacted
while idle · 412K → 21.4K tokens", with no `/compact` request bubble, and the
composer offers the plain send button.

## Context settings

`context-settings-light.png`, `context-settings-dark.png`

Settings → Chats → **Context** after choosing **Before the cache expires** and
**300K tokens** for **Auto-compact Claude chats after**. The spec reloads the
window and checks both choices were saved.

The spec also asserts no viewport overflow at the chat captures and no
renderer errors.
