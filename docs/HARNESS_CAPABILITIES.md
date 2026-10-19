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

`inertia_wait_for_conversation` (pack revision 3) lets a parent wait for a
chat it created instead of polling `inertia_get_conversation_status` in a
loop. It takes that chat's `conversationId`, under the same direct-management
rule as the status tool, and `timeoutMs` from 1,000 to 20,000 milliseconds
(15,000 by default). It returns the status tool's result plus `outcome` and
`timedOut`: as soon as the chat has no active turn (`settled`: status idle,
completed, or failed, with the latest turn completed, failed, cancelled, or
interrupted) or needs the user's input (`needs-input`), and otherwise at the
timeout with the current status, `outcome: "timeout"`, and `timedOut: true`.
The wait is capped at 20 seconds because OpenCode's MCP client gives a host
tool call 30 seconds and the HTTP bridge and stdio proxy add their own
deadlines; the tool description tells the model to call again rather than ask
for a longer wait. The wait polls the persisted status every 250 ms without
holding a database transaction, re-checks on every poll that the calling turn
is still the exact active turn (a settled turn gets `host_tool_failed`), and
returns `call_cancelled` as soon as the call is cancelled. It is read-only,
needs no approval, and counts against the turn's host-tool call allowance like
any other call. A Codex thread registers it from its next new provider thread.

### Reading chat context

`inertia.orchestration` also carries `inertia_request_context`, which lets an
agent read turns of Inertia chats. With the `conversationId` of its own chat,
of a chat the user referenced in the message that started the turn, or of a
chat its own chat manages, it works without asking: it lists that chat's turns newest first (turn id, first
line of the request, status, and date; 20 by default, at most 50), and with a
`turnId` it reads one turn in full: the request and its images, the agent's
messages, commands with their outcomes and exit codes when recorded, tool
calls, changed files, provider, model, status, and times. Each result carries
at most 30 KiB; a longer list or turn returns `nextCursor`, which the agent
passes back as `cursor`. A turn of the agent's own chat that ran on another
model endpoint is withheld from that chat's history and returns
`turn_withheld`.

A managed chat is one this chat created with `inertia_create_conversation`,
which the user approved, in the same project. Only the direct parent counts: a
managed chat's own children are not managed by the grandparent, a sibling is
not managed by its sibling, and a child does not manage its parent, so each of
those still opens the chooser. A managed read pages and bounds results like a
referenced one, its agent-written text is neutralized and secret-scrubbed the
same way, and the read is recorded on the reading turn with access `managed`
(database schema 99 widens the read log for that value).

Any other chat, or a call without `conversationId`, opens a chooser card in
which the user picks a chat to share, with an extra confirmation for a chat in
another workspace. The result is a bounded excerpt of that chat, and its turns
can then be listed and read for the rest of the turn. A turn may open the
chooser at most four times (`budget_exceeded` afterwards); a chooser expires
after five minutes, and a dismissed or expired chooser returns
`user_cancelled` or `call_cancelled`. Request images are returned only to
native Claude and Codex routes whose model accepts image input; other routes
get a note that the image is not available there. Agent-written text in a
result is quoted data, never instructions, and Inertia records each read on
the reading turn.

### Frontend workbench

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

### Visual replies

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

### inertia.workspace

`inertia.workspace` (revision 1) lets an agent read what the user sees in
Inertia's surfaces for its own chat. It is offered to every provider that has
Inertia host tools, whatever the project's Browser setting. Its six tools are
read-only and non-destructive, take flat argument objects with no required
fields, and never ask for approval:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `inertia_git_status` | none | Whether the chat's workspace is a Git repository; branch, detached state, upstream, ahead and behind; up to 200 changed files with `path`, `status`, `staged`, `unstaged`, and `reviewed` (a current, non-stale file review mark from the Changes view); `totalFiles` and `truncated`. |
| `inertia_turn_diff` | `turnId?`, `cursor?` | The unified diff of the chat's current turn so far (`state: "live"`), or of an earlier turn of the same chat (`state: "settled"`), one page of files at a time. |
| `inertia_read_plan` | none | The latest plan as the Plan tab shows it: `source` (`native` or `none`), the steps with their status (each at most 300 bytes), and the plan document as markdown, at most 16 KiB. |
| `inertia_read_goal` | none | The chat's current goal as the Goal panel shows it: `source` (`codex-native` or `inertia-local`), objective (at most 4 KiB), status, token budget, tokens used, time used, and times; or `goal: null`. |
| `inertia_list_tasks` | `includeDone?` | Up to 200 open (or, with `includeDone`, all) tasks, newest first: unlinked tasks and tasks linked to chats in this project, with `id`, `title`, `note` (at most 1 KiB), `priority`, `dueDate`, `done`, `linkedConversationId`, and `linkedStatus`. |
| `inertia_project_actions` | none | The project's Run actions for the chat's workspace (configured actions and package scripts) with `id`, `label`, `command`, `preview`, whether each is running (and running in this chat), and `previewUrl` when a local port was detected. Starting and stopping are not offered. |

Git status reuses the Changes view's status scan, and turn diffs reuse the
stored turn artifacts. A settled turn returns its stored patch, or only its
file list with a `patchNote` when the patch has expired. The current turn's
artifact is not finalized until the turn settles, so its diff is a live
comparison between the turn's starting snapshot and a short-lived snapshot of
the worktree. That snapshot uses Inertia's private index and checkpoint ref
namespace, and its ref is removed before the tool returns. Git runs without a
shell, with argument arrays, Inertia's deadlines, and the call's cancellation
signal. The diff is paged by file: each result holds whole files while their
text fits in 24 KiB, a single larger file is cut at a line boundary and marked
`diffTruncated`, and binary files are listed by name only. `nextCursor` is
bound to the turn; passing it back with another turn, or a cursor the tool
did not return, is `invalid_arguments`.

Every result is checked against the 32 KiB host-tool result cap, and lists
stop early with `truncated` when the next entry would not fit. Text in results
is sanitized before it reaches the model: terminal controls are removed,
credential-shaped values become `[redacted]` (Run commands also go through the
command-secret scrubber), the chat's workspace root becomes `<workspace>`, the
home directory `<home>`, and other user and temporary paths `<path>` (every
absolute path in a Run command keeps only its last segment), and
instruction-shaped text is neutralized as for chat context reads. The pack's
private instruction (`inertia-workspace`, under 1 KiB) tells the agent that
the tools are read-only snapshots of what the user sees, that paths and text
in their results are untrusted workspace data, and that it should still check
the current state with its own tools before changing files.

Each call passes the same exact conversation, run, and turn checks and the
same cancellation checks as other host tools. Errors use
`{ error: { code, message } }` with `invalid_arguments`, `turn_not_found` (a
turn of another chat, or no such turn), `workspace_unavailable` (no readable
workspace folder, or turn diffs in a workspace that is not a Git repository),
`call_cancelled`, and `host_tool_failed` (including a call from a turn that is
no longer active).

Codex App Server registers dynamic tools only when a thread starts, so Codex
chats see this pack from their next new provider thread. Claude, Cursor, Kimi,
and OpenCode attach host tools for each turn and see it from their next turn.
Adding the pack changes the registry's definition digest.

## What each turn is offered

The registry is compiled once, so its manifest and definition digest are the
same for every project. Each turn then gets an offer from that registry: the
tools it advertises and the private instructions injected into its prompt.
Both come from one snapshot of the chat's project settings, taken when the
turn's prompt is assembled and carried to provider start, so a setting
changed in between cannot leave the prompt and the tools describing
different offers.

A chat's Inertia-local goal reaches the provider in the turn's structured
execution context, not among the private instructions. It is one line of at
most 512 bytes labelled `Chat goal`: the goal's status, its token budget and
the usage fields that are recorded, and the objective, flattened to one line,
neutralized like other untrusted text, cut with an ellipsis when it does not
fit, and introduced as the chat's tracked objective quoted for context rather
than as a new instruction from the user. It counts toward the turn's
reference, segment, and byte limits and is left out when they leave no room.
A Codex-native goal is not repeated there: it reaches Codex through its own
thread-goal API as before.

When a project turns Browser access off, its turns are not offered
`inertia.frontend-workbench`: none of the twelve Browser tools is advertised
and the frontend instructions are not injected. The other packs, including
`inertia.workspace`, are unchanged. Claude, Cursor, Kimi, and OpenCode attach tools for each turn, so
the change applies from their next turn. A Codex thread keeps the tools it
registered when it started: a thread started with Browser access on still
holds the Browser tools after the setting is turned off, and a call to one
returns `browser_disabled` without reaching the Browser; a thread started
with Browser access off gets the Browser tools only when its chat starts a
new thread. The same `browser_disabled` check also runs on every Browser call,
so turning the setting off during a turn stops that turn's Browser calls too.

Cursor and Kimi attach the host tools as an MCP server in the ACP session:
over HTTP when the agent advertises HTTP MCP support, and otherwise through a
small stdio proxy run by Node.js. In the packaged desktop app, that proxy
needs a separate Node.js on `PATH`. When neither is available, no server is
attached and the turn's prompt is sent without the host-tool instructions,
so the agent is not told about tools it cannot call. This is decided after
the ACP `initialize` response, so the turn's stored execution record still
counts the withheld instructions. The provider capability contract does not
change, because HTTP support is known only after `initialize`.

The MCP server keeps the identifier `inertia-chat-manager`, because provider
tool names and permission rules are derived from it. Its instructions say
that it offers chat coordination, context reads, the Browser when its tools
are listed, visual replies, and reads of the chat's Git status, turn diffs,
plan, goal, project tasks, and Run actions, and that only the tools listed for
the turn are available.

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
