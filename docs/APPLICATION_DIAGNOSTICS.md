# Offline application diagnostics

Open **Settings → Diagnostics** to read the newest warnings and errors, filter by
severity/subsystem/provider/project/time, or search explanations, codes and
correlation references. Expand an incident for the observed cause, uncertainty,
next step, timestamp and occurrence count. Original inline errors remain visible.
Main-workbench errors and turn failure details link to the relevant incident or
turn. Detached chats retain their existing failure details/copy action; open the
main workbench's Settings to inspect the application-wide history.

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
- `src/main/runtime-diagnostics.ts` keeps the existing protected, rotating local
  journal. Its new application envelope coexists with lifecycle records; legacy
  support summaries and Lifecycle integrity remain unchanged. Old lifecycle
  records are not retroactively invented as application incidents.
- `src/main/application-incident-index.ts` owns queries, deduplication, bounded
  memory fallback and export projection. There is no SQLite read, provider call,
  second watchdog or generic console-capture hook.
- `src/main/application-diagnostics-ipc.ts` authenticates the main renderer,
  validates exact arguments and limits requests. Renderer validation can submit
  only three explicitly allowlisted validation codes, never arbitrary prose.

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
force. Default journal retention is seven days and four 256 KiB files. Reads are
bounded; malformed records are discarded. IPC permits 120 reads/exports/copies
and 20 renderer-validation observations per trusted sender per minute.

A write failure does not fail the operation being observed or recursively log
itself. Bounded in-memory history remains readable, with persistence-unavailable
and dropped-write information shown in the UI. Memory-only records cannot survive
an app exit. The existing clean-shutdown path flushes pending records.

Copy and export work after runtime/SQLite termination. Both omit context IDs and
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

Diagnostics and Report an issue use panel-width-responsive gutters and controls.
The report's primary action is separated from copying/manual continuation and
the saved-progress/new-draft footer. Keyboard order follows visual order, with
visible focus and narrow-panel wrapping. Issue validation/publication semantics
and privacy review are unchanged.

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
