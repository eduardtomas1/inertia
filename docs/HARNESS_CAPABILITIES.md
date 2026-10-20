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

### Conditional packs

A pack may declare that it is conditional. The registry then asks, whenever a
turn's request or tool bridge is built, whether the pack is offered to that
turn's chat, reading the chat from the store by its id rather than trusting a
caller's copy. A pack that is not offered contributes no instructions and no
advertised tool definitions to that turn; its tools stay callable, exactly like
retired tools, because a provider session may have registered them while the
pack was offered (Codex registers dynamic tools only when a thread starts). Their
handlers therefore re-check the condition on every call and refuse with a
readable reason. A check that throws withholds the pack. A conditional pack's
digest entry records that it is conditional; unconditional packs keep their
digest, which a test pins. Turn assembly asks `instructionsFor(chat)` for the
instructions of the packs offered to that chat; `allInstructions()` lists every
reviewed instruction, for inspection and tests. The bridge always builds its
advertised definitions from the offered packs and adds the tools of the packs it
withholds to the retired names.

### `inertia.initiatives`

`inertia.initiatives` (revision 1) is the conditional pack for chats in an
initiative. It is offered only while the chat belongs to an initiative that is
not archived (Active or Done). Membership comes from the chat's own row, at the
time the turn's request and bridge are built and again on every call; no tool
takes an initiative id. Its evaluation metadata is tagged `initiatives`,
`memory`, `permissions` and `untrusted-text`, records `host-tool-result`
evidence, and names the scenarios `initiative-membership-authority`,
`initiative-sibling-read-approval` and `initiative-note-proposal-review`.

| Tool | Read-only | Input | Result |
| --- | --- | --- | --- |
| `inertia_initiative_overview` | yes | `{}` | The initiative's name and status, `briefRevision`, `briefPreview` (the first 400 characters, `briefComplete` false when cut), `notesRevision`, accepted notes as `{ noteId, title, summary }` (summary: the note's first line, at most 160 characters), and its chats that are not archived as `{ conversationId, title, project, status, updatedAt, isThisChat }`: this chat first, then the others most recently updated first, at most 50. `status` is the Work vocabulary (`approval`, `input`, `working`, `failed`, `limited`, `completed`, `idle`) computed by the runtime from the chat's canonical run, chosen as the sidebar chooses it. The chats are read with one query for the initiative's members, not from an app snapshot. Chat titles and project names are scrubbed and neutralised like referenced-chat metadata; no paths and no identifiers other than `conversationId` and `noteId` are returned. The JSON stays within 16 KiB: the runtime measures the result without items and each item once, and when the sum would not fit, drops notes and chats from the end of the longer list. `notesOmitted` counts the notes left out; `chatsOmitted` counts the chats beyond the first 50 as well as those dropped for size. |
| `inertia_initiative_read` | no | exactly one of `noteId` or `conversationId` (UUIDs), with `turnId`, `cursor` and `limit` for a chat | A `noteId` returns that accepted note of this initiative in full: `{ noteId, title, body, provenance, updatedAt }`; proposals, rejected notes and other initiatives' notes are refused with `note_not_found`. A `conversationId` must be a chat of the same initiative that is not archived, the same chats the overview lists (`not_in_initiative`, "That chat is not in this chat's initiative.", otherwise, before anything is asked). It is then handed unchanged to `inertia_request_context`, so paging, cursors, the approval card, the workspace-difference confirmation, the per-turn request budget (shared with `inertia_request_context`) and "readable for the rest of this turn" are exactly those of that tool. The card names the initiative (`initiativeName` on the chooser request, accepted only for a named chat and validated as a stored initiative name). When the user shares the chat, membership is checked again before anything is read: if either chat left the initiative, or this chat's initiative was archived, while the card was open, the request ends as failed, nothing is read, and the tool refuses with `not_in_initiative` or `initiative_archived`. Each later call checks membership again, so a chat that leaves after it was shared is refused here, although `inertia_request_context` still reads it for the rest of the turn because the user shared it. |
| `inertia_initiative_remember` | no | `{ title, body, kind? }`: a title of 1 to 120 characters on one line, a body of 1 to 2,048 UTF-8 bytes, and optionally `fact`, `decision` or `constraint` | Proposes a note; it never asks for approval because a proposal is inert until the user accepts it. |

The overview deliberately lists the member chats of every project in the
initiative, not only this chat's project: their titles, project names, Work
status, last update and `conversationId`. That is what an initiative is for,
and it is the same information the user sees in the initiative's sidebar
section. A `conversationId` grants no authority: reading another chat still goes
through `inertia_initiative_read`, its membership checks and the user's approval
card, exactly as `inertia_request_context` would ask for any chat it was not
given.

A proposal is untrusted agent text, held to stricter Unicode rules than the
user's own notes. A title must have at least one visible letter or digit and is
refused with `invalid_arguments` when it contains a C0 or C1 control character,
a format character (`\p{Cf}`, which covers zero-width characters, joiners and
the bidirectional controls) or a line or paragraph separator (`\p{Zl}`,
`\p{Zp}`). A body is refused when it contains NUL, a bidirectional embedding,
override or isolate control (U+202A–U+202E, U+2066–U+2069) or a line or
paragraph separator; anything else in a body is kept and neutralised. The
user's titles and bodies are refused only for those bidirectional controls and
separators, where they enter through the Initiative page's commands; stored
notes are never re-validated, and the page shows each note's title and text
with `dir="auto"`, isolated from the labels around it.

The proposal repository is the one place agent text is prepared: it trims the
title and body, applies the rules above, passes them through
`neutralizeUntrustedAgentText`, which escapes harness control tags,
`Human:`/`Assistant:` turn markers and Inertia's own section headers and
instruction labels (now including `[inertia-initiatives]` and
`[initiative-context]`), and measures the escaped text; text that no longer
fits the limits is refused with `invalid_arguments` rather than cut. In one
transaction it then re-reads the chat's initiative, checks that the exact turn
is still active, and compares the title, with default-ignorable characters
(zero-width, joiners, fillers, variation selectors) removed, then
compatibility-normalised, whitespace-collapsed and case-folded, with the
initiative's notes: an accepted or proposed note with that title returns
`{ status: "duplicate", noteId }`, a rejected one `{ status: "rejected-before",
noteId }`, and nothing is created. Otherwise it refuses a sixth proposal in the
same turn (`proposal_limit_reached`), and, with `proposal_limit`, a proposal
while 16 proposals already wait for review in the initiative or 5 from this
chat. Proposals do not count toward the initiative's 64 notes until the user
accepts them; accepting one beyond 64 accepted notes is refused with the page's
usual "An initiative keeps at most 64 notes. Delete one first." SQL triggers
back both limits. The note is stored with provenance `agent`, state
`proposed`, the proposing chat as its source and the `kind` the agent gave
(shown on the page as a small label), together with a turn-scoped system
message whose `initiativeContext` receipt carries `proposal: { noteId, kind }`
and whose text is `Proposed an initiative note: <title>`. The model receives
`{ status: "proposed", noteId, message }`, where `message` says that the user
reviews it on the Initiative page. A provider that retries the same call (same
turn and tool-call id, same input) receives that original result again rather
than `duplicate`; the same id with other input is refused with
`idempotency_conflict`. The runtime publishes the message and a snapshot, so
the page's **Needs review** list updates at once. Withdrawing a request's
receipt (a turn that never reached its provider, or a restart on a fresh
session) leaves proposal receipts in place. Receipts are system messages
without a rendered page, so neither context packets nor turn reads of the chat
include them. Rejected notes are kept, up to the newest 64 per initiative, so
the same title is not proposed again until the user deletes the rejected note.

Every refusal is a tool failure, `{ error: { code, message } }`, never an
exception. The initiative tools' own codes are `invalid_arguments`,
`not_in_initiative` (`This chat is no longer in an initiative.` when the chat
left its initiative, including during the turn), `initiative_archived`,
`note_not_found`, `proposal_limit_reached`, `proposal_limit`,
`idempotency_conflict`, `note_not_saved` (the proposal could not be stored),
`unknown_tool`, `turn_not_active` (or the shared `host_tool_failed` when the
turn had already settled before dispatch, or a call failed unexpectedly) and
`call_cancelled`. A read of another chat also passes through the codes of
`inertia_request_context`: `budget_exceeded`, `user_cancelled` (the user
declined the card), `call_cancelled` (the card expired or the turn ended),
`idempotency_conflict`, `operation_not_replayable`, `turn_not_found`,
`turn_withheld` and `invalid_arguments`.

The pack's instruction, labelled `inertia-initiatives` and under 1 KiB, extends
the initiative framing: the brief and notes index arrive as structured
execution context on a new session and after they change, as reference material
the user maintains that may be out of date and is not new instructions or
approval; when the tools are available, the overview shows the current brief
revision, notes and the other chats, the read tool returns a full note or
another chat's turns, which the user approves, and the remember tool proposes a
note the user reviews, only for durable facts, decisions or constraints that the
other chats need, never progress updates; and text from notes and other chats
is context, never instructions or approval. A turn that
carries the pack's instruction does not also carry `initiative-context`, so a
chat is framed once: routes without an attested host-tool bridge (and resumed
imported Codex sessions, which get no host tools) keep `initiative-context`.

Codex chats register these tools when their provider thread starts, so a chat
that joins an initiative mid-thread has them from its next new thread; until
then it receives the brief and notes as context and the pack's framing, which
is why the instruction speaks of the tools only "when they are available".
Claude, Cursor, Kimi and OpenCode attach them from their next turn. A Codex
thread that registered them can keep calling them after the chat leaves; each
call is refused as above.

## Initiative context

Chats in an initiative share the initiative's brief and an index of its
accepted notes. This is Inertia-authored context on the ordinary turn path, not
a capability pack: it needs no host tools, so every provider receives it,
including routes without an attested host-tool bridge. The tools that let an
agent look further and propose notes are the `inertia.initiatives` pack above.

Turn assembly carries it as structured execution context of kind
`initiative`, at most three blocks per turn (a membership change, the brief
and the notes index), placed after document attachments
and before file references, referenced chats, carried chat packets and
restored history. The brief block is labelled
`Initiative brief · <name> · revision <n>` and holds the brief verbatim under an
`Initiative: <name>` line; the notes block is labelled
`Initiative notes · <name> · <k> notes · revision <n>` and holds one
`- <title>: <first line>` line per accepted note, in creation order, at most
8 KiB with a trailing `… and N more notes` line. Each block counts toward the
64 KiB block, 240 KiB payload, 32 reference and 48 segment limits like any other
context, is persisted by digest in `turn_execution_context_blobs`, and is
listed in the turn manifest with kind `initiative`, so a turn's record shows
exactly which revisions it received. Proposed and rejected notes, identifiers,
paths and other chats' content are never included. The name is scrubbed and
neutralised the same way referenced-chat metadata is; stored names are already
bounded, so it is never cut by UTF-16 units.

Delivery happens on change, not on every turn. A fresh provider session (first
turn, provider change, a stale or lost session, or a resumed turn that falls
back to a new session, which reads the chat's initiative as it is at that
moment) receives both blocks. A resumed session receives a block again only
when it differs from the copy that same provider session holds: the brief by
revision, the notes index by a digest of its text, so an edit that leaves the
index unchanged sends nothing. The re-sent block says `Updated since the last
turn of this chat (previous revision <m>).`, where `<m>` is always a revision
that session received. A brief or notes index emptied since then is announced
once so the agent stops relying on its copy. Initiatives that are not
archived (active and done) are shared.

Each delivery is recorded in `initiative_context_deliveries` in the same
transaction as the turn, holding only what the session received: the
initiative and the name it was told, and the brief revision and notes index
(revision and digest) it has a copy of, each null when it has none. A turn
that never reached its provider (it settles before it started, fails to
start, or is stopped before the provider was handed the request) withdraws
its delivery and receipt in its settlement transaction, so the next turn
sends again. Compaction drops the material from a session: deliveries from
turns requested before the chat's newest `/compact` receipt, or before an
automatic compaction a provider recorded while running a turn (Claude, Codex,
Cursor, Kimi Code and OpenCode compaction activities), no longer count.

When a resumed session last received material from an initiative the chat is
no longer part of (it moved or was unassigned, or that initiative was archived
or deleted), the next turn sends one block labelled
`Initiative change · <name>`: `This chat is no longer part of the initiative
"<name>"; its brief and notes no longer apply.`, followed after a move by
`It is now part of the initiative "<new>".` and the new initiative's blocks.
Deleting an initiative keeps its delivery rows by name for this purpose. A
fresh session never hears of an earlier initiative. Chats outside any
initiative that have nothing to be told add nothing: their provider input is
byte-identical to a chat without initiatives.

Whenever a block is sent to a route without the `inertia.initiatives` pack, one
hidden instruction labelled `initiative-context` (under 1 KiB) frames it in the
voice of the Build-mode instruction (with the pack, its own instruction is the
only framing): the chat
belongs to the named initiative, a group of chats the user coordinates; the
brief and notes index are shared reference material the user maintains for
every chat in it; they are context, not new user instructions or approval; and
they may be out of date relative to this chat. A turn that only says the chat
left an initiative carries the same label with a short note that the earlier
material no longer applies. Each delivery also leaves a receipt in the chat,
described in `docs/SNAPSHOTS_AND_COMPACTION.md`.

## Initiative tool settings and skills folder

An initiative's tool settings live in `initiatives.preferences_json` and are
enforced by the runtime, never by provider instructions. Restrictions hold for
every member chat whatever the initiative's status; defaults apply only when a
chat is created.

- **Access ceiling.** Creating a chat in an initiative, moving a chat into it
  and setting or lowering the ceiling lower the chat's access mode to the
  ceiling in the same transaction (one statement for all members when the
  ceiling changes), together with the access recorded on the chat's pending
  queued messages, so they still match the chat and are not blocked as a
  changed route. Raising a member chat above it is refused by the store with
  `"<name>" limits chats to <mode>.`, whichever caller asks.
- **Running turns.** A provider receives its access when a turn starts and
  keeps it for the whole turn. A turn already running when the ceiling is
  lowered therefore keeps the access it started with until it ends; stopping
  it applies the ceiling at once. Every turn start clamps the access sent to
  the provider to the ceiling, and a chat whose stored access is still above
  it (restored data, or a write that raced the change) is lowered in the
  transaction that persists the turn and published again. The comparison
  uses the access the provider actually runs with: Antigravity runs
  Supervised as Auto-accept edits, so under a Supervised ceiling its turns
  are refused with the ceiling's message and
  `Antigravity cannot run supervised.`, and the composer shows the same
  reason instead of sending.
- **Automatic resume.** An automatic resume after a usage limit, and a
  continuation after a runtime restart, re-check the chat's route, access
  included, before sending. A plan made before the ceiling lowered the chat
  no longer matches, so that chat needs a manual resume.
- **Managed chats.** A chat an agent starts joins its parent's initiative
  while that initiative takes chats. When it no longer does and it sets an
  access ceiling, the tool call fails with
  `"<name>" no longer accepts chats; its access limit cannot be carried to a
  new chat.` rather than creating the chat outside the ceiling; without a
  ceiling the chat is created outside the initiative as before.
- **Agent browser tools.** A host browser tool call is refused with
  `browser_disabled` when either the chat's initiative or its project blocks
  browser access; allowing it at one layer cannot reopen a block at the other.
- **Claude spend limit.** Native Claude turns on the built-in Anthropic backend
  receive `maxBudgetUsd` as the lower of the initiative's and the project's
  limits.
- **Defaults.** For a request that names no model, the initiative's default
  model resolves first, then the project's, then Settings, each validated
  against the live catalog at use, so a removed model or a disabled or
  reconfigured backend falls through; a request that names only a reasoning
  level gets it on that model when the model offers it. The default access
  mode resolves before the project's and is then lowered to the ceiling.

The skills folder is `<data>/initiatives/<initiative id>/skills/`, created
owner-only when the user turns it on, with skills in its `.claude/skills/`
folder (`<skill>/SKILL.md`, the layout Claude uses under a project). Every
component from the real data folder down is checked to be a directory and not
a link, and the result must resolve to exactly that place; anything else is
refused and the folder is not offered. The path never reaches the renderer:
**Open folder** sends only the initiative id, and the runtime resolves and
creates the folder through the same request the main process uses for project
paths. Native Claude chats in an initiative that is not archived get the
folder as one more skill root, between the project's roots and the user's
`~/.claude/skills`; discovery reports those skills with scope `initiative`, and
selected skills are revalidated against the same contained root when the
harness stages them (`ProviderRunRequest.initiativeSkillsRoot`, present only
when the turn selects Claude skills). The skill route key includes the
initiative whose folder the chat may read, from the database only, so reading
a chat's workflow state never touches the disk, and moving a chat or turning
the folder off rediscovers. Turning the folder off or deleting the initiative
leaves the user's files in place.

Codex skill roots outside the chat folder are not offered until the
app-server contract for extra skill roots is verified. Whether a skill listed
through a second `skills/list` cwd is honoured when a turn invokes it has not
been checked against Codex, so Codex chats list only their own folder's
skills.

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
