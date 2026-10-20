# Inertia harness capabilities

Inertia does not replace Codex App Server, the Claude Agent SDK, Cursor ACP,
Kimi ACP, the OpenCode SDK, or Antigravity's headless CLI with a
lowest-common-denominator agent loop. Each provider keeps its native protocol,
approvals, plans, reasoning, usage, cancellation, and extensions. Native
session continuity remains provider-specific: a harness may instead declare
bounded application context when the provider cannot resume safely. Inertia
composes reviewed capabilities above those harnesses through the existing
exact-turn host-tool boundary.

That distinction matters. A custom harness can make agents more reliable only
where the host owns real evidence, policy, lifecycle, and tools. A longer
system prompt cannot repair a dead transport, invent visual evidence, or turn a
model into an approval authority.

## Capability-pack contract

A compiled capability pack contains:

- a stable identifier and positive revision;
- bounded private provider instructions;
- provider-neutral host tools with process-local runtime validators;
- optional retired tools, which stay callable for provider sessions that
  registered them earlier but are neither advertised nor part of the
  definition digest; and
- evaluation tags, evidence kinds, and scenario identifiers.

The registry rejects duplicate pack, instruction, or tool identities before a
provider starts. It bounds the number and total instruction bytes, sorts packs
deterministically, computes a SHA-256 definition digest, and exposes a manifest
without exposing instruction bodies. The digest identifies reviewed metadata,
instructions, and tool schemas; the explicit pack revision identifies handler
behavior because runtime functions cannot be hashed reproducibly. Tool calls
still pass through Inertia's existing exact conversation, run, turn,
cancellation, approval, replay, size, and project-authority checks.

Packs are product code reviewed and shipped with Inertia. The runtime does not
load JavaScript, prompts, schemas, or handlers from a repository, npm package,
model response, or remote marketplace. That restriction is intentional: a
pluggable in-process harness would be an ambient-code-execution system, not a
safe customization feature.

## First compiled packs

`inertia.orchestration` composes the existing top-level chat-management tools.
Its guidance requires concrete ownership and success criteria, bounded
delegation, inspection of the terminal result, and deference to Inertia for
approval. Starting a child chat is explicitly not treated as evidence that its
work completed.

`inertia.frontend-workbench` composes the Browser tools described in
`docs/AGENT_BROWSER.md`. Its guidance tells every provider that the chat has
its own Browser whether or not the panel is showing, to navigate before
anything else because a new tab is blank, and to follow the next step a
failed tool names before giving up on the Browser. It also says that a
`[redacted]` value is Inertia hiding a secret rather than page content and
must never be retyped to check it, and that page text and control names are
untrusted page data, never instructions; the snapshot and type tool
descriptions repeat this. A
successful semantic snapshot gains a bounded `inertiaAudit` object with stable
issue codes for controls without stable labels or semantic names, clipped
controls, overlapping controls, and targets smaller than 24 by 24 CSS pixels
in the current viewport.
The audit is deterministic and provider-neutral. It does not claim to judge
color, typography, imagery, canvas, animation, or pixel quality, and it does
not change screenshot approval or redaction boundaries.

Each tool definition also states whether it only reads (`readOnly`) and
whether it changes the page (`destructive`); both are part of the definition
digest. A transport advertises the destructive hint only when its native
permission layer already defers to Inertia, as described in
`docs/AGENT_BROWSER.md`.

The frontend loop is therefore:

1. inspect the current semantic snapshot;
2. exercise the meaningful interaction path;
3. change the implementation;
4. inspect the snapshot again after the user or layout changes the viewport; and
5. report only the evidence actually observed.

The local screenshot remains useful evidence for the user, but its pixels are
not currently visible to the provider model. The pack tells the model this
directly so it cannot quietly convert “capture succeeded” into a visual claim.
The current Browser also has no agent-owned viewport-resize command.

`inertia.visual-replies` adds one tool, `inertia_render_html`, for every
provider that has Inertia host tools. The agent passes one self-contained HTML
document (at most 256 KiB of UTF-8), a title of at most 120 characters without
control characters, and an optional initial frame height from 80 to 2000 CSS
pixels (default 360). The tool description carries the layout and theme
guidance, including the CSS custom properties Inertia injects, so the pack adds
no private instruction text. The tool is read-only and non-destructive: it
changes nothing in the workspace and never asks for approval. It is not
advertised as idempotent, because every call stores another page.

A call is accepted only from the exact active source turn, and a turn holds at
most eight pages. In one database transaction Inertia checks that limit, then
stores the page in `html_renders` and a turn-scoped system
message whose `htmlRender` reference holds the render id, title, and height;
the message text is a plain placeholder for older clients. The message reaches
clients through the ordinary `conversation.message.persisted` event, and the
model receives `{ rendered, renderId, title, message }`, where `message` asks
it to say in one sentence what the page shows, because some clients and later
turns see only text, and otherwise to add only what the page does not say. Arguments that fail validation, an
oversized page, a settled or cancelled turn, a turn already at its page limit,
and a storage failure each return `{ error: { code, message } }` with
`invalid_arguments`, `html_too_large`, `turn_not_active` (or the shared
`host_tool_failed` when the turn had already settled before dispatch),
`call_cancelled`, `render_limit_reached`, or `render_not_saved`.

The page is served only by the main process from the stored row, inside a
sandboxed frame whose policy blocks fetches, remote resources, frames, workers
and forms. The frame cannot navigate away: the window's own policy refuses
other schemes and the main process refuses any subframe navigation but a visual
reply. Windows that show pages disable non-proxied WebRTC UDP and the page
response turns off DNS prefetching. WebRTC over TCP is not blocked: a page
script can still reach a TURN relay at any address, which the Electron
scenario shows against a local listener (a `<link rel="preconnect">` to the
same kind of listener does not connect). A link opens in the system browser
only for a click the frame's bootstrap saw on a link, at most once per second,
while the frame has focus and a user gesture; the bootstrap runs before any
page script and proves itself with a token the page cannot read. A page
that no longer exists is served as a themed "no longer available" notice (404).
that no longer exists is served as a themed "no longer available" notice (404).
When the runtime is not running or does not answer in time, the page is served
as a themed "temporarily unavailable" notice (503), and the chat reloads that
frame the next time it reconnects to the runtime. The
page itself is never replayed to a model. Shared chat context, continuation
history for another model or a fresh native session, and Private Connect carry
a visual reply only as a one-line `[page: <title>]` entry in the assistant's
place; message search leaves it out like other system messages. Deleting a
chat deletes its pages. The provider MCP HTTP bridge and the stdio proxy accept
request bodies and lines up to 1,600 KiB: every JSON encoder writes a control
character as a six-byte `\u00XX` escape, so a maximum page can reach six times
its size on the wire, and 64 KiB more covers the title and the JSON-RPC
envelope. A body over that bound fails only its own call, before the tool runs:
the HTTP bridge answers 413, and the stdio proxy answers with a JSON-RPC error
when the request id is among the line's leading `jsonrpc`, `method`, and `id`
members (otherwise it drops the line unanswered) and keeps serving the turn's
other calls.

Codex App Server registers dynamic tools only when a thread starts, and Inertia
has no capability epoch that would restart an existing thread for a new tool.
Codex chats created before this pack therefore see `inertia_render_html` from
their next new provider thread. Claude, Cursor, Kimi, and OpenCode attach host
tools for each turn and see it from their next turn.

## Antigravity headless contract

Antigravity is Inertia's only Google provider; the former Gemini CLI provider
is removed. Database schema 76 moves its chats to Antigravity. Transcripts stay
visible, while native Gemini session IDs and Gemini model and effort
selections are dropped, so the next turn starts a fresh Antigravity
conversation on the provider default. Gemini backend profiles, cached
metadata, and identity labels are removed.

Inertia runs the user's own locally installed `agy` 1.2.2 or newer in its
documented headless mode
([headless contract](https://antigravity.google/docs/cli/headless/)). Every
turn is one owned process started with
`--input-format stream-json --output-format stream-json`. The prompt is written
as one `user` event on stdin, and stdin is then closed. Inertia never passes
`-p` or `--print`: without stream-json input, an unauthenticated `agy -p`
prints a sign-in URL and waits, while stream-json input fails fast with
"authentication required". A contract test asserts that no Antigravity
invocation carries a prompt flag.

Detection runs only `agy --version` and requires the selected executable to be
named `agy` or `antigravity`. Model discovery runs that same executable's
documented `agy models` command with closed stdin, a six-second deadline,
a bounded stdout-only catalog parser, and confirmed process-tree cleanup.
Only returned model slugs and labels are advertised; the listing does not
establish a default, reasoning options, image support, or context windows.
Failed or malformed reads retain the last catalog as stale and retry on refresh.
Inertia never probes sign-in or directly reads or writes Antigravity settings,
MCP configuration, or state under `~/.gemini/antigravity-cli/`. Sign-in belongs to
Antigravity. When a turn reports that authentication is required, Inertia stops
the process and shows Connect. Connect opens interactive `agy` inside
Inertia's visible terminal, and only when the user clicks it. Inertia does not
open a browser, read sign-in codes, or store tokens for Antigravity.

| Inertia | Antigravity CLI |
| --- | --- |
| Supervised | Antigravity's own policy. Tools that need approval are declined in headless mode, and the timeline records that an action was declined. |
| Auto-edit | `--mode accept-edits` |
| Plan | `--mode plan` |
| Full Access | `--dangerously-skip-permissions`, only when the user selects Full Access |
| Resume | `--conversation <conversation_id>` from the previous result |
| Model and effort | `--model` for safe identifiers, `--effort low\|medium\|high` |

Structured questions, Inertia-mediated approvals, image input, Inertia host
tools, explicit compaction, and reasoning text are unavailable
in this harness and are declared that way in its capability manifest. A
`step_update` text delta becomes assistant text, a `step_update` with a tool
name becomes tool activity keyed by its step index, `conversation_id` becomes
the native session, and the `result` event settles the turn. Only `SUCCESS`
completes a turn; `ERROR`, `WAITING`, `INVALID`, `CANCELED`, and
`INTERRUPTED` fail it, and an authentication error maps to Connect. Result
usage is projected with session scope. After a result, a lingering process is
stopped after a short grace period, and cancellation stops the whole process
tree.

The following could not be verified without signing in, so the parser is
deliberately tolerant and the behavior is covered by a fake `agy` in tests:

- whether `step_update` fields are nested under the event name or flat (both
  are accepted);
- the exact meaning of `text_delta` and `tool_name`, and whether a tool step
  repeats while it runs;
- the stderr wording of headless approval declines (matched conservatively);
- whether result usage is cumulative across `--conversation` resumes;
- that `--mode plan` never edits files;
- how `--effort` interacts with `--model`;
- how `agy` handles SIGINT (Inertia stops the process tree instead).

The official `antigravity-acp` server was not used: it can end a turn with
`end_turn` after an error and has no macOS Intel artifact. See
[the investigation](STABILIZATION_PROVIDERS_ANTIGRAVITY.md).

## Watcher harness gate

A watcher is a read-only conversation linked to a watched chat (see
[the user guide](user/watcher.md)). It may run only on a harness in the
reviewed allowlist `WATCHER_HARNESS_IDS` in `src/shared/watcher.ts`, checked
through `watcherHarnessAllowed`:

| Harness | Read-only mechanism |
| --- | --- |
| `claude-agent-sdk` | `permissionMode: "plan"`. Bash and edit tools reach Inertia's approval broker, which declines them for a watcher turn, so every command needs approval and is declined. |
| `codex-app-server` | Supervised maps to `approvalPolicy: "untrusted"` with the read-only sandbox. Codex runs its known-safe read commands inside that OS-enforced sandbox without network access; anything else surfaces as an approval, which is declined. Watcher threads, started or resumed, also disable the user's MCP servers, apps, plugins, hooks, subagents and web search through the thread's `config`. |
| `opencode-sdk` | Plan mode with the run input `readOnlyProfile: "watcher"`, which `openCodePermissions` maps to the session ruleset `* deny`, then `read`, `glob`, `grep`, `list` and Inertia host tools `allow`, with `read` of `.env`, `*.env` and `*.env.*` denied after the read allow, since OpenCode's own default asks before reading them. The supervised ruleset alone ends in a `* ask` catch-all, so OpenCode would prompt for every read and the watcher would decline it. With the profile, reads run without a prompt, and edit, shell and every other native tool are denied by OpenCode itself, without an approval. |

The gate is checked when a watcher is attached, when every watcher turn is
prepared (including a message the user types into the watcher chat), and when
`conversation.update` changes the watcher's model. The attach dialog offers
only ready routes on these harnesses. A watcher can change its model only
within the allowlist; its interaction mode and access mode cannot change while
it is attached.

### Why an allowlist and not a capability id

Watcher support is not a `PROVIDER_CAPABILITY_IDS` entry. Adding an id changes
every harness's capability manifest and therefore its attestation digest.
`providerContinuationCompatibilityToken` returns that digest as the
continuation identity, so a new id would make every existing chat lose native
session resume on upgrade. The allowlist is ordinary reviewed code: admitting
a harness is a code change that lands with its portable fixture, and it leaves
manifests and continuation tokens untouched.

### Enforcement layers

Each layer works on its own; none relies on the model following instructions.

1. **Mode and access pinned.** A watcher conversation is created with
   `interactionMode: "plan"` and `accessMode: "supervised"`. Turn preparation
   refuses any watcher turn that is not plan, supervised and on an allowed
   harness, and `conversation.update` refuses mode and access changes.
   Supervised is the lowest access level, so a watcher never has more access
   than the chat it watches.
2. **Fail-closed interactions.** Approval requests are declined through the
   provider's own deny decision and recorded as a visible activity. No approval
   card is broadcast, so watcher conversations never have pending approvals. A
   declined edit request (a `file-change` approval, or a `permissions` approval
   asking for write access) is recorded as a `write-attempt` and the turn
   continues; any other declined request is a `command-attempt`. A second
   declined request in one turn, or a request without a deny option, stops the
   turn. An input request stops the turn.
3. **Real-time activity guard.** A started `file` activity, or an activity in
   the `coding` category, cancels the provider run and settles the turn as
   failed with "Watchers are read-only. Inertia stopped this check." The
   outcome is `write-attempt`. Write attempts are counted per watched turn,
   whether declined or stopped: the second pauses the link with
   `write-attempts` and stops the check. A started `command` activity does
   not stop the turn: commands are governed by the provider gates in the table
   above, and the receipt records how many commands the watcher ran
   (`commandsRun` on the feed item). The `command-attempt` outcome is used only
   for a command approval that was requested and declined.
4. **Git fingerprint backstop.** `src/server/git/checkout-fingerprint.ts`
   fingerprints the checkout before and after each check through
   `runGitInspection` (`--no-optional-locks`, `core.fsmonitor=false`):
   `rev-parse --verify HEAD`, `symbolic-ref -q HEAD` (so a branch switch at
   the same commit counts as a HEAD move), a bounded
   `status --porcelain=v2 -z --untracked-files=all --no-renames`, and
   `hash-object --no-filters` for changed and untracked paths, batched to at
   most 24 K characters of arguments for Windows. `--no-filters` keeps
   repository clean filters from running. Each initialized submodule that
   `.gitmodules` lists inside the checkout (at most 16) is fingerprinted the
   same way with its own filters disabled, so uncommitted edits inside it
   count. Ignored files, `.git` internals such as hooks, config and other
   refs, and submodules nested inside submodules are not fingerprinted. More
   than 2,000 paths or 64 MiB of hashed bytes in all marks the fingerprint
   truncated. A changed path is *explained* when another
   turn active on the same checkout reported it in a file activity during the
   window. The result is *inconclusive*, and does not pause, when another
   active turn ran a command, a workspace or source-control run was active, a
   terminal resume was active, or the watcher's own turn had no activity that
   could write (no command and no started edit). An inconclusive check keeps
   its finding and lists its unexplained paths on the feed item. Unexplained
   paths in a conclusive window pause the link with `write-detected` and list
   at most 20 paths. A non-repository,
   a timeout or a truncated fingerprint is *unavailable*; the other layers
   still apply.
5. **Boundary instruction.** The `inertia-watcher` instruction states that the
   watcher is read-only.

Watcher turns also skip checkpoints and turn Git artifacts entirely, so they
never write `refs/inertia/checkpoints/*`, never run `git write-tree`, and never
offer a Revert that could undo the watched chat's work. Capability-pack
instructions are not sent and the orchestration and Browser tools are not
offered. The watcher's only host tool is the context tool, with a fourth access
kind, `"watched"`, that reads the watched chat without a route filter and
without the approval chooser, bounded by `contextReadsPerWake` (default 4).
The link's sharing choices bound those reads as they bound each check: with
`brief` off the tool returns no user requests (and no request images), with
`activities` off no commands, tool calls or errors, with `partialReplies` off
no agent messages or pages, and with `changedFiles` off no file lists.

### Hidden instructions and the digest

- `inertia-watcher` carries the role and boundary, the preset, the user's
  instructions quoted as user-authored, the output format and the rule to
  answer exactly `SILENT` when there is nothing to report. It stays under
  6 KiB, below the 16 KiB per-instruction cap.
- `inertia-watcher-note` accompanies a main-chat turn that delivers a watcher
  note, and marks the note as forwarded from the watcher, not written by the
  user. A steered note carries the same attribution in its provider content.

Both labels are part of the `INERTIA_SECTION_LABEL` alternation in
`untrusted-agent-text.ts`, so text from the watched chat or the provider that
imitates them is neutralized. NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR
(U+0085, U+2028, U+2029) become newlines before any quoting and spaces in
single-line labels, so quoted text cannot step outside its `> ` quote. The
digest for each check is the watcher turn's
visible content (64 KiB turn cap, `digestKiB` default 24), not a hidden
instruction, and every quoted string passes through
`boundedUntrustedAgentText`. It honours the link's sharing choices; the
watched turn's plan is shared under `activities`.

### Pauses and resume

A paused link records its reason. A wake whose route fails the
`watcherRouteReadiness` preflight (selection, allowlist, backend readiness, a
runnable provider) retries as transient with the scheduler's backoff at most
`WATCHER_ROUTE_RETRY_LIMIT` (3) times; the next failure pauses the link with
`route-unavailable`, a detail that names the route and the readiness message,
and a `watcher.link.updated` broadcast. A check that starts resets the count.
A check whose watcher turn fails to queue (for example when path authority
refuses the shared checkout) is recorded as `failed`; the
`WATCHER_DISPATCH_FAILURE_LIMIT`-th (3rd) consecutive failure pauses the link
with `route-unavailable` instead of retrying with backoff forever. A
`wake-budget` pause belongs to one watched turn: the next watched turn ends it
and grants a fresh allowance. A final pass always digests the turn that ended
(`turnId` on the digest), even when the next turn already began, and never
spends the next turn's allowance; the cursor update is a compare-and-set on
the turn the digest was built from, so a late check never rewinds coverage.
`usage-limit` and `route-unavailable`
resume only once `watcherRouteReadiness` reports the watcher's route ready,
and no link resumes while its watched chat or its own chat is archived,
whatever its pause reason. Every resume tops the turn's check allowance back up to
`wakesPerWatchedTurn`. Deleting the watched chat detaches the link in SQL and
deleting the watcher chat removes it; the delete command then broadcasts
`watcher.link.removed` for each link the chat took part in. A delete of a
watched chat whose watcher is mid-check is refused with a request error before
any side effect (no checkpoint, worktree or ownership change); the
`BEFORE DELETE` trigger stays as the backstop. Archiving the watched chat
pauses its link with `watched-archived`, and archiving the watcher chat itself
pauses it with `watcher-archived`, from any attached status: either reason
replaces an earlier pause, and a check that is running is cancelled. An
archive by an agent's management tool reaches the link through the
conversation shell update it broadcasts.

The Git fingerprint backstop compares changed paths with other turns'
activities in NFC, and folds case on Windows and macOS, whose file systems are
case-insensitive by default.

### Fixtures

`tests/server/watcher-read-only-harnesses.test.ts` is a portable suite
(`// @inertia-test-suite portable`, without an `@inertia-harness` marker,
because each harness can be registered only once). It runs watcher turns
through the TurnController's read-only policy and the real harness adapters,
with the real `ProviderManager`, against scripted providers in a temporary Git
repository. Each scripted provider writes only if Inertia lets it, and every
case compares the checkout fingerprint, `git status` and the file contents
before and after the turn.

- Claude: the query receives `permissionMode: "plan"`, no setting sources and
  Inertia's `canUseTool`. Read and Grep run without `canUseTool`, as Claude
  Code's plan mode does; a Write permission request is declined as a
  `write-attempt` and the turn completes. A streamed Edit tool start stops
  the turn, aborts the query before the edit and releases the run.
- Codex: `thread/start` and `thread/resume` carry `approvalPolicy: "untrusted"`,
  `sandbox: "read-only"` and a `config` that disables every MCP server
  `config/read` reports, apps, plugins, hooks, subagents and web search, and
  `turn/start` carries the same policy,
  `sandboxPolicy: { type: "readOnly", networkAccess: false }` and plan
  collaboration mode. A known-safe read command runs without an approval; a
  write command's approval is answered `decline` and recorded as a
  `command-attempt`. A malformed frame fails the turn and the app-server
  process exits.
- OpenCode: the scripted server evaluates rules as OpenCode does (agent rules,
  then session rules, last match wins). Under the supervised plan ruleset
  alone, read, glob, grep, list and bash all prompt. A watcher turn sends the
  profile ruleset, reads complete without a prompt, `.env` files are denied,
  edit and bash are denied and not offered, and the server process exits on
  shutdown. A second case
  gives the agent its own rules that allow everything, edits, shell and
  `external_directory`; the session profile still wins, because OpenCode
  merges the agent's ruleset first and the session's after it and takes the
  last match. The profile depends on that order. If OpenCode ever evaluated
  agent rules after session rules, its allows would win, so the scheduled
  canary and this fixture are what must catch such a change.

Run it with `npm run test:portable`. Integration coverage
lives in `tests/server/watcher-read-only-guard.test.ts` and
`tests/server/watcher-delivery.test.ts`, which also checks that steering a note
is refused on Cursor.

### Excluded harnesses and custom backends

`cursor-acp`, `kimi-acp`, `antigravity-cli` and the CLI harnesses
(`claude-cli`, `codex-cli`, `cursor-cli`, `opencode-cli`) are not in the
allowlist. Antigravity has no Inertia-mediated approvals or host tools, so a
watcher there could neither be held read-only by Inertia nor read the watched
chat. Any of these can still be the watched chat. A harness joins the
allowlist only together with a portable fixture that proves the layers above.

A custom backend on an allowed harness can be a watcher, but custom backends
never receive Inertia host tools. Such a watcher reviews only the digest each
check sends it and cannot read more of the watched chat; the dock states "Can
read the watched chat: no (custom backend)".

The watched chat can run on any harness and can switch provider mid-chat. The
digest is provider-agnostic, `"watched"` access applies no route filter, and
whether a note can be steered into the running turn is recomputed from that
turn's harness against `STEERABLE_HARNESS_IDS`.

## What the open-source review changed

The August 2026 review used other projects as evidence and adversarial test
input, not as a source-code donor. Several independent communities repeatedly
converge on the same failures:

- permission policy becomes unsafe when a model, hook, or mode label can
  silently widen host authority ([Cline #13140](https://github.com/cline/cline/issues/13140),
  [goose #11017](https://github.com/aaif-goose/goose/issues/11017),
  [OpenCode #16331](https://github.com/anomalyco/opencode/issues/16331));
- interrupted providers and delegated work need explicit, truthful terminal
  states rather than synthetic continuation
  ([OpenCode #11865](https://github.com/anomalyco/opencode/issues/11865),
  [ACP #554](https://github.com/agentclientprotocol/agent-client-protocol/issues/554),
  [agent-browser #1437](https://github.com/vercel-labs/agent-browser/issues/1437));
- host rules and evidence budgets must survive long sessions without blind
  context trimming ([Cline #4389](https://github.com/cline/cline/issues/4389),
  [OpenHands #6634](https://github.com/OpenHands/OpenHands/issues/6634),
  [goose #11318](https://github.com/aaif-goose/goose/issues/11318));
- capabilities should be negotiated precisely instead of faking parity across
  providers ([ACP #1559](https://github.com/agentclientprotocol/agent-client-protocol/issues/1559),
  [OpenCode #6864](https://github.com/anomalyco/opencode/issues/6864),
  [Aider #2227](https://github.com/Aider-AI/aider/issues/2227)); and
- frontend agents need a hybrid semantic and visual loop with bounded artifacts,
  not a screenshot-only control scheme
  ([Playwright MCP #420](https://github.com/microsoft/playwright-mcp/issues/420),
  [Playwright MCP #1193](https://github.com/microsoft/playwright-mcp/issues/1193),
  [agent-browser #304](https://github.com/vercel-labs/agent-browser/issues/304)).

The architectural reference points were the
[Codex harness/App Server model](https://openai.com/index/unlocking-the-codex-harness/),
the [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol),
[Pydantic AI Harness](https://github.com/pydantic/pydantic-ai-harness),
[Harbor](https://github.com/harbor-framework/harbor),
[OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk),
[goose architecture](https://github.com/aaif-goose/goose/blob/main/documentation/docs/goose-architecture/goose-architecture.md),
[Aider repository maps](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/repomap.md),
[Playwright MCP](https://github.com/microsoft/playwright-mcp), and
[agent-browser](https://github.com/vercel-labs/agent-browser).

## Deliberate non-goals and next work

This first release is a composition foundation, not a claim that every useful
harness feature is finished. It deliberately does not:

- replace or emulate provider-native protocol features;
- grant a model permission to approve its own action;
- execute third-party or repository-provided packs;
- expose screenshots to models or infer visual quality from semantic boxes;
- invent completion after provider failure; or
- merge Cursor and Kimi into a generic ACP behavior layer before their actual
  protocol differences are covered.

The next high-value layers are an inspectable context ledger with pinned host
rules, bounded replay artifacts tied to exact turns, explicit capability
negotiation for resumable sessions, and a separately reviewed visual-evidence
transport. Each should land with deterministic fixtures and provider-specific
contract tests rather than as a broad framework rewrite.
