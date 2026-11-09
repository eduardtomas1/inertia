# Claude usage efficiency

How much of a Claude subscription, or an API bill, a chat costs depends less on
each request's settings than on how much context every request re-reads. This
page records how Inertia was measured against T3 Code, what Inertia changed
because of it, and how to measure again.

## Measuring

`npm run usage:claude -- --days 21` (or `--since` / `--until` with ISO times,
`--projects` for another folder, `--json` for the raw report) reads Claude
Code's own transcripts in `~/.claude/projects`, including subagent
transcripts, and prints one row per app and kind of session:

- **weighted**: tokens weighted by API price ratios (input 1, cache read 0.1,
  5-minute cache write 1.25, 1-hour cache write 2, output 5). Anthropic does
  not publish how the subscription meter counts, so this is a proxy.
- **per output**: weighted tokens per output token, the cost of one unit of
  work. Lower is better.
- **avg context** and **>400K**: the context each request re-read.
- **compactions**: how many, and the context size they happened at.
- **idle >1h rebuilds** and **5–60 min rebuilds**: requests that wrote more
  than half of a context over 20K tokens to the cache again after that gap,
  that is, a cache that had expired.

Sessions are told apart by what they contain (Inertia's skill plugin and host
tools, T3 Code's MCP tools and instructions), not by Claude Code's
`entrypoint`: older T3 Code builds also reported `sdk-ts`.

## What the transcripts showed (19 October to 9 November 2026)

Same machine, same account, same model family, both apps launching Claude Code
2.1.31x with identical request settings (adaptive thinking, high effort,
1-hour cache on the main conversation):

| Group | Calls | Per output | Avg context | >400K | Compactions |
| --- | ---: | ---: | ---: | ---: | --- |
| Inertia main chats | 12,285 | 66.3 | 383K | 41% | 9, at 924K on average |
| T3 Code main chats | 4,478 | 35.5 | 213K | 12% | 5, at 354K on average |
| Inertia subagents | 35,138 | 32.2 | 170K | 5% | 0 |
| T3 Code subagents | 6,968 | 36.6 | 249K | 17% | 0 |

- Eight of Inertia's nine compactions were Claude Code's automatic one at
  about 967K tokens. All five of T3 Code's were its **Compact** chip on
  return, at 213K to 756K. Inertia offered the same chip only to API keys, so
  subscription chats grew to the ceiling and every step re-read them.
- Re-reading cached context was 72% of what Inertia's main chats cost.
- Per request, both apps were alike. Subagents cost about the same per unit of
  work in both; Inertia simply ran more of them.

## What Inertia changed

| Change | Where | Why |
| --- | --- | --- |
| **Compact and send** for Claude subscription chats, with the 1-hour cache Claude Code reports there | `compactOnReturnEligibility` | The lever behind every T3 Code compaction above |
| **Before the cache expires** (beta): compact an idle Claude chat two minutes before its 1-hour cache expires | `idle-compaction-scheduler.ts`, `compactIdleConversation` | T3 Code's idle compaction; the history is still read from the cache |
| **Auto-compact Claude chats after**, 400K tokens by default | `autoCompactWindow` in the Claude launch settings | Claude Code's default waits until 967K on 1M-token models |
| A provider switch carries at most 64 KiB of history and points at `inertia_request_context` for the rest | `NATIVE_RESTORED_HISTORY_BYTES` | T3 Code caps a handoff at 16K tokens and lets the agent read more on demand |
| Inertia's host tools load through tool search instead of on every request, also inside subagents | `claude-host-tools.ts` | T3 Code defers its MCP tools on purpose |
| The context meter reads the summary instead of counting each category through the token-count API | `readClaudeContextUsage` | The default `'full'` made several requests after every assistant message |

## Measured after the change

What Claude Code 2.1.319 itself reports for a launch with Inertia's isolation
settings and 25 of its host tools (browser, workspace, page rendering, chat
context and wait), read through `getContextUsage({ detail: "summary" })`
before any model request, so no quota was used:

| Launch | Fixed tokens per request | Inertia tools loaded | Auto-compact threshold |
| --- | ---: | ---: | ---: |
| Before: host tools always loaded, Claude Code's window | 41,646 | 7,982 | 967,000 |
| After: host tools deferred, 400K window | 33,664 | 0 (7,982 deferred) | 367,000 |
| For comparison, `ENABLE_TOOL_SEARCH=auto` | 74,525 | 7,980 | 367,000 |

`auto` on a long-context model loads every tool schema while they fit, Claude
Code's own included (30.5K become 63.4K tokens). T3 Code rewrites `auto` to
`true` for that reason. Inertia needs no rewrite: it passes only `ANTHROPIC_*`,
`CLAUDE_CODE_*` and a few `DISABLE_*` variables to Claude Code, so
`ENABLE_TOOL_SEARCH` is never set on Claude Code's own sign-in, and unset
already defers. Custom Claude backends set it to `true` themselves when their
profile enables tool search.

Replaying the same three weeks of Inertia main chats under the new defaults
(a 20K-token summary, the person taking **Compact and send**, compaction on
return paying one uncached read of the history):

| Policy | Weighted tokens | Compactions |
| --- | ---: | ---: |
| As recorded | 660M | 9 |
| Compact on return for subscription chats | 476M (−28%) | 36 |
| Auto-compact at 400K | 355M (−46%) | 43 |
| Both | 330M (−50%) | 59 |

That brings Inertia's main chats from 66 to about 33 weighted tokens per
output token, level with T3 Code's 35.5. The replay does not count the
detail a summary loses or files an agent reads again after compacting.

The 22 automatic history restores in that period carried 2.41M characters;
capped at 64 KiB they would have carried 1.14M.

## Codex

The same comparison over Codex's own logs (`~/.codex/sessions`, telling apps
apart by each session's `originator`), weighting input 1, cached input 0.1 and
output 8:

| Group | Sessions | Requests | Per output | Avg context | >200K | Cache hits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Inertia | 58 | 5,504 | 46.0 | 180K | 35% | 98.4% |
| T3 Code | 31 | 1,947 | 39.5 | 131K | 20% | 98.0% |

Fixed overhead was the same (21.5K and 20.1K tokens on a session's first
request), Codex's cache survived 30 to 60 idle minutes almost fully, and only 8
large Inertia Codex chats came back after more than an hour, so compact on
return has little to win there. The gap is again long chats: Codex compacts at
about 95% of its window. Replaying Inertia's Codex sessions with a lower limit
gave 137M → 115M weighted tokens at 300K (−16%, 15 extra compactions) and 98M
at 200K (−29%). Codex is about 8% of Inertia's weighted use, so **Auto-compact
Codex chats after** defaults to 300K. T3 Code has no Codex equivalent.

Kimi manages its own context; Cursor, OpenCode, Antigravity and Grok report no
cache lifetime and saw almost no use in the period. Only the 64 KiB cap on
automatic history restores applies to them.

## What was looked at and left alone

- **Session titles.** T3 Code passes its own title so Claude Code skips its
  one Haiku title request. Inertia names Claude chats from that very title
  (`readClaudeSessionTitle`), so skipping it would cost the chat its name.
- **The Workflow tool description.** It is about 20K characters in Inertia
  and 3.5K in T3 Code because Inertia's isolation sets
  `disableBundledSkills`, and Claude Code then inlines the workflow-authoring
  reference. That is about 4K tokens per main-chat request read from the
  cache, under 1% of the total; changing the skill isolation for it is a
  separate decision.
- **Subagent cache lifetime.** Subagents write 5-minute cache entries, and a
  subagent that waits longer than that on a build or render writes its
  context again. Simulated over the same three weeks, a 1-hour subagent cache
  (`subagentPromptCacheTtl`) saved about 5%, because every write costs more,
  and it keeps writing 1-hour entries while a subscription is in overage.
- **Subagent fan-out.** Inertia's limits are Claude Code's own defaults
  (depth 3, 20 at once). How many subagents a chat starts is mostly how it is
  asked to work.
