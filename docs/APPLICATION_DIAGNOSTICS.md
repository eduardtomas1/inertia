# Offline application diagnostics

Open **Settings → Help → Diagnostics**. It has two parts:

- **Diagnostics**: the *Capture diagnostics* switch, the actions *Export…*,
  *Copy support summary*, *Reveal log folder* and *Clear history…*, and a
  two-line process health block (memory and CPU per Inertia process, local
  service state, lifecycle state and active turns). These moved here from
  Data, which now shows storage only.
- **Recent events**: one list, newest first, of lifecycle events (app start and
  quit, runtime state and failures, restart requests, runtime stderr, renderer
  crashes, database recovery, capture and clear markers) and incidents. Filter by
  level, source and time, or search. Each row is a button; expanding it shows the
  catalog explanation, outcome, codes, counts, first/last seen and the existing
  *Open affected conversation*, *Open … settings* and *Copy incident* actions.
  Lifecycle events show their allowlisted fields in a bounded code block.

Original inline errors remain visible. Main-workbench errors and turn failure
details link to the relevant incident or turn; the linked view shows one *Show
all* link. When the linked record is missing, the page says whether capture is
off or the record left the retained history. Discord settings say "Diagnostics
capture is off, so this was not recorded." when a failure produced no record.
Detached chats retain their existing failure details/copy action.

## Capture switch and always-on events

Capture is on by default. The choice is stored by the main process in
`userData/diagnostics-preferences.json` (no-follow open, 512-byte cap, strict
two-key parse, atomic private write) and read before the journal is created, so
it applies from the first event of a launch. A temporary file left by a write
interrupted by a crash is removed when the journal opens. Turning capture off flushes pending
incidents, writes a `diagnostics.capture-stopped` marker, then stops all other
recording: incidents and gated lifecycle events are dropped before they reach
memory or disk and are not counted as dropped writes. Turning it on writes
`diagnostics.capture-started`.

These events are recorded even while capture is off, so a crash report is never
empty: `app.start`, `app.stop`, `runtime.failure`, `runtime.restart-requested`,
`renderer.crash` and the `diagnostics.capture-started`, `capture-stopped` and
`history-cleared` markers.

`createIncidentReporter` returns `null` when the sink reports that nothing was
stored, so main-process callers (Discord release info, credential vault,
renderer validation) return no incident reference while capture is off.

## Clear history

*Clear history…* asks once (Cancel has initial focus; Escape cancels; focus
returns to the trigger). The main process checks that neither `logs` nor
`logs/runtime` is a link, revalidates the fixed directory (mode 0700), deletes
only files matching
the journal names (`runtime*.log`, `incidents*.log`) and leftover
`.runtime-diagnostics-*.prune.tmp` files without following links, resets the
in-memory index and counters, and then writes `diagnostics.history-cleared`,
which is the first record afterwards. Other files in the directory are kept.

## Runtime stderr and main-process failures

The runtime utility process is started with stderr piped (stdout stays ignored)
and read continuously so it can never block. Each line is matched against a
fixed list of runtime messages (scheduled database backup failed, migration
rolled back, system sleep accounting, unpublished turn updates and settlement
snapshots, unsaved turn diagnostics, unreadable review summaries, Git scan
cleanup, rejected terminal resume) and journaled as `runtime.stderr` with a code
and count only; the text is never kept. Every other line, including stack
frames, becomes one `runtime stderr line omitted` entry with a count, written
at most every 5 seconds. Lines are capped at 4,096 characters (a longer line is
discarded and counted once) and records at 20 per minute; the excess is folded
into the next omitted count.

Main-process failures that a user can act on are journaled as `main.failure`
with a fixed code and no message: app update preparation or start failed,
shutdown cleanup did not finish, Private Connect did not stop cleanly, temporary
attachments could not be removed. They are still written to the console. A
main-window renderer crash is journaled as `renderer.crash` with Electron's
reason and exit code. A database restored from backup or started empty is
journaled once per recovery as `runtime.database-recovery` with outcome,
trigger and counts; the backup file name is omitted.

The Codex app-server `diagnostic` field was kept: the Codex harness reads it to
classify provider failure messages, so it is not test-only.

Diagnostics are observational. They never retry work, send a Discord message,
restart a provider, override quarantine, or decide that silence proves a hang.
Recovered conditions are distinct from historical failures and unknown external
outcomes. Deleted/unavailable conversation references cannot launch new work.

## Ownership and data boundary

- `src/shared/application-diagnostics.ts` defines the versioned, strict code
  catalog, references, metadata and query schemas. Prose comes from reviewed
  definitions, not exception strings. Severity, subsystem and operation are
  derived from the code.
- `src/node/application-incidents.ts` validates observations before delivery.
  Runtime incidents cross the existing validated utility-process protocol. The
  supervisor rejects stale generations; the renderer cannot impersonate them.
- `src/main/runtime-diagnostics.ts` owns the capture switch, the always-on gate,
  clear history and the merged event/incident queries. Records are written to
  two rotating file families in the same protected directory:
  `runtime*.log` for lifecycle events and `incidents*.log` for incidents, each
  with its own four 256 KiB files, so incidents cannot evict lifecycle events.
  Incidents written by older versions into `runtime.log` are still read.
  `diagnostic-journal-files.ts` holds the file I/O (no-follow, 0600, rotation,
  record pruning); `runtime-diagnostic-records.ts` the strict record schema and
  field allowlists; `runtime-diagnostic-events.ts` the event names, titles and
  the always-on set; `runtime-support-summary.ts` the support summary text.
- `src/main/application-incident-index.ts` owns incident deduplication, bounded
  memory fallback and the export projection for incidents and events. There is
  no SQLite read, provider call or second watchdog. Console output is not
  captured; runtime stderr is classified into fixed codes as described above.
- `src/main/application-diagnostics-ipc.ts` authenticates the main renderer,
  validates exact arguments and limits requests. Renderer validation can submit
  only three explicitly allowlisted validation codes, never arbitrary prose.
  `inertia:diagnostics-set-capture` accepts only a strict boolean and
  `inertia:diagnostics-clear` no arguments; both use the report rate limit
  (20 per sender per minute) and return fixed error sentences. The preload adds
  `setDiagnosticsCapture(enabled)` and `clearDiagnostics()`.
- `src/main/diagnostic-export.ts` also exports
  `exportDiagnosticsForReport({ sinceMs, maxBytes })` for issue reports:
  incidents, warning and error events, and the capture and clear markers at or
  after the `sinceMs` epoch time (routine info events are left out so they
  cannot push incidents out), with the same identifier omission and pseudonyms
  as the user export, newest first, trimmed at a record boundary to `maxBytes`
  (at most 512 KiB) and marked `"truncated": true` when trimmed; an empty
  string when nothing was captured.

Incident context accepts existing provider IDs and validated UUID references,
not labels. Friendly project/chat names are resolved from existing renderer
state. Metadata is limited to bounded HTTP status, exit code and silence duration.
Prompts, responses, source, raw errors/stacks, request bodies, credentials and
webhook/capability URLs are not accepted into incident storage or delivery.

The same incident identity retains its first/last timestamps and occurrence
count. Identity or code changes are rejected; recovered episodes cannot be
revived by late observations. Original request context is captured before async
dispatch, and terminal incidents are emitted only after authoritative settlement.
A propagated request rejection reuses the terminal incident rather than creating
a second report of that failure.

## Limits and offline behavior

The catalog exposes the limits used by producers and UI: 500 retained incidents,
25 rows per page (maximum 50), 2 KiB per input event, 64 pending writes, 512 KiB
per export, and coalesced 250 ms journal/notification work. Existing journal
retention, rotation, fixed paths, private modes and symlink protections remain in
force. Default journal retention is seven days and four 256 KiB files per
family (lifecycle and incidents). Reads are bounded; malformed records are
discarded; a prune file left by a crash is removed on first use. IPC permits 120
reads/exports/copies and 20 renderer-validation, capture or clear requests per
trusted sender per minute.

A write failure does not fail the operation being observed or recursively log
itself. Bounded in-memory history remains readable, with persistence-unavailable
and dropped-write information shown in the UI. Memory-only records cannot survive
an app exit. The existing clean-shutdown path flushes pending records.

Copy and export work after runtime/SQLite termination. Export includes the
filtered lifecycle events next to the incidents. When the result would exceed
512 KiB, it keeps the newest records that fit and adds `"truncated": true`.
Both omit context IDs and
generation identities and use per-export correlation pseudonyms. Export uses the
native Save dialog and a main-owned, bounded, private-permission atomic writer.
It rejects link/non-file destinations, never accepts renderer-supplied content or
paths, and reports cancellation separately from a successful write. Browser
downloads remain blocked by the existing desktop security policy. Nothing is
uploaded automatically.

## Initial execution paths

- Discord repository/webhook validation, vault failures, release fetching,
  bounded-comparison fallback, rejected delivery and unconfirmed delivery.
- Authoritative installed-provider readiness/authentication failures and recovery.
- Failed terminal turns, provider startup/connection failure and the existing
  inactivity/lifetime deadlines.
- Runtime unexpected exit, restart and reconnection through the existing
  supervisor, plus centralized command rejections (including Git/terminal).

The existing `TurnTimeoutCoordinator` observes a silence episode at the smaller
of 60 seconds or half the configured inactivity deadline. It warns once, excludes
approval/input waits, and ends or recovers that observation. It does not alter
the existing cancellation or lifetime-deadline semantics, and does not log token
events.

## Discord correction

Large GitHub comparisons exceeded the previous response cap. The bounded fetch
now falls back to published release notes and a full comparison link instead of
inventing feature descriptions from filenames. Summaries use actual release
notes and at most five commit subjects. Supported HTTPS hosts are validated;
redirects, fetch size and duration remain bounded. One explicit POST requests a
Discord delivery receipt (`wait=true`). A timeout, invalid receipt or server
failure is **unknown delivery**, not proof that nothing arrived. There is no
automatic resend. No real webhook or public test message is needed by the tests.

Discord owns its field styling instead of using the removed provider-alias
selector. Repository and masked-webhook inputs have separate labels/help text;
vault controls and the explicit send action remain visually grouped. Electron
geometry assertions verify this when navigating directly to Discord settings.

## Files and reporting UI additions

Files uses the existing authoritative workspace Git status, not a subprocess per
row and not a new filesystem watcher. A bounded map supplies status/staging
badges and directory markers. It inspects at most 128 repositories and 4,000
changed files, with 32 ancestor markers; partial/unavailable status never claims
that unbadged files are clean. Scope changes discard old status. Save/refresh
requests a coalesced status-only refresh, without fetching full diffs.

The edit dialog retains a native textarea for selection, IME, clipboard, undo and
guarded saving. Syntax colors are a non-interactive mirror using the existing
highlighter and its character/line limits. Stale, composing, oversized and
unsupported content uses plain text; highlighted HTML never becomes saved text.

Diagnostics uses the shared 810 px Settings column and a container query for
narrow widths. Report an issue uses the same column; its form, preview and
publication states are described in [Issue reporting](ISSUE_REPORTING.md). With
Attach diagnostics on, the report embeds this page's pseudonymised export of the
last 24 hours, obtained by the runtime from the main process.

## Verification and limitations

Local full gate on 2026-09-09: `npm run check` passed (8,200 tests passed,
83 skipped; 757 test files passed, eight skipped), including migration lineage,
architecture, lint, typechecks, production builds and renderer byte budgets.
Environment: Linux x64, Node 22.23.2 and Electron 44.2.0.
The three focused Electron scenarios passed against that production build
(28.0 seconds); the 18 checked-in screenshots come from this final run.

Deterministic unit/integration coverage checks strict classification, exclusion
of secrets through real producer/storage/export paths, identity/deduplication,
retention, malformed records, disk failure, unauthorized senders, stale runtime
generations, terminal settlement and controlled-clock inactivity/wait exemptions.
DOM coverage checks filters, paging, navigation, offline states, Git ownership,
stale scope and native editor behavior.

The focused Electron specs are `diagnostics.spec.ts`, `file-git-editor.spec.ts`
and `issue-report.spec.ts`. They use isolated profiles/workspaces and supervised
fixture binaries, not the user's app or credentials. They exercise main/runtime
incident delivery, restart persistence, offline clipboard/native file export,
real Git status/save/refresh, native keyboard undo, mirror scroll alignment,
dark/light layouts and report controls. Export substitutes only the OS picker;
the IPC, filtering and file write are real. No GitHub issue is published by them.

Local desktop evidence is Linux x64/Electron on Xvfb. Native Windows/macOS,
signed packages, authenticated provider turns, IME systems beyond synthetic
composition events, and real Discord delivery are not claimed as locally proven.
Provider protocols, dependency versions and release/version state are unchanged.

The build gives the lazy Diagnostics component and catalog dedicated byte
budgets and verifies neither enters the main/detached first-load closure. Small
explicit feature-byte allowances account for navigation and bounded file badges;
existing safety, lifecycle, packaging and test gates are retained.

See the [visual evidence gallery](pr-evidence/offline-diagnostics/README.md).

### Capture switch rework (2026-10)

macOS arm64, Node 22.23.2, Electron 44.4.5: `npm run check:quality`, `npm test`
(11,473 passed, 140 skipped) and `npm run build:bundle` passed.
`diagnostics.spec.ts`, `diagnostics-appearance.spec.ts` and `settings.spec.ts`
each passed three times in a row. Unit coverage: `diagnostics-capture`,
`diagnostics-preferences`, `runtime-stderr-journal`, `diagnostic-export`,
`application-diagnostics-ipc`, the preload bridge and the Diagnostics and
Discord DOM tests. A real main-window renderer crash and real runtime stderr from
a failing database backup were not reproduced in Electron; both paths are
covered at the unit layer. Linux and Windows were not run locally. Screenshots
are in the [rework gallery](pr-evidence/diagnostics-and-issue-report/README.md).
