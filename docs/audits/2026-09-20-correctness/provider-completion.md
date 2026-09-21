# Provider completion and restart follow-up

The user reported Claude remaining on Working after its final answer was visible,
and requested equivalent completion checks for all six providers. This follow-up
extends PR #433 without changing shutdown wording, continuation authority,
provider deadlines, dependencies, or release configuration. Deterministic fixtures
use synthetic provider messages; they do not establish which message sequence
occurred in the user's live installation.

The later [final capability review](final-provider-capabilities.md) extends this
checkpoint with six further reproduced defects and fresh full/portable gates.
It also resolves the previously unconfirmed quiet-message deadline suspicion;
the rejected extra-read-only inference below remains correctly bounded.

## Reproduced defects

### Claude terminal failures with accepted prompts

The persistent Claude Query can remain open after a command ends. Its initial
prompt lifecycle tracked only the initial UUID; refusal, cancellation or discard
of an admitted follow-up therefore left the pending UUID waiting indefinitely.
The initial prompt's terminal failure also remained blocked when a follow-up was
pending. A success-shaped result with `is_error: true` incorrectly entered
successful follow-up correlation; native error results could also lose their
specific failure reason behind the pending-follow-up EOF check.

The loop now handles root-owned exact initial/pending prompt terminal failures,
excludes `is_error` from successful correlation, and classifies terminal errors
before checking remaining successful correlations. Local cancellation retains
precedence. Foreign, child-owned, unknown-state and already-settled UUIDs remain
non-authoritative. A command's `completed` notification alone still requires a
result. Commit `b32f9374` adds fifteen portable regressions, including deterministic
read-past-terminal negative controls instead of waiting for a timeout.

### Claude ambient tasks and visible completion

The pinned SDK's `SDKBackgroundTasksChangedMessage` explicitly says ambient tasks
are not activity, including long-lived update watchers. The existing lifecycle
counted all roster entries as active delegated work. A normal final answer could
therefore become provisional and continue reading the persistent Query because
only an ambient watcher remained. The follow-up tests distinguish ambient work
from foreground delegates and exercise replacement roster/flag transitions.
Commit `0fd57338` excludes ambient roster entries and initially ambient typed
subagent-start events. Twenty-two new cases include fourteen ordinary final-result
controls that already worked, plus the reproduced ambient cases.

An already-known foreground child does not acquire a fabricated terminal edge
when a later unordered roster marks it ambient. The existing terminal drain is
bounded; without a typed child terminal edge, the controller conservatively
rejects completion with live descendants. A first test incorrectly equated an
extra iterator read with an indefinite hang; a bounded-drain control corrected
that inference. No shared ledger status or roster-to-edge ownership rule changed.

### Codex malformed protocol versus cancellation

Malformed delegated-work and input-request messages recorded or exposed a
protocol error, then used the same cancellation path as a user Stop request.
After confirmed cleanup, the low-level run could resolve `cancelled` without the
failure. An earlier recorded provider error also masked attempts to infer the
stop cause from the first stored failure. The event boundary now carries an
explicit malformed-protocol cause to terminal settlement, while preserving the
first useful failure detail and exact owned cleanup. Genuine user cancellation
remains separate.

### Codex terminal outcome during cleanup

The public harness could overwrite an already accepted successful or failed
result when a user cancellation arrived while process cleanup was pending. The
low-level run now snapshots cancellation at terminal acceptance; its cleanup
result is authoritative at the public boundary. Unconfirmed cleanup still fails.
Ordered failure/completion/cancellation controls cover both the low-level run and
the public harness, rather than relying on a synthetic low-level result alone.
Commit `71d88a60` adds sixteen cases and updates the existing malformed-input
integration expectation from user cancellation to protocol failure.

## Completion coverage across providers

| Provider | Authoritative ending inspected and exercised | Failure and ongoing-work boundary |
| --- | --- | --- |
| Claude | Root SDK result with matching session/prompt ownership; ordinary final results settle without Query EOF or a later idle event. | Pending accepted follow-ups require correlation; actual delegates require fresh parent completion. Refused prompts, error results, malformed transport, cancellation and EOF fail or cancel explicitly. Ambient watchers are excluded from activity. |
| Codex | Root `turn/completed`, including descendant completion/parent continuation gating, followed by owned process cleanup. | Malformed frames/delegation/input requests retain failure; prior user cancellation and first accepted outcome are preserved. Persistent stdout does not require natural EOF after an accepted terminal. |
| Cursor | Owned ACP `session/prompt` response and stop reason, followed by transport/host-tool cleanup. | Malformed updates and interrupted transport retain failure; foreign sessions and late cancelled content cannot settle or revive the parent. |
| Kimi | Negotiated ACP prompt response, session identity and owned cleanup. | Empty `end_turn` fails closed. Upstream partial-output failures collapsed into `end_turn` remain indistinguishable from success in that protocol; no guess based on prose was added. |
| OpenCode | Prompt admission, owned root activity and root idle, with live descendant and fresh-parent completion requirements. | Initial/stale idle cannot finish accepted work; SSE EOF without completion fails; accepted follow-ups and cleanup retain ownership until settled. |
| Antigravity | Explicit successful terminal result; decoded text or tool events alone do not prove completion. | EOF without result and non-success results fail. First terminal stops further stdout admission; cancellation and process-tree cleanup remain bounded. |

Shared controller regressions exercise all six route identities with completed,
failed and cancelled results after visible text: the saved turn, run state,
workspace run and actual sidebar projection leave Working after exact cleanup.
Late running/text events cannot restore active state. These use the real SQLite
store and shared controller with a fake provider; separate adapter fixtures prove
the provider-specific terminal admission. Existing renderer tests independently
cover terminal overlays surviving detail refresh and transcript activity state.

## Restart and continuation

The generic warning, “The previous run ended when Inertia closed. Send another
message to continue,” belongs to startup recovery of an unfinished turn. Clean
runtime disposal records the distinct shutdown interruption. Eighteen regressions
cover all six route identities after completed, clean active-close and unclean
active-close scenarios. Startup recovery is idempotent, visible chat history is
retained, and opening the runtime does not itself invoke a provider.

Session events persist conversation identity immediately; terminal settlement
also writes the turn's after-session identity. Clean shutdown preserves this
identity for compatible next-send native continuation. An unclean first turn can
lack that terminal identity: current policy records
`missing-continuation-identity`, automatically starts a fresh native session, and
retains visible Inertia history. It does not generally replay that history into
the new provider. This existing fail-closed policy was verified, not changed or
presented as the cause of the reported warning.

All six adapters have native resume paths: Claude `resume`, Codex `thread/resume`,
Cursor `session/load`, Kimi negotiated resume/load, OpenCode existing-session GET
and prompt, and Antigravity `--conversation`. They validate applicable route and
session identity; cleanup does not intentionally delete native session storage.
Actual upstream retention and live account state were not exercised.

## Evidence and review

Focused batches overlap and are not summed as unique tests:

| Check | Result |
| --- | --- |
| Final Claude completion/delegation fixtures | 103 passed across 7 files, including all 22 visible-final and 15 follow-up cases. |
| Final Codex terminal/interaction fixtures | 106 passed across 6 files, including 16 new ordered-outcome controls. |
| Shared durable terminal/restart/cleanup fixtures | 52 passed across 5 files; 36 new cases cover all six provider identities. |
| Independent renderer terminal/sidebar/timeline checks | 67 passed across 3 files. |
| Five non-Claude route baseline | 228 passed across 10 files; 3 native-only guardian checks skipped in this focused pass. |

Final full and portable gate results are recorded in the main audit ledger. Relevant
local logs use the `inertia-provider-`, `inertia-audit-claude-` and
`inertia-codex-terminal-` prefixes under the temporary directory. They are not
committed transcripts. New provider fixtures are marked for the required portable
gate. The final Codex test marker was added after the aggregate portable run;
manifest discovery then included 109 files and the additional sixteen cases
passed independently with one worker. The main ledger records this sequence. Independent review covered exact owner/UUID/session matching, first terminal
outcome, local cancellation precedence, cleanup uncertainty, all-six state
projection, and ambient versus actual delegated work. No timer, cleanup deadline,
assertion budget or native authority check was relaxed.
