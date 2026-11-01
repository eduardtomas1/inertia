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
delegation, and inspection of the status and latest result, and states that
Inertia asks the user before every call that changes a chat, whatever the access mode.
Starting a child chat is explicitly not treated as evidence that its work
completed. A latest-result read on a chat that is still running returns
`result: null` with a `next` line pointing to the status tool; one whose
latest turn ended without a reply says so in `next`. An approval
the user leaves unanswered for five minutes resolves as a denial on the card
and returns `approval_timed_out` to the agent, which may ask the user to try
again. Chat and context tool arguments that fail Inertia's validation return
`invalid_arguments` with one `<field>: <problem>` line per problem and a final
line naming the tool to call again, on every provider: Claude's in-process MCP
server accepts any argument object and leaves validation to Inertia, while its
advertised schema stays Inertia's. An unknown field name is echoed as a JSON
string with every character outside printable ASCII escaped as `\uXXXX`, and a
name longer than 80 characters is cut to a complete string ending in `…`. On
Codex and the HTTP MCP bridge, a call to a tool the chat does not have lists
the tools it does have and suggests one when the name is within three edits of
it or ends in `__<tool>`; the requested name is repeated only with such a
suggestion and only when it is plain ASCII (letters, digits, `_`, `.`, `:`,
`-`). A name with control characters or Unicode line separators is rejected as
malformed, and a name that is only padded with whitespace or a byte-order mark
gets the suggestion on both transports.

Inertia host tools share an allowance of 1,024 admitted calls per turn,
including Browser inspection and interaction calls. At most eight calls may
be pending at once. A concurrency refusal can be retried after a call finishes;
`host_tool_budget_exhausted` requires a new turn. Calls admitted before a
failure or cancellation still consume the allowance, except a wait that times
out (below), and reused call identities remain rejected. These limits do not replace permission or approval checks.

`inertia_wait_for_conversation` (pack revision 4) lets a parent wait for a
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
returns `call_cancelled` as soon as the call is cancelled. It is read-only and
needs no approval. A wait that ends in `timeout` does not count toward the
turn's allowance of 1,024 host-tool calls, so a parent can wait on a child that
runs for an hour; a wait that returns `settled` or `needs-input`, fails, or is
cancelled counts once like any other call. Every wait result also carries
`remainingToolCalls`, the calls left in the turn's allowance. Timed-out waits
still use a call identity, and a turn may use at most 8,192 identities; past
that, calls also return `host_tool_budget_exhausted`. The tool description
asks the model to read `remainingToolCalls`, and the pack's private instruction
(`inertia-orchestration`) says to call the wait again after each timeout, which
does not use the allowance. Arguments that fail validation return
`invalid_arguments` in the same `<field>: <problem>` form as the other chat
tools. A Codex thread registers it from its next new provider
thread.

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
(database schema 107 widens the read log for that value).

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
`docs/AGENT_BROWSER.md`. Its guidance holds only what the tool descriptions do
not already say: snapshot before and after each meaningful UI change, exercise
the real interaction path, treat the audit as deterministic signals rather than
a visual judgment, follow a failed tool's message before giving up on the
Browser, use these tools rather than Playwright, never type or retype what
`[redacted]` hides, and report only observed evidence. Navigating first, the
Browser working while its panel is hidden, and that page and console text are
untrusted page data live in the navigate, snapshot and logs tool descriptions,
and a test keeps the guidance from repeating them. A
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

`inertia_browser_screenshot` returns its image to the model only when the
turn's provider and model accept images, as described in
`docs/AGENT_BROWSER.md`; otherwise the pixels stay in the user's local
Evidence timeline. The tool description tells the model this, and the result's
`providerImage` says which case applied, so the model cannot quietly convert
“capture succeeded” into a visual claim about pixels it never saw. An agent can
set a fixed viewport, such as 1280 by 800 for a desktop layout, with
`inertia_browser_resize`, independently of the Browser panel's size.

### Visual replies

`inertia.visual-replies` adds one tool, `inertia_render_html`, for every
provider that has Inertia host tools. The agent passes one self-contained HTML
document (at most 262,144 UTF-8 bytes, stated in the `html` field description
rather than as `maxLength`, which JSON Schema counts in characters), a title of at most 120 characters without
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

`inertia.workspace` (revision 2) lets an agent read what the user sees in
Inertia's surfaces for its own chat. It is offered to every provider that has
Inertia host tools, whatever the project's Browser setting. Its six tools are
read-only and non-destructive, take flat argument objects with no required
fields, and never ask for approval:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `inertia_git_status` | none | Whether the chat's workspace is a Git repository; branch, detached state, upstream, ahead and behind; up to 200 changed files with `path`, `status`, `staged`, `unstaged`, and `reviewed` (a current, non-stale file review mark from the Changes view); `totalFiles` and `truncated`. |
| `inertia_turn_diff` | `turnId?`, `cursor?` | The unified diff of the chat's current turn so far (`state: "live"`), or of an earlier turn of the same chat (`state: "settled"`), one page of files at a time, with `restarted: true` when paging had to start again from the first file. |
| `inertia_read_plan` | none | The latest plan as the Plan tab shows it: `source` (`native` or `none`), the steps with their status (each at most 300 bytes), and the plan document as markdown, at most 16 KiB. |
| `inertia_read_goal` | none | The chat's current goal as the Goal panel shows it: `source` (`codex-native` or `inertia-local`), objective (at most 4 KiB), status, token budget, tokens used, time used, and times; or `goal: null`. |
| `inertia_list_tasks` | `includeDone?` | Up to 200 open (or, with `includeDone`, all) tasks, newest first: tasks assigned to this project, and tasks with no project (from before tasks had one) that are unlinked or linked to a chat in this project, with `id`, `title`, `note` (at most 1 KiB), `priority`, `dueDate`, `done`, `linkedConversationId`, and `linkedStatus`. |
| `inertia_project_actions` | none | The project's Run actions for the chat's workspace (configured actions and package scripts) with `id`, `label`, `command`, `preview`, whether each is running (and running in this chat), and `previewUrl` when a local port was detected. Starting and stopping are not offered. |

Git status reuses the Changes view's status scan, and turn diffs reuse the
stored turn artifacts. A settled turn returns its stored patch, or only its
file list with a `patchNote` when the patch has expired. A turn that has just
ended may still be capturing its changes; the tool then waits up to 5 seconds
for that capture, within the call's cancellation, and otherwise answers that
the changes are still being captured. The current turn's artifact is not
finalized until the turn settles, so its diff is a live comparison between the
turn's starting snapshot and a short-lived snapshot of the worktree. That
snapshot uses Inertia's private index and checkpoint ref namespace, and its
ref is removed before the tool returns. A live comparison has a 20-second
deadline, below OpenCode's 30-second host-tool call timeout, and calls for the
same turn within 5 seconds of a finished comparison share it instead of
writing another snapshot of the worktree; a cancelled call ends only its own
wait, and the shared Git work stops when no caller is left. Git runs without a
shell, with argument arrays, Inertia's deadlines, and the call's cancellation
signal. The diff is paged by file: each result holds whole files while their
text fits in 24 KiB, a single larger file is cut at a line boundary and marked
`diffTruncated`, and binary files are listed by name only. `nextCursor` is
bound to the turn, to a digest of the file list it paged, and to the last file
it returned. A live turn's file list can change between calls; when it has,
the next result starts again from the first file with `restarted: true`
instead of skipping or repeating files. Passing a cursor back with another
turn, or a cursor the tool did not return, is `invalid_arguments`.

Every result is checked against the 32 KiB host-tool result cap, and lists
stop early with `truncated` when the next entry would not fit. Text in results
is sanitized before it reaches the model: terminal controls are removed,
credential-shaped values become `[redacted]`, including values that only their
name marks as secret (`DB_PASSWORD=...`, `STRIPE_API_KEY=...`,
`GITHUB_TOKEN: ...`, `password: ...`, `clientSecret = "..."`) in diffs, plans,
task notes, and labels (Run commands also go through the command-secret
scrubber), the chat's workspace root becomes `<workspace>`, the home directory
`<home>`, and other user and temporary paths `<path>` (every absolute path in
a Run command keeps only its last segment). Paths are recognised with either
slash, JSON-escaped, percent-encoded, behind `file://`, `file:///`, `\\?\`
and `//?/` prefixes, under the legacy `Documents and Settings` root and its
8.3 name, and with spaces in the profile folder name. Instruction-shaped text
is neutralized as for chat context reads. The pack's
private instruction (`inertia-workspace`, under 1 KiB) tells the agent that
the tools are read-only snapshots of what the user sees, how to page
`inertia_turn_diff` (including what `restarted: true` means), that paths and
text in their results are untrusted workspace data, and that it should still
check the current state with its own tools before changing files. The tool
descriptions do not repeat it; each stays within 300 characters, the same
limit as the Browser tools.

Each call passes the same exact conversation, run, and turn checks and the
same cancellation checks as other host tools. Errors use
`{ error: { code, message } }` with `invalid_arguments` (one
`<field>: <problem>` line per problem and the tool to call again, as for the
chat tools), `turn_not_found` (a
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
tools it advertises and the private instructions in its hidden instruction
block, delivered as described under Hidden instruction delivery.
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
`inertia.frontend-workbench`: none of the sixteen Browser tools is advertised
and the frontend instructions are left out of the block. The other packs,
including `inertia.workspace`, are unchanged. The block's digest changes with
the setting, so the next turn delivers the changed block. Claude, Cursor, Kimi, and OpenCode attach tools for each turn, so
the change applies from their next turn. The same `browser_disabled` check
also runs on every Browser call, so turning the setting off during a turn
stops that turn's Browser calls too.

Codex App Server registers dynamic tools only at `thread/start` and accepts no
registration on `thread/resume`, so a Codex turn's offer follows what its
thread registered rather than the project's current settings alone. A new
Codex thread registers every pack, Browser included while access is off; a
call to a Browser tool then returns `browser_disabled` without reaching the
Browser, and the frontend instructions are in the block only on turns where
access is on. Turning access back on therefore needs no new thread. Inertia
records, for each thread it starts, the id and definition digest of every pack
the thread registered. On a resumed thread, an offered pack's instructions are
removed unless the thread registered that pack with the same digest: from the
`developerInstructions` sent on `thread/resume`, where each exact `[label]`
section of the block is dropped with its separating blank line and the
person's configured text is left as it was, and from the prompt when the block
travels there, including when an unreadable `config/read` moves it there, so
a thread started before `inertia.workspace` existed, or before a pack's tools
changed, is not told about tools it cannot call; those tools
arrive with the chat's next new thread. The record is kept in the database
(schema 109, `codex_thread_tool_packs`: the thread id, each pack's id and
digest, and when it was registered), keyed by the same thread id the chat
stores as its provider session, so a resumed chat keeps its instructions after
the app restarts. A registration replaces any earlier one for the same thread,
and registrations of threads no chat resumes from are pruned once they fall
outside the newest 1,024. The thread id is treated as untrusted text: up to
512 characters without control characters, or it is not recorded. A recent
registration is also cached in memory, and if the database cannot be written
or read, that cache decides for the rest of the runtime. For a resumed thread
without a record (one started by an earlier build), only the frontend
workbench's instructions and the `inertia-chat` line are kept, because every resumable Codex thread
registered the Browser tools; the other packs' instructions return with the
next new thread.

Cursor and Kimi attach the host tools as an MCP server in the ACP session:
over HTTP when the agent advertises HTTP MCP support, and otherwise through a
small stdio proxy run by Node.js. In the packaged desktop app, that proxy
needs a separate Node.js on `PATH`. When neither is available, no server is
attached and the turn's prompt is sent without the host-tool instructions
and the `inertia-chat` line, so the agent is not told about tools it cannot call. This is decided after
the ACP `initialize` response, so the turn's stored execution record still
counts the withheld instructions. The provider capability contract does not
change, because HTTP support is known only after `initialize`.

The MCP server keeps the identifier `inertia-chat-manager`, because provider
tool names and permission rules are derived from it. Its `initialize` result
carries no instructions: the hidden instruction block and the tool
descriptions say what the tools do.

## Hidden instruction delivery

A turn can carry four kinds of hidden instructions: the capability-pack
instructions, an `inertia-chat` line that tells the agent its chat's id, the
`build-mode` instruction, and turn-specific controls such as watcher notes,
runtime-interruption notes and caller controls. The packs and the chat line
form one block of `[label]` sections joined by blank lines, byte-identical on
every turn of a session. The block is sent only when the turn has attested
Inertia host tools; watchers, custom backends and resumed imported Codex
sessions never receive it. The rule lives in
`src/server/runtime/turns/turn-instruction-delivery.ts`.

- Claude and Codex receive the block at system level
  (`ProviderRunInput.sessionInstruction`) when it fits the 16 KiB system
  instruction limit, on ordinary turns and on manual compaction. Claude
  appends it to the `claude_code` preset system prompt, recorded with
  `snapshot: true`. Codex sends `developerInstructions` on `thread/start`,
  `thread/resume` and the compaction resume (App Server v2 accepts
  `developer_instructions` on both). That value replaces a
  `developer_instructions` setting from the person's Codex configuration,
  so Inertia first reads it through `config/read` (bounded to 3 seconds) and
  sends the configured text, a blank line, then the block. When the read
  fails or times out it sends no `developerInstructions`, so the person's own
  Codex instructions stay in force: the block rides in that turn's prompt
  under the internal-instructions header, the ledger forgets the turn's
  digest so later turns follow the prompt rule below, and a
  `provider.session-instructions-deferred` diagnostic records it. The
  value is the same on every call while the configured text stays the same.
- A turn that sends the block at system level records the block's SHA-256
  digest, never its text, in its execution manifest as
  `sessionInstructionDigest`. Codex keeps what a session started with, so a
  resumed Codex session gets the block in the prompt instead, by the rule
  below, when the session's first turn recorded no digest or another digest
  (a session started before this delivery, before host tools were attested,
  or with other pack text), or when a compaction was recorded on the chat
  since that first turn. Claude records its system prompt again when it
  compacts, so for Claude the latest compaction counts as the session's
  start: the turn it happened in (for a compaction receipt, the latest turn
  before it) must have recorded the current digest.
- Cursor, Kimi and OpenCode get the block in the prompt's
  internal-instructions section. OpenCode has a `system` prompt option, but
  a follow-up steered into a running turn cannot carry it, so the block
  would drop out for the rest of that run; watcher roles still use it. The
  block is sent on the first turn of a provider session, when its digest
  changes, after a compaction, and once after the runtime restarts. The
  runtime remembers, per chat and in memory only, the turn that last
  carried the block and its digest, for the 1,024 most recently used chats;
  the block counts as delivered while that turn completed on the session
  being resumed, started on or resumed that same session, and had no
  compaction recorded since. A successful manual compaction forgets the
  chat's record even when its receipt could not be saved.
- `build-mode` goes in the prompt on the first turn of a provider session,
  and again when the previous turn used another mode, did not complete,
  started on another session than it ended on, sent no prompt, or was
  followed by a compaction. A native Codex goal start sends no prompt; its
  manifest records `promptWithheld`, so the next turn sends `build-mode` and
  the goal start never counts as having delivered the block. Plan mode has
  no instruction.
- A compaction is a saved compaction receipt or a completed compaction
  activity from the provider (Claude's compact boundary or compacting
  status, Codex's `contextCompaction` item, the ACP compaction update,
  OpenCode's session compaction event), recorded at or after the turn's
  request time. A failed Claude compaction closes its status row as failed
  and does not count. The check scans the chat's compaction receipts and
  the activities recorded since the session's first turn, so its cost grows
  with the session's activity count.
- A turn that starts a fresh session, including a stale session restarted
  in the middle of a turn, always carries the block (system level or
  prompt) and, in Build mode, `build-mode`.
- Turn-specific controls accompany every turn that needs them. A prompt with
  nothing due has no internal-instructions section and no trailing blank
  lines.
- After an upgrade that changes the block, a Claude or Codex session can
  receive it both at system level and once per runtime in the prompt, and
  after a compaction a Codex session can too; this duplicate is accepted.

Not verified against live providers: whether an older Codex that ignores
`developerInstructions` on `thread/resume` keeps the start value after its
own compaction.

## Minimum provider versions

Discovery refuses a Claude Code or OpenCode installation older than its
security floor. The floors, the reason each one exists, Antigravity's headless
floor and the OpenCode 2 ceiling are defined together in
`src/server/provider/provider-version-floors.ts`.

| Provider | Supported | Why |
| --- | --- | --- |
| Claude Code | 2.1.309 or newer | Inertia passes `managedSettings` with `disableAllHooks` and `disableSkillShellExecution`; Claude Code before 2.1.309 dropped host-supplied managed settings, so those hook and skill-shell restrictions silently did not apply. 2.1.309 also carries the fixes for GHSA-5j29-h97v-84ch (a symlink race lets writes escape the project; fixed in 2.1.129) and GHSA-pq7j-f95f-qfcv (a plugin pinned-commit bypass; fixed in 2.1.179). |
| OpenCode | 1.18.22 or newer, below 2 | GHSA-632h-h47v-g4x4: a cross-site request to `/global/upgrade` on `opencode serve` installs arbitrary packages (fixed in 1.18.22). The random basic-auth password Inertia gives its owned server reduces this risk but does not remove it. OpenCode 2 is not supported yet. |
| Antigravity | 1.2.2 or newer | First release with the headless stream-json contract below. |

Below a security floor, discovery runs only the version probe. It never runs
OpenCode's `serve --help` probe, never checks sign-in and never starts the
OpenCode isolation-proof server. The detection reports the executable and
version with `installState: "installed"`, `authState: "unknown"`,
`canRun: false`, `updateRequired: { installedVersion, minimumVersion }` and a
status message naming both versions, the reason and the fix, for example
*Claude Code 2.1.150 is installed. Inertia needs 2.1.309 or newer because
older versions ignore the restrictions Inertia sets and can write outside the
project. Update Claude Code and refresh.*
Antigravity below 1.2.2 reports `updateRequired` too when its version is
known, for the newest identified `agy` install, the same one whose executable
and version the detection reports, and its message ends *Run 'agy update' and
refresh.*

The provider manager refuses again at each later use of that installation,
with the same message and before anything is spawned: sign-in launch, model
and usage discovery (OpenCode's starts `opencode serve`), Claude skill
discovery and terminal resume. Provider maintenance does not go through these
paths, so it can still update the installation.

`updateRequired` travels in the provider snapshot. Settings → Agents shows
*Update required* and Refresh instead of a sign-in. The composer refuses every
route on that harness, API-key and custom backends included, with *Update
needed* and the discovery message. Backend readiness refuses external routes
with the same message, so watcher routes and Private Connect prompts, which
reuse native `canRun` and backend readiness, refuse with it as well.
Maintenance still offers Update for the identified installation.

Claude Code and OpenCode versions compare as semantic versions on the token
read from the version line of `--version` stdout, such as `2.1.309` from
`2.1.309 (Claude Code)`, `1.18.26` from `opencode 1.18.26` or `1.19.3` from
`1.19.3 (abc123)`. A warning printed before that line, such as a Node
deprecation naming `v22.1.0`, is ignored; only output with no such line falls
back to the first dotted number. A missing
patch counts as 0 and build metadata is ignored. A prerelease sorts below its
release, so `2.1.309-beta.1` is below the Claude Code floor and
`2.1.310-beta.1` is above it. A version Inertia cannot parse keeps today's
behaviour and is not blocked by a floor: a development build that prints
`local`, a pattern such as `2.1.x`, or a snapshot that reports `0.0.0-…`,
such as an OpenCode snapshot build. Antigravity keeps its original comparison,
which blocks an unknown version and `0.0.0` builds.

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

A watcher is a conversation linked to a watched chat (see
[the user guide](user/watcher.md)). It runs on a harness listed in
`WATCHER_HARNESS_IDS` in `src/shared/watcher.ts`, checked through
`watcherHarnessAllowed`; every current provider's native harness is listed.
The person chooses its access when attaching it (`watcher.attach` payload
`readOnly`, absent means read-only), and the choice is stored in
`watcher_links.read_only` (schema 101, `PersistWatcherAccess`; links created
before it stay read-only):

- **Read-only.** The watcher chat is created in Plan mode with Supervised
  access, and turn preparation sends `readOnlyProfile: "watcher"`. How the
  harness holds the watcher read-only is its tier,
  `watcherReadOnlyEnforcement(harnessId)` over
  `WATCHER_READ_ONLY_ENFORCEMENT`. A harness without a tier (`null`) can't be
  attached read-only; the attach, the repository and every turn refuse it.
- **Chat access.** The watcher chat is created with the requested interaction
  mode and access mode (passed through `effectiveAccessMode`, so Supervised on
  Antigravity becomes Auto-accept edits as for any chat). It is an ordinary
  chat for `conversation.update`, mode, access, reasoning and fast mode;
  only the harness must stay in the list. Its checks have no read-only
  profile: approvals and questions become ordinary cards in the watcher
  chat, and while one is pending the dock's live phase is `"approval"` or
  `"question"`; checkpoints and
  turn artifacts are taken as for any chat, the Git fingerprint guard is
  skipped (guard state `"skipped"`) and write attempts are not counted.
  Watcher notes and goal starts are refused in any watcher chat, and restart
  continuation skips watcher chats.

| Harness | Tier | Read-only profile |
| --- | --- | --- |
| `claude-agent-sdk` | `inertia` | `permissionMode: "default"`, never `"plan"` and no `planModeInstructions`: Claude Code's own plan-mode wrapper tells the model to write a plan file and end with `ExitPlanMode` or `AskUserQuestion`, which a check must not do. Claude Code runs Read, Grep, Glob and LS inside the working directory without asking, and the few Bash commands it treats as read-only. Every other call reaches Inertia's permission broker, which decides it in `claude-watcher-permissions.ts`: Bash through the command allowlist with POSIX rules (Claude Code's Bash runs Git Bash on Windows), a `PowerShell` tool call with the Windows rules; Edit, Write, MultiEdit and NotebookEdit are declined as write attempts; `AskUserQuestion` is denied at once and not counted; `ExitPlanMode` (whose plan is still recorded), `EnterPlanMode`, Task, Agent, WebFetch, WebSearch, MCP and unknown tools are declined and not counted as writes; a routed read is allowed only inside the workspace's real path, and a Read, Grep or Glob whose path, Grep `glob` or `type`, or Glob pattern names an environment file is declined (a Grep or Glob that names no such file can still list or search one that ripgrep does not skip). |
| `codex-app-server` | `inertia` | `approvalPolicy: "untrusted"` with the read-only sandbox and no network, forced by the profile whatever access the input names, and file changes are never auto-approved. No plan collaboration mode. Watcher threads, started or resumed, disable the user's MCP servers, apps, plugins, hooks, subagents, web search and `tools.experimental_request_user_input` through the thread's `config`. Codex runs its known-safe read commands in the sandbox; anything else is an approval, which is declined. |
| `opencode-sdk` | `inertia` | The ordinary agent, not the native `plan` agent (which may edit `.opencode/plans` and call `plan_exit`), with the session ruleset `* deny`, `bash ask`, `read`, `glob`, `grep`, `list` and Inertia host tools `allow`, and `read` of `.env`, `*.env` and `*.env.*` denied. The question tool falls under `* deny`. A shell command reaches OpenCode's permission request with its full text; Inertia answers `once` when it passes the allowlist and declines it otherwise. OpenCode's own `bash` patterns are not used as the allowlist, because OpenCode 1.19.2 matches them against the text including redirections. |
| `cursor-acp` | `approvals` | Cursor's native plan mode. Every permission request reaches Inertia, which declines it with ACP `reject_once`; edit, delete and move requests count as write attempts. `cursor/ask_question` is cancelled and `cursor/create_plan` answered `rejected` without counting, each with a status row in the watcher chat; the plan is recorded as a hand-off and becomes the finding when the reply only hands it off. An edit tool call announced as `pending` before its permission request does not stop the check; one reported `in_progress` does. |
| `kimi-acp` | `approvals` | Kimi Code's native plan mode, with the same approval and edit handling. A question that arrives as a permission request is cancelled with a status row and not counted. A plan hand-off (`ExitPlanMode`) is recorded as a hand-off with the request's text first and then answered with its `plan_revise` reject option, with a status row and not counted. |
| `antigravity-cli` | `provider` | `--mode plan`, never `--mode accept-edits` or `--dangerously-skip-permissions`. Antigravity has no approval channel and no host tools, so it can't read more of the watched chat than each check sends. |

The read-only checks are made when a watcher is attached, when every watcher
turn is prepared (including a message the person types into the watcher chat)
and when `conversation.update` changes a read-only watcher's configuration;
there a model change stays allowed and a mode or access change is refused.
Per-harness facts live in one place per adapter: the broker decisions in
`claude-watcher-permissions.ts`, the thread config in
`codex/read-only-thread-config.ts`, the ruleset in `opencode-host-tools.ts`,
the ACP decline rows in `acp-watcher.ts`, Antigravity's arguments and
file-writing tool names in `antigravity-stream.ts`, and which harnesses take a
system-level instruction or gate edits before they start in
`provider/watcher-harness-profile.ts`. An unknown harness falls back to the
safe defaults there.

What is not verified against live providers: whether Cursor and Kimi Code ask
permission for plain reads in plan mode (each such request would be declined
and count towards the five-request cap); Antigravity's tool names beyond the
`view_file`, `run_command` and `invoke_subagent` its fixtures use (the
file-writing names `write_to_file`, `write_file`, `create_file`, `edit_file`,
`replace_file_content`, `multi_replace_file_content`, `delete_file`,
`move_file` and `rename_file` are assumed); and whether Antigravity's plan
mode refuses writes on its own. Codex App Server v2 accepts
`developerInstructions` on `thread/resume` as on `thread/start`.

### Read-only command allowlist

`classifyReadOnlyCommand` in `src/server/runtime/watcher/read-only-commands.ts`
is Inertia's own allowlist for Claude and OpenCode watchers; Codex keeps its
sandboxed known-safe set, and Cursor, Kimi Code and Antigravity have none,
which their instructions say. It never runs anything. Its context names the
shell that runs the command, not the host: `windows: true` applies the cmd.exe
and PowerShell rules (Claude's `PowerShell` tool, and OpenCode on Windows),
`windows: false` the POSIX rules (Claude's Bash, which is Git Bash on
Windows), and `windowsPaths` the host's path rules for containment. It splits
the command and refuses redirection (under POSIX rules a whole `2>/dev/null`
or `2>&1` word after the program is allowed), chaining, background jobs,
command and variable substitution, subshells, brace, home and equals
expansion, comments, unquoted backslashes, control characters, Unicode
quotes, dashes and spaces, PowerShell's `--%`, and unbalanced quotes. Under
POSIX rules a double-quoted backslash keeps its shell meaning: `\"`, `\\` and
`\$` stand for the character, any other backslash stays literal, and an
unescaped `$` is still refused. Under Windows rules it also refuses `%`, `^`,
`,`, `"`, `\` and `&`, `|`, `<`, `>` anywhere except a plain pipe, empty
arguments, and any `:` in a path argument other than a drive letter. These
rules keep out cmd.exe expansion, PowerShell provider paths such as `env:`,
and Windows PowerShell's legacy argument passing, which can split an argument
that contains a quote or ends in a backslash. OpenCode's shell can be
PowerShell on any platform, so OpenCode watchers also refuse unquoted commas,
which PowerShell turns into separate arguments, an unquoted `@` at the start
of a word, which PowerShell treats as splatting, and any backslash inside
double quotes. A pipe is allowed only when every segment is. A word whose
first character is an unquoted glob, or an option word with a glob before
any `=`, is refused, because the shell could expand it into an option-shaped
file name; `./*.ts`, `src/*.ts` and `--include=*.ts` are allowed. The
programs are read-only `git` subcommands (only `-C`, `--no-pager`,
`--no-optional-locks` and `-c core.pager=cat` as global options; `--output`,
`--ext-diff`, `--textconv`, `--show-signature`, the `%G` and `%(signature)`
format placeholders, `git grep -O`, `--no-index`, `--untracked` and
`--no-exclude-standard` and their abbreviations refused), `rg` without
`--pre`, `--hostname-bin`, `-z`/`--search-zip`, `-L`/`--follow`,
`--hidden`/`-.`, `-u`/`--unrestricted` or any `--no-ignore` option, `grep`,
`egrep` and `fgrep` without recursion (`-r`, `-R`, `-d`, `--directories`),
`cat` (without PowerShell's `-Wait`), `head`, `tail` without follow
(including the obsolete `+Nf` form), `sed` only as `sed -n '<range>p'` or
`sed -n '<range>p;<range>p'` followed by files (a range is `N`, `$`, `N,M` or
`N,$`; no `-i`, no other option and no other command, so `w`, `W`, `r`, `R`,
`e` and `s` never run), `ls` without `-L`/`--dereference`, `find` without
`-L`, `-follow`, `-exec`, `-ok`, `-delete`, `-fprint` or `-files0-from`
forms, `wc` without `--files0-from`, `diff` without `-r` or `-l`, `stat`,
`file` without `-C`, `-z`, `-Z` or `-f`/`--files-from`, `tree` without `-o`,
`-R` or `-l`, `sort` without `-o`, `-T`, `--compress-program` or
`--files0-from` (the `files0-from` and `files-from` options read the names of
further files from a file, which neither containment check sees), `uniq`
with at most one file and no glob, `cut`, `nl`, `tr`, `column`, `jq` without
environment access, program files, modules or extra input files (`-f`, `-L`,
`--rawfile`, `--slurpfile`, `import`, `include`, `modulemeta`), `pwd`,
`which` and `echo`. An argument that is absolute, starts with `~` or contains
a `..` segment must stay inside the workspace, and so must every suffix of a
short-option bundle after its first letter, so `grep -nf/etc/passwd` and also
`grep -nfsrc/patterns` are refused while `grep -nf src/patterns` is allowed.
Because that check is lexical, Claude's broker and OpenCode's permission
handler then resolve every argument and option value that names an existing
path with `realpath`, after expanding its wildcards against the directory
listing (quoted wildcards too under Windows rules and wherever the shell may
be PowerShell), and decline the command when one resolves outside the
workspace's own real path, so a symbolic link or junction inside the
workspace cannot lead a read outside it. A command whose wildcards reach more
than 4,096 paths is declined. `.env`, `*.env` and `*.env.*` names are refused
in any letter case wherever they appear in an argument, except in the search
pattern of `rg`, `grep`, `egrep`, `fgrep` and `git grep`: the first
positional word when no `-e`, `--regexp`, `-f` or `--file` supplies the
pattern, and every `-e` or `--regexp` value. A pattern such as
`process.env.API_URL` is therefore allowed, while a path operand or a `-f`
pattern file with such a name is refused. A path operand with a wildcard is
refused unless its last segment ends in a literal extension other than
`.env`, so `src/*.ts` is allowed while `config/*`, `*.e*`, `prod.en?` and
`prod.[e]nv` are refused. When an option before the pattern is not one the
classifier knows, no word is treated as the pattern. A command is capped at
4,096 characters and 256 arguments. An allowed command runs without an
approval and counts towards the receipt's command count; a declined one is a
`command-attempt`.

Every refusal the broker returns to Claude carries the allowlist's reason
followed by `readOnlyCommandReminder(shell)`, a one-line list of the allowed
commands and the quoting rules of that shell, so the model can switch to an
allowed form instead of seeing only "User declined tool execution". Codex's
app-server decline (`decision: "decline"`) and ACP's `reject_once` have no
field for a reason, so those providers get none; the watcher chat still
records each decline.

Claude and OpenCode watcher runs set `GIT_OPTIONAL_LOCKS=0`, so `git status`
leaves `.git/index` alone; `git diff` and `git describe --dirty` still
refresh the index after a file's timestamps change (measured with Git 2.54)
and can hold `index.lock` for that moment. They also drop
`RIPGREP_CONFIG_PATH`, in any letter case, from the provider's environment,
so a ripgrep configuration file cannot add `--pre` to a plain `rg` search. On
Claude the broker also returns each allowed command with `--no-config`
inserted after every `rg`, so a shell startup file that sets the variable
again is ignored as well. OpenCode's permission reply cannot change the
command, so OpenCode watchers rely on the environment alone. Known limits:
the real-path check runs just before the command does, so a link created in
between is not seen; a search reads any workspace file its pattern reaches
except files that Git's or rg's ignore rules skip, so a tracked or unignored
secret file can be read; programs still honor their own configuration (a
`diff.external`, textconv, `core.fsmonitor`, `gpg.program` or
`log.showSignature` setting in Git config, a `RIPGREP_CONFIG_PATH` that
OpenCode's shell startup files set again, or one that applies to an `rg`
command Claude Code runs on its own read-only rules without asking the
broker, jq's `~/.jq`, or aliases and functions that OpenCode's shell loads),
which only someone who can already write that configuration can set.

### Why an allowlist and not a capability id

Watcher support is not a `PROVIDER_CAPABILITY_IDS` entry. Adding an id changes
every harness's capability manifest and therefore its attestation digest.
`providerContinuationCompatibilityToken` returns that digest as the
continuation identity, so a new id would make every existing chat lose native
session resume on upgrade. The harness list and the tier table are ordinary
reviewed code: changing them is a code change that lands with its portable
fixture, and it leaves manifests and continuation tokens untouched.

### Enforcement layers for a read-only watcher

Each layer works on its own; none relies on the model following instructions.

1. **Mode and access pinned.** A read-only watcher conversation is created
   with `interactionMode: "plan"` and `accessMode: "supervised"`. Turn
   preparation refuses a read-only watcher turn that is not plan, supervised
   and on a harness with a tier, and `conversation.update` refuses mode and
   access changes. The provider sees plan mode only on the `approvals` and
   `provider` tiers; on the `inertia` tier the adapters translate the profile
   into the settings in the table above.
2. **Fail-closed interactions.** Approval requests are declined through the
   provider's own deny decision and recorded as a visible activity. No
   approval card is broadcast. A declined edit request (a `file-change`
   approval, or a `permissions` approval asking for write access) is recorded
   as a `write-attempt` and the turn continues; any other declined request is
   a `command-attempt`. The fifth declined request in one check
   (`READ_ONLY_WATCHER_MAX_DENIALS`), or a request without a deny option,
   stops the check. A question that still reaches Inertia stops the check;
   Claude's questions are denied with a reason, Codex's question tool is off,
   and OpenCode's is denied by its ruleset, so on those it should not occur.
3. **Real-time activity guard.** An activity the adapter marks
   `fileMutation` because an edit is actually executing (an ACP tool call of
   kind `edit`, `delete` or `move` reported `in_progress`, or an Antigravity
   file-writing tool) cancels the provider run and settles the turn as
   failed with "Watchers are read-only. Inertia stopped this check." The
   outcome is `write-attempt`. On harnesses whose edits wait for an approval
   Inertia declines (`editsGatedBeforeStart` in `watcher-harness-profile.ts`:
   Claude, Codex, Cursor and Kimi Code) that is the only trigger, because
   those providers announce an edit before they ask for its approval: Claude
   streams an Edit tool's start before `canUseTool`, Codex sends
   `item/started` for a file change before its approval request, and ACP
   agents send a `pending` tool call first. A declined edit there is
   recorded as a `write-attempt` and the check continues; the fingerprint
   guard backs it up. On OpenCode and Antigravity a started `file` activity
   or an activity in the `coding` category also stops the check. Write
   attempts are counted per watched turn, whether declined or stopped: the
   second pauses the link with `write-attempts` and stops the check. A
   started `command` activity does not stop the turn.
4. **Git fingerprint backstop.** `src/server/git/checkout-fingerprint.ts`
   fingerprints the checkout before and after each check through
   `runGitInspection` (`--no-optional-locks`, `core.fsmonitor=false`):
   `rev-parse --verify -q HEAD`, `symbolic-ref -q HEAD` (so a branch switch at
   the same commit counts as a HEAD move), a bounded `status --porcelain=v2 -z
   --untracked-files=all --no-renames --ignore-submodules=dirty`, and
   `hash-object --no-filters` for changed and untracked paths, batched to at
   most 24 K characters of arguments for Windows. Every filter driver that the
   repository's config names has its `clean`, `smudge` and `process` commands
   blanked and `required` set to false through `-c` for `status` (more than 64
   drivers make the fingerprint unavailable), and `--no-filters` keeps them
   out of `hash-object`, so no repository filter runs.
   `--ignore-submodules=dirty` leaves submodule worktrees to their own
   fingerprints: each initialized submodule that `.gitmodules` lists inside the
   checkout (at most 16) is fingerprinted the same way with its own filters
   disabled, so uncommitted edits inside it count. Ignored files, `.git`
   internals such as hooks, config and other refs, and submodules nested
   inside submodules are not fingerprinted. More than 2,000 paths or 64 MiB of
   hashed bytes in all marks the fingerprint truncated. A changed path is
   *explained* when another turn active on the same checkout reported it in a
   file activity during the window. The result is *inconclusive*, and does not
   pause, when another active turn ran a command, a workspace or
   source-control run was active, a terminal resume was active, or the
   watcher's own turn had no activity that could write (no command outside the
   read-only command allowlist and no started edit; `watcherActivityMayWrite`,
   which classifies the command text a harness records in the activity's
   `Command:` detail, or the title when there is none, after unwrapping a
   shell wrapper such as Codex's `/bin/zsh -lc '…'`; on a Windows host a
   command counts as read-only when it passes either the POSIX or the Windows
   rules, since the activity does not say which shell ran it). An
   inconclusive check keeps its finding and records its unexplained paths on
   the feed item (`guardPaths`). Unexplained paths in a conclusive window
   pause the link with `write-detected` and list at most 20 paths. A
   non-repository, a timeout or a truncated fingerprint is *unavailable*; the
   other layers still apply.
5. **Boundary instruction.** The `inertia-watcher` instruction states that the
   watcher is read-only and how its tier enforces it.

Read-only watcher turns also skip checkpoints and turn Git artifacts entirely,
so they never write `refs/inertia/checkpoints/*`, never run `git write-tree`,
and never offer a Revert that could undo the watched chat's work. For every
watcher, capability-pack instructions are not sent and the orchestration and
Browser tools are not offered. The watcher's only host tool is the context
tool, with a fourth access kind, `"watched"`, that reads the watched chat
without a route filter and without the approval chooser, bounded by
`contextReadsPerWake` (default 4). The link's sharing choices bound those
reads as they bound each check: with `brief` off the tool returns no user
requests (and no request images), with `activities` off no commands, tool
calls or errors, with `partialReplies` off no agent messages or pages, and
with `changedFiles` off no file lists.

### Hidden instructions and the digest

- `inertia-watcher` carries the role and boundary, the preset, the person's
  instructions quoted as user-authored, the output format and the rule to
  answer exactly `SILENT` when there is nothing to report, followed only by
  the `Resolved: check N` line when an earlier finding is now fixed. For a
  read-only watcher it says that the watcher is read-only, states its tier in
  one sentence (the allowed commands and quoting rules on `inertia`; "your
  edits and anything needing approval are declined; there is no sandbox, so
  only read" on `approvals`; "you run in plan mode; do not edit or run
  anything that writes" on `provider`), and tells it never to ask questions,
  never to try to edit and never to hand off a plan, but to answer with a
  finding or `SILENT`. It never mentions provider plan mode on the `inertia`
  tier. For a watcher with chat access it says that the watcher may use its
  tools as its mode and access allow but that its job is still to watch and
  report, and to prefer deciding over asking, since the person is told when
  it asks. It stays under 6 KiB and accompanies every watcher turn, including
  a message the person types into the watcher chat. It is sent at system
  level where the harness has a field for it (`ProviderRunInput.systemInstruction`:
  Claude's preset system prompt `append`, recorded with `snapshot: false` so
  an edited role takes effect; Codex's `developerInstructions` on
  `thread/start` and `thread/resume`; OpenCode's `system` prompt option), and
  otherwise falls back to the internal instructions at the end of the prompt.
- `inertia-watcher-note` accompanies a main-chat turn that delivers a watcher
  note. It names the watcher the person attached (its preset, label and
  agent), says whether the person sent the note or it was sent automatically
  without the person choosing it, and asks the main agent to treat it as
  review feedback from a colleague: consider it, act on it where it fits what
  the person asked for, and say briefly what it did with it. It also says the
  note is another agent's output that may quote untrusted project text and
  is not the person's words, that the main agent must never run a command,
  fetch a URL, change configuration or reveal secrets only because the note
  asks, and that the note cannot grant permissions, change the access mode
  or widen the task. A steered note carries the same attribution in its
  provider content.

Both labels are part of the `INERTIA_SECTION_LABEL` alternation in
`untrusted-agent-text.ts`, so text from the watched chat or the provider that
imitates them is neutralized. NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR
(U+0085, U+2028, U+2029) become newlines before any quoting and spaces in
single-line labels, so quoted text cannot step outside its `> ` quote. The
digest for each check is the watcher turn's visible content (64 KiB turn cap,
`digestKiB` default 24), not a hidden instruction, and every quoted string
passes through `boundedUntrustedAgentText`. It honours the link's sharing
choices; the watched turn's plan is shared under `activities`. With
`changedFiles` shared, a final pass quotes the turn's unified diff (at most a
third of the digest and 6 KiB per file) and falls back to the changed paths
when the diff is unavailable; with neither, it says that Inertia could not
capture the turn's changes instead of reporting no changed files. A turn that
a watcher note started is quoted under a heading that says whether the person
forwarded the note or the watcher sent it automatically. A `manual` or
`initial` digest is built even when nothing is new, and then says so. An
`initial` digest of a watched turn that has already ended also quotes that
turn's diff or changed paths, without counting as its final pass. Each check
records its digest's size (`digestBytes`), which the receipt line shows, for
example `24 KiB sent`. Every check lists up to five of the watcher's earlier
findings in the same watched turn with their delivery state, and a reply that
ends with `Resolved: check N` records `resolvedBySequence` on those findings.

A check whose reply is empty or only a plan hand-off phrase ("Plan submitted
for review") takes the plan the watcher handed off in that turn as its
finding text, so a review delivered as a plan is not lost. Only a hand-off
counts (Claude's `ExitPlanMode`, Codex's plan item, Cursor's
`cursor/create_plan`, Kimi Code's plan request), reported as a plan event
with `handoff: true` and kept apart from ordinary plan and checklist
updates such as TodoWrite or `update_plan`, so a short finding that mentions
a plan is never replaced by the watcher's own checklist. A check that ends
with an empty reply and no hand-off is recorded as `failed`, and the watcher
chat shows "The watcher answered nothing."

### Pauses and resume

A paused link records its reason. A wake whose route fails the
`watcherRouteReadiness` preflight (selection, harness list, backend readiness,
a runnable provider) retries as transient with the scheduler's backoff at
most `WATCHER_ROUTE_RETRY_LIMIT` (3) times; the next failure pauses the link
with `route-unavailable`, a detail that names the route and the readiness
message, and a `watcher.link.updated` broadcast. The retry count starts again
when a check finds its route ready or the link resumes. A check whose watcher
turn fails to queue (for example when path authority refuses the shared
checkout) is recorded as `failed`; the `WATCHER_DISPATCH_FAILURE_LIMIT`-th
(3rd) consecutive failure pauses the link with `route-unavailable` instead of
retrying with backoff forever, and that count starts again when a check's
turn queues or the link resumes. A `wake-budget` pause belongs to one watched
turn: the next watched turn ends it and grants a fresh allowance. A final
pass always digests the turn that ended (`turnId` on the digest), even when
the next turn already began, and never spends the next turn's allowance; the
cursor update is a compare-and-set on the turn the digest was built from, so
a late check never rewinds coverage. `usage-limit` and `route-unavailable`
resume only once `watcherRouteReadiness` reports the watcher's route ready,
and no link resumes while its watched chat or its own chat is archived,
whatever its pause reason. Every resume refills the turn's check allowance to
`wakesPerWatchedTurn`. A final pass that ends usage-limited stays due, so it
runs once the link resumes; a failed one is retried at most
`WATCHER_FINAL_PASS_RETRY_LIMIT` (2) times, and a cancelled one is done. A
pause or archive that lands while a check is being prepared settles the
attempt as paused or transient, so a final pass it carried stays due. The
further pages of a `manual` or `initial` check keep that request's trigger:
they spend no allowance and stop after `WATCHER_MAX_CONTINUATION_PAGES` (4)
pages. After a restart, reconciliation also schedules the final pass of the
turn before the cursor's turn when that turn ended after the link was created
and has no recorded final pass. Deleting the watched chat detaches the link
in SQL and deleting the watcher chat removes it; the delete command then
broadcasts `watcher.link.removed` for each link the chat took part in. A
delete of a watched chat whose watcher chat has an unfinished turn (a check,
or an answer to the person's own message) is refused with a request error
before any side effect (no checkpoint, worktree or ownership change); the
`BEFORE DELETE` trigger stays as the backstop. Archiving the watched chat
pauses its link with `watched-archived`, and archiving the watcher chat
itself pauses it with `watcher-archived`, from any attached status: either
reason replaces an earlier pause, and a check that is running is cancelled.
An archive by an agent's management tool reaches the link through the
conversation shell update it broadcasts. Attach checks again inside its
transaction that the watched chat is not archived, so an archive that races
the attach is refused. Removing a project cascades its watcher links in SQL;
the runtime then forgets them and broadcasts `watcher.link.removed` for each.

Each new check retires the link's checks older than its newest
`WATCHER_WAKE_RETENTION` (500), at most four per check: the wake row and its
watcher turn's messages, activities, reasoning and plans are deleted, and the
`agent_turns` row stays, so the watcher's usage totals keep its tokens. A
check whose turn is unfinished or still owned by a provider run is skipped
and retired later.

The Git fingerprint backstop compares changed paths with other turns'
activities in NFC, and folds case on Windows and macOS, whose file systems are
case-insensitive by default.

### Fixtures

`tests/server/watcher-read-only-harnesses.test.ts` is a portable suite
(`// @inertia-test-suite portable`, without an `@inertia-harness` marker,
because each harness can be registered only once). It runs read-only watcher
turns through the TurnController and the real harness adapters, with the real
`ProviderManager`, against scripted providers in a temporary Git repository.
Each scripted provider writes only if Inertia lets it, and the cases compare
the checkout fingerprint, `git status` and the file contents before and after
the turn.

- Claude: the query receives `permissionMode: "default"`, no
  `planModeInstructions`, no setting sources, Inertia's `canUseTool` and the
  watcher role in the system prompt's `append`. The fixture models default
  mode: Read and Grep inside the workspace run without `canUseTool`, while
  Write, `AskUserQuestion`, `ExitPlanMode`, Edit and Bash all reach it. The
  write is declined as a `write-attempt` with its reason, the question is
  denied with its reason and not counted, the plan hand-off is declined and
  its plan recorded, and the turn completes. A streamed Edit start no longer
  stops the turn: the broker declines the edit with its reason and the check
  completes. Allowlisted Bash commands run without an approval, and a
  redirection is declined with the allowlist's reason and the reminder.
- Codex: `thread/start` and `thread/resume` carry `approvalPolicy:
  "untrusted"`, `sandbox: "read-only"`, `developerInstructions` with the
  watcher role and a `config` that disables every MCP server `config/read`
  reports, apps, plugins, hooks, subagents, web search and
  `request_user_input`; `turn/start` carries the same policy and
  `sandboxPolicy: { type: "readOnly", networkAccess: false }` and no
  collaboration mode. A known-safe read runs without an approval; a write
  command's approval is answered `decline` and recorded as a
  `command-attempt`. A file change that starts before its approval request
  is declined, recorded as a `write-attempt`, and the check completes. A
  malformed frame fails the turn and the app-server process exits.
- OpenCode: the scripted server evaluates rules as OpenCode does (agent
  rules, then session rules, last match wins). A watcher turn sends no agent,
  the profile ruleset and the watcher role as `system`; reads complete without
  a prompt, `.env` files and edits are denied, an allowlisted bash command is
  answered `once` and any other is rejected as a `command-attempt`. A second
  case gives the agent its own rules that allow everything; the session
  profile still wins, because OpenCode merges the agent's ruleset first and
  the session's after it and takes the last match. If OpenCode ever evaluated
  agent rules after session rules, its allows would win, so the scheduled
  canary and this fixture are what must catch such a change.
- Cursor: a scripted ACP agent is switched to its plan mode; it announces
  an edit as a `pending` tool call, asks for permission, is answered
  `reject_once` (a write attempt, the check continues) and fails the tool
  call; `cursor/ask_question` is cancelled and `cursor/create_plan` answered
  `rejected` without counting, and the plan is recorded as a hand-off.
- Kimi Code: a question arriving as a permission request is cancelled and not
  counted, a `pending` edit followed by its permission request is rejected
  as a write attempt and the check continues, a plan hand-off is recorded
  and answered `plan_revise`, and a tool call of kind `edit` reported
  `in_progress` whose title says nothing about editing stops the check.
- Antigravity: a scripted `agy` receives `--mode plan` and neither
  `accept-edits` nor `--dangerously-skip-permissions`, and a `write_to_file`
  step stops the check.

Run it with `npm run test:portable`. Integration coverage lives in
`tests/server/watcher-read-only-guard.test.ts` (the five-request cap, chat
access approvals and checkpoints), `tests/server/watcher-wake-runner.test.ts`
(hand-off plan to finding, an empty reply recorded as failed, the
`"approval"` and `"question"` live phases, the skipped guard) and
`tests/server/watcher-delivery.test.ts`, which also checks that steering a
note is refused on Cursor.

### Excluded harnesses and custom backends

The CLI harnesses (`claude-cli`, `codex-cli`, `cursor-cli`, `opencode-cli`)
are not in `WATCHER_HARNESS_IDS`. Any harness can still be the watched chat.
A harness joins the list, or gets a read-only tier, only together with a
portable fixture that proves the layers above.

A custom backend on a listed harness can be a watcher, but custom backends
never receive Inertia host tools. Such a watcher reviews only the digest each
check sends it and cannot read more of the watched chat; the dock states
"Custom backend: it sees only what each check sends."

The watched chat can run on any harness and can switch provider mid-chat. The
digest is provider-agnostic, `"watched"` access applies no route filter, and
whether a note can be steered into the running turn is recomputed from that
turn's harness against `STEERABLE_HARNESS_IDS`.

## Accounts and API keys

Every provider keeps its own sign-in. An API key is a second, separate route
that Inertia adds only where the harness has a documented way to receive one.

| Provider | What the CLI supports itself | What Inertia routes |
| --- | --- | --- |
| Claude | Claude account sign-in (`claude auth login`), Anthropic Console sign-in (`claude auth login --console`), and `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in its environment. | Account route: the native Claude backend. Settings can start either the account or the Console sign-in in the terminal (`provider.auth.start` with `method: "account"` or `"console"`). Key route: the **Anthropic API key** preset, a Claude Agent SDK profile on the Anthropic Messages protocol at `https://api.anthropic.com`. |
| Codex | ChatGPT sign-in (`codex login`) and API-key sign-in, plus custom `model_providers` with an `env_key`. | Account route: the native OpenAI backend. Key route: the **OpenAI API key** preset, a Codex App Server profile on the Responses protocol at `https://api.openai.com/v1`. |
| OpenCode | Its own provider sign-in and key store (`opencode auth login`). | OpenCode's own sign-in only. Keys stay in OpenCode's store; Inertia never passes a vault key to OpenCode and offers no key route for it. |
| Cursor | Browser sign-in (`login`). | Account only. |
| Kimi | Kimi Code sign-in through its ACP `authenticate` exchange. | Account route through Kimi ACP. A Kimi key runs through the Claude harness instead: the built-in Kimi preset sends the vault key to Kimi's Anthropic-compatible coding endpoint and is listed under Kimi. |
| Antigravity | Google sign-in, checked when a turn starts. Google recommends a Gemini Enterprise or Google AI Studio key for third-party apps; `agy` uses `GEMINI_API_KEY` only when its own settings choose the Gemini model provider. | Account only. A Gemini key route is not offered yet: Inertia has no verified way to choose `agy`'s model provider for one launch without editing the person's own Antigravity settings, and a launch that ignored the key would silently use the Google account. |

### How a key reaches a provider

Keys live only in the privileged credential vault. The database stores the
profile, an opaque vault generation and probe evidence, never the key. The
runtime process starts with every `*_API_KEY` variable removed, so a key in the
user's shell never reaches a provider by accident.

At launch the resolver reads the key for exactly one child process:

- **Claude** clears every inherited Anthropic, gateway and cloud-routing
  variable, then sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` (or
  `ANTHROPIC_AUTH_TOKEN` for bearer tokens) in that child's environment. A
  Claude-compatible profile must use a key or bearer token, because Claude Code
  would otherwise send the account's own token to the configured host. New and
  edited profiles cannot choose "no authentication". Rows saved without a key by
  an earlier release stay readable so they can be edited or removed, but they
  are not registered for launch, their models report `credential-required`,
  readiness answers "Add an API key or bearer token to use this backend.", and
  probes and launches are refused.
- **Codex** receives a `model_providers` entry with the base URL and
  `env_key = INERTIA_CODEX_BACKEND_TOKEN`; only the child environment holds the
  token. The JSON-RPC configuration never contains it, and Codex's own
  `auth.json` is untouched. The thread configuration also sets
  `shell_environment_policy.ignore_default_excludes = false` and adds the
  variable to `shell_environment_policy.exclude` (merged with the person's own
  exclusions, read through `config/read`), so tool shells never inherit it.
  When the person's policy uses `filters`, which cannot be mixed with
  `exclude`, Codex's default `*TOKEN*` exclusion keeps it out instead.

Both resolvers drop the key from the launch environment once the process has
started.

Claude Code still holds the key in its own process environment, and its Bash
and PowerShell tools inherit it. On a Claude key route Inertia therefore adds
three layers that the account route does not need:

- **Redaction.** Every SDK message of the turn passes through a redactor before
  the projector, the transcript or the failure path sees it. It masks the
  exact key and these forms of it: URL and JSON escaping, base64 and base64url
  of the key alone and followed by `\n` or `\r\n` (what `echo $KEY | base64`
  prints), and lower- and upper-case hex. Spaces, tabs and line breaks
  between characters are ignored, so wrapped base64 (`base64` wraps at 76
  columns), `xxd -p` output and a key split across lines each become one
  `[redacted]`. Streamed text and thinking deltas hold back only a tail that
  could still complete one of these forms (at most twice the longest form);
  the tail is masked or released when its block ends. Approval and question
  displays, thrown errors and transport errors are masked the same way. The
  command Claude runs is not rewritten. Other encodings, such as `xxd` with
  offsets, `od`, compression, encryption or a key reversed, are not
  recognised.
- **Command refusal.** A `PreToolUse` hook passed through the SDK `hooks`
  option (matcher `Bash|PowerShell`) declines commands that mention
  `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, read `/proc/*/environ`, or
  dump the environment (`env` without a command, `printenv` without names,
  `set` without arguments, `export`, `export -p`, `declare -x`,
  `Get-ChildItem Env:`), including inside `bash -c` or `cmd /c`. Hooks run
  before the permission check in every mode, so the refusal also covers
  full access (`bypassPermissions`) and commands Claude Code would approve as
  read-only; the binary runs SDK callback hooks even under the managed
  `disableAllHooks` setting Inertia applies. The permission broker repeats the
  same check. Only these command shapes are refused: a program that reads its
  environment some other way (for example a script that prints
  `os.environ`) is not refused, and its output is masked only when it shows
  the key in one of the forms above.
- **No `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.** The bundled Claude Code binary
  scrubs `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and related variables from
  its subprocesses when this flag is set, but the same flag forces the
  permission mode to `default` (dropping plan mode and accept-edits), enables a
  subprocess sandbox that pins protected paths to the launch directory, and is
  refused together with `--await-claim`. Inertia does not set it.

### How account and key routes coexist

A chat stores one route: harness, backend profile, configuration revision and
model. The account route and the key route of the same provider are different
profiles, so a chat runs on exactly one of them and never switches silently.

- **Readiness.** A key route needs the CLI installed and the key saved. It does
  not need the provider account to be signed in. The provider snapshot keeps
  `installState` and `authState` separate, so the interface can show "installed,
  not signed in" while the key route is ready.
- **Key check.** After a key is saved, `backend.profile.probe` with
  `modelIds: []` checks only the key: `GET /v1/models` through the model-list
  module. When the endpoint has no model list (a 404 or other unsupported
  answer, a body that is not a model list, or an empty list), the check probes
  the route's primary model instead and records that probe; its success is the
  key check and its failure is reported as the reason. Success records the
  check for the current key generation and the view reports
  `keyVerified: true`; the profile can then be enabled while its
  models are still `probe-required`, and the first send probes the chosen model
  before launch (for the Responses protocol this includes the tool stage that
  Codex admission needs). A new key, or a connection change, clears the check.
  A full test stays available by naming the models.
- **Account kind.** The provider snapshot may carry `accountKind`, read from the
  CLI's own status: `Claude account` or `Console API key` from
  `claude auth status --json`, and `ChatGPT account` or `OpenAI API key` from
  `codex login status`.
- **Key rotation.** Saving a new key records the new vault generation and keeps
  the configuration revision, the enabled state, the probe evidence, the
  defaults and every chat. The evidence of each model is marked for renewal.
- **Edits.** A change to the address, protocol, authentication, local-HTTP or
  private-network setting bumps the configuration revision, disables the
  profile until it is tested again, clears its defaults, and asks existing chats
  to start a new chat. Names, models, routing and capability hints keep the
  revision; removing a model affects only chats and defaults on that model. A
  backend's preset cannot change, and a preset always connects to its catalogue
  address.
- **Keys stay with their host.** When a custom backend's address, protocol or
  authentication changes, the saved key is removed from the vault before the
  new connection is stored, and the command result carries
  `credentialCleared: true`. If the vault cannot remove the key, the change is
  refused.
- **Evidence.** A test probes the requested models, or every model up to 16,
  one after another. Each model gets up to three stages of 8 seconds: the text
  request, and for the Responses protocol the inert tool call and its
  continuation, so a slow tool stage never consumes the text stage's time. A
  test stops starting new models once another model could take it past 180
  seconds, inside the 210-second request deadline. Evidence is kept per model
  and is valid for 7 days. Before a send, evidence older than 24 hours (or
  older than the latest key change) is renewed in the background while the turn
  proceeds; expired or missing evidence is probed before the launch, and the
  turn is refused only when that probe fails, with its reason.
- **States.** `connectionState: "testing"` means a person-started test is
  running. An automatic renewal, in the background or before a launch, sets
  `renewing: true` instead and leaves `connectionState` on the last result.
- **Probe shapes.** The probes read the providers' real streams: Responses
  `response.created`, `response.in_progress`, `response.output_item.*`,
  `response.content_part.*`, `response.output_text.*` and
  `response.function_call_arguments.*`, ending in `response.completed`, or in
  `response.incomplete` when the only reason is `max_output_tokens`; and
  Messages `message_start`, `content_block_*`, `ping`, `message_delta` (including
  `stop_reason: "max_tokens"`) and `message_stop`. The text probe allows 256
  output tokens and the tool stages 1,024, so reasoning models can finish. A
  returned model counts as the requested one when it is identical or a dated
  snapshot of it, such as `gpt-5-2025-08-07` for `gpt-5`.
- **Official endpoints.** A successful probe of a model on the official
  Anthropic or OpenAI API (the address of the API key presets) reports
  `verified` compatibility. Gateways and other custom endpoints report
  `partially-compatible`, because a text probe cannot prove every
  provider-specific feature.
- **Model lists.** `backend.profile.discover-models` reads `GET /v1/models`
  through the probe's network module and returns IDs and display names without
  saving them.
- **Model list contents.** Model IDs that contain control, bidirectional or
  zero-width characters are dropped, and those characters are removed from
  display names.
- **Private networks.** Private, carrier-grade NAT, benchmark and link-local
  addresses are refused unless the profile turns on `allowPrivateNetwork`; the
  probe, model lists and both launch-time checks apply the same rule. Cloud
  metadata addresses (`169.254.169.254`, `169.254.170.2`, `100.100.100.200` and
  `fd00:ec2::254`) stay refused even with the switch on. Loopback still needs
  `allowInsecureLocalhost`, and plain HTTP is accepted only for literal
  loopback.
- **Usage.** Account routes report the provider's subscription windows through
  official channels (Codex, Claude, OpenCode Go). Cursor and Kimi report
  "Usage is not reported by this agent."; Inertia no longer reads their sign-in
  files or Keychain entries, nor calls their internal usage endpoints. Key
  routes report "Usage and limits are not available for API keys." and never
  call an account usage endpoint.
- **Failure kinds.** A failed turn may carry `failureKind` (`billing`,
  `authentication`, `rate-limited` or `model-not-found`) when the harness
  classified the error: Claude's assistant error codes, Codex's
  `codexErrorInfo` (`unauthorized`, `usageLimitExceeded`, `rateLimitExceeded`),
  usage-limit tags and authentication phases of the ACP and Antigravity
  harnesses.
- **Linux without a keyring.** When Electron's safe storage falls back to plain
  text, keys are refused with "Inertia cannot store keys safely on this system
  because no keyring is available. Install or unlock a Secret Service keyring,
  such as GNOME Keyring or KWallet, then restart Inertia."

### Prompt cache and compact on return

Key routes pay for context at the uncached rate once the provider's prompt
cache expires, so Inertia records when each chat last sent a request and how
long its cache lives, and offers to compact a long chat before the next message
(the flow is described in [Snapshots and compaction](SNAPSHOTS_AND_COMPACTION.md#compact-on-return)).

| Harness and route | Eligible | Cache lifetime | Source |
| --- | --- | --- | --- |
| Claude, **Anthropic API key** preset | yes | 5 minutes, or 1 hour with `promptCacheTtl: "1h"` | reported from `message_start` usage when Claude breaks cache writes down, otherwise configured or assumed |
| Claude, native, `Console API key` account kind | yes | 5 minutes | reported or assumed |
| Claude, native, `Claude account` | no | Claude Code chooses its own cache length on subscriptions | |
| Claude, Kimi preset | no | Kimi Code is a quota membership, not per-token billing, and manages its own context | |
| Claude, custom gateway | no | no published lifetime | |
| Codex, **OpenAI API key** preset | yes | 30 minutes | assumed |
| Codex, native ChatGPT account | no | | |
| OpenCode, Cursor, Antigravity | no | | |

- **One-hour cache.** A Claude Agent SDK profile on Anthropic Messages may set
  `promptCacheTtl` to `"5m"` or `"1h"` on `backend.profile.create` and
  `backend.profile.update`; it is stored with the profile, shown on its view
  and detail, and changes neither the configuration revision nor the enabled
  state. The shared schema refuses it on every other harness or protocol and
on the Kimi preset; a value already stored on a Kimi profile is ignored at
launch and dropped at its next update.
  When a launch uses such a profile, the backend resolver adds the harness
  configuration `{ kind: "claude-messages", promptCacheTtl }`, and the Claude
  harness passes it as the SDK `settings.promptCacheTtl` (merged with the fast
  mode settings) for the main conversation. The key name was checked against
  `Settings.promptCacheTtl` in `@anthropic-ai/claude-agent-sdk` 0.3.303 and the
  bundled CLI. One-hour cache writes are billed at a higher rate. Subagents
  keep Claude Code's own default (`subagentPromptCacheTtl` is not set).
- **Environment.** `CLAUDE_CODE_PROMPT_CACHE_TTL` takes precedence over the
  settings key, so non-native Claude launches remove it with the other Claude
  routing variables; only the profile decides. A native Claude launch keeps the
  person's environment, so a value set there is not seen by Inertia and the
  native lifetime stays "assumed" unless Claude reports a breakdown.
- **Codex.** Codex does not report cache lifetimes or individual request
  starts. Its facts are always "assumed": 30 minutes, measured from the time
  Inertia receives each usage report. The request began before its report, so
  this never overstates how long the chat has been idle.
- **Not a turn.** Compaction, manual or on return, does not create an
  `AgentTurn`, does not wake a watcher, and does not count as a watched turn.

### Not verified against live services

The deterministic fixtures cover the request shapes, headers, network policy
and failure handling. These have not been exercised against the real services:
the Anthropic and OpenAI APIs with real keys, model lists from those APIs,
`claude auth login --console` on an installed Claude Code, Claude Code with a
first-party API key through the custom launch options, Codex `model_providers`
with an OpenAI key, and the Kimi key route. The prompt-cache facts were checked
against fixture streams only: whether the real Anthropic API reports the
`cache_creation` breakdown on `message_start` for every model, whether Claude
Code honours `settings.promptCacheTtl` on an API key, the real expiry of the
OpenAI cache, whether Codex requests extended cache retention, and that Claude
Code limits its own idle compaction to the 1-hour cache (read from the binary,
not documented) have not been observed.

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
- send screenshots to a model that does not accept images, or infer visual
  quality from semantic boxes;
- invent completion after provider failure; or
- merge Cursor and Kimi into a generic ACP behavior layer before their actual
  protocol differences are covered.

The next high-value layers are an inspectable context ledger with pinned host
rules, bounded replay artifacts tied to exact turns, explicit capability
negotiation for resumable sessions, and a separately reviewed visual-evidence
transport. Each should land with deterministic fixtures and provider-specific
contract tests rather than as a broad framework rewrite.
