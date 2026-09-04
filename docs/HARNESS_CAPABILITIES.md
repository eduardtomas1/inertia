# Inertia harness capabilities

Inertia does not replace Codex App Server, the Claude Agent SDK, Cursor ACP,
Gemini CLI ACP, Kimi ACP, or the OpenCode SDK with a
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
- provider-neutral host tools with process-local runtime validators; and
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

`inertia.frontend-workbench` composes the existing visible Browser tools. A
successful semantic snapshot gains a bounded `inertiaAudit` object with stable
issue codes for controls without stable labels or semantic names, clipped
controls, overlapping controls, and targets smaller than 24 by 24 CSS pixels
in the current viewport.
The audit is deterministic and provider-neutral. It does not claim to judge
color, typography, imagery, canvas, animation, or pixel quality, and it does
not change screenshot approval or redaction boundaries.

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

## Gemini ACP contract

Gemini uses the official `gemini --acp` process from Gemini CLI 0.58.0 or newer.
The harness does not call ACP `authenticate`. Gemini advertises every supported
method whether or not it is active, while
[calling `authenticate` can change the CLI's saved method and clear cached credentials](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/acp/acpRpcDispatcher.ts#L106-L166).
The user selects authentication through the ordinary interactive `gemini` flow,
and `session/new` is the authoritative per-turn check. Inertia starts that
setup terminal with `NO_BROWSER=true`: for Google OAuth, Gemini prints its
official one-time URL and waits for the code, while Inertia opens only the
reviewed Google URL once and the user pastes the returned code into Gemini.
API-key, Vertex AI, and gateway choices remain entirely CLI-owned.

Every Gemini turn receives a fresh ACP process and session. Gemini CLI 0.58
[starts saved-history replay without awaiting it](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/acp/acpSessionManager.ts#L164-L228),
provides no replay-complete notification, and can interleave that history with a
new prompt. Inertia therefore does not call `session/load` or claim native
Gemini resume. It supplies only bounded visible user and assistant messages as
application-reconstructed context. The reconstruction is labeled in the prompt,
may report truncation, and excludes reasoning, activities, tool payloads,
provider-managed credential state, provider session identity, and historical
attachment bytes. Text explicitly entered into visible messages remains part of
the reconstruction and should be reviewed like any prompt sent to a provider.

The same CLI version initializes one provider-side chat before ACP
`session/new`, then creates a second chat for the ACP session. Both are recorded
locally by Gemini CLI. Inertia launches `gemini --acp --session-id <random-owned-id>`,
with 48 bits of entropy in the first eight characters because Gemini 0.58 uses that
prefix and a minute-resolution timestamp in the outer chat filename,
tracks the separately returned ACP identity, closes the transport, and confirms
the complete process tree is stopped before cleanup. Cleanup scans only bounded
Gemini project directories, requires the exact `.project_root` ownership marker,
reads chat metadata without following symlinks, and removes only files and
session-scoped artifacts attesting those exact identities (including bounded
subagent descendants). Once Gemini reports successful initialization or session
creation, the corresponding record must be found as well as removed, so an
unreviewed storage-layout change fails closed. Inertia deliberately does not
invoke the CLI's session-delete
command: that command also accepts numeric list indexes, which is not an exact
ownership primitive. An unconfirmed process, ambiguous workspace marker, or
remaining owned record makes the public turn fail with `cleanupConfirmed: false`;
unrelated Gemini history, authentication, settings, and credentials are never
deleted.

Build turns select Gemini's advertised `default` permission-reporting mode;
plan turns select its advertised `plan` mode. Bounded native ACP `plan`,
`plan_update`, and `plan_removed` notifications are projected when the CLI sends
them. The current ACP server exposes neither structured agent questions nor a
manual compaction command. Usage is projected only from validated standard ACP
prompt usage, Gemini's prompt `_meta.quota.token_count`, and ACP `usage_update`
notifications; those sources have different run and session/context scopes and
are never combined into invented coverage.

For ACP permission requests Gemini reports, Inertia chooses only one-shot
options and applies Supervised, Auto-edit, Full Access, or Plan policy locally.
That is not complete mediation of Gemini CLI: its own policy engine, trusted MCP
configuration, and
[saved allowlists can permit tools without emitting `session/request_permission`](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/core/src/tools/mcp-tool.ts#L201-L215).
Capability text therefore describes these as provider-reported permissions, and
project trust must include the selected CLI configuration.

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
