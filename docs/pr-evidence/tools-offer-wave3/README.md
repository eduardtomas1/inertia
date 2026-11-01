# Tools offer, wave 3: chat to agent

This wave is agent-facing: it changes what a provider model can read through
Inertia's host tools, not what the user sees. There is nothing to screenshot;
the evidence is the deterministic fixtures listed below and the shapes shown
here, which come from those tests.

## `inertia.workspace` pack (revision 1)

Six read-only, non-destructive tools, advertised to every provider that has
host tools (Codex chats see them from their next new thread). Each result is
capped at 31 KiB of JSON; lists stop early with `truncated: true`. Text fields
are scrubbed for credentials (including values only their name marks, such as
`DB_PASSWORD=`, `STRIPE_API_KEY=`, `GITHUB_TOKEN:` and `password:` in a `.env`
or YAML diff), control characters and user or temporary paths (with either
slash, JSON-escaped, percent-encoded, behind `file://` or `\\?\` prefixes, and
with spaces in the profile name), and instruction-shaped text is neutralized
like chat context reads.

| Tool | Arguments | Result |
| --- | --- | --- |
| `inertia_git_status` | none | `repository`, `branch`, `detached`, `upstream`, `ahead`, `behind`, `totalFiles`, `truncated`, up to 200 `files[] { path, previousPath?, status, staged, unstaged, reviewed }` |
| `inertia_turn_diff` | `turnId?`, `cursor?` | the chat's own turn diff, paged by file, at most 24 KiB of diff per page; binary files by name only; `restarted: true` when a live turn's file list changed since the cursor; a just-ended turn waits up to 5 s for its capture; `turn_not_found` for another chat's turn |
| `inertia_read_plan` | none | `source` (`native` or `none`), up to 50 steps with status, plan document at most 16 KiB |
| `inertia_read_goal` | none | `source`, `objective` (4 KiB), `status`, `tokenBudget`, `tokensUsed`, `timeUsedSeconds`, timestamps, or `{ goal: null }` |
| `inertia_list_tasks` | `includeDone?` | up to 200 tasks `{ id, title, note (1 KiB), priority, dueDate, done, linkedConversationId, linkedStatus }`, newest first: tasks assigned to this project, and tasks with no project that are unlinked or linked to a chat in this project |
| `inertia_project_actions` | none | up to 60 `{ id, label, command, preview, running, runningInThisChat, previewUrl }`; read-only |

Errors: `invalid_arguments`, `turn_not_found`, `workspace_unavailable`,
`call_cancelled`, `host_tool_failed`. Fixtures:
`tests/server/workspace-host-tools.test.ts` (success, malformed arguments, a
settled or wrong turn, cancellation, every output limit, a chat without a
workspace, another chat's turn, a task assigned to another project, legacy
tasks with no project, a `.env` diff, every path spelling, a live file list
that changes between pages, a just-ended turn), and
`tests/server/turn-git-artifacts.test.ts` (live diffs shared within 5 s with no
new Git objects, a 20 s live deadline, per-caller cancellation, the bounded
wait for a finalization in flight).

## Orchestration additions (`inertia.orchestration` revision 3)

- `inertia_wait_for_conversation` (`conversationId`, `timeoutMs` 1,000–20,000,
  default 15,000): polls the managed child's stored status every 250 ms without
  holding a transaction, re-checks the exact caller turn on every poll, and
  returns the status plus `outcome: "needs-input" | "settled" | "timeout"`.
  Capped at 20 s because the OpenCode MCP client times out at 30 s; the tool
  description tells the model to call again rather than ask for longer. A
  wait that ends in `timeout` does not count toward the turn's 128-call
  allowance (a `settled` or `needs-input` wait counts once), and every wait
  result carries `remainingToolCalls`.
- `inertia_request_context` gains a `managed` access level: a chat may read its
  direct managed children's turns without the chooser card, with the same
  paging, `turn_withheld` rules, neutralizing and secret scrubbing as a
  user-referenced read. Grandchildren, siblings and child-to-parent reads still
  need the chooser. Reads are recorded with `access: "managed"`, which needed
  database schema 107 (append-only rebuild of the read-log table's check
  constraint; every row and index unchanged).
- A local goal (`inertia-local`) now reaches the provider as one execution-
  context line labelled "Chat goal", at most 512 bytes, neutralized, and
  explicitly marked as context rather than an instruction. Codex-native goals
  are unchanged.

Fixtures: `tests/server/agent-thread-manager.test.ts` (wait: status flip,
needs-input, timeout, abort, non-managed refused, settled caller refused,
arguments, 200 timed-out waits leaving the allowance intact),
`tests/server/provider-host-tool-runtime.test.ts` (allowance charging and the
call-identity bound), `tests/server/agent-context-tool.test.ts` and
`tests/server/conversation-context-turn-reads.test.ts` (managed reads,
grandchild still gated, injection scan), `tests/server/turn-request-preparation-
goal.test.ts` and `tests/server/request-context.test.ts` (goal line, bound,
neutralization), `tests/server/agent-context-read-managed-access-migration.test.ts`
and the migration fixture tests for schema 107.
