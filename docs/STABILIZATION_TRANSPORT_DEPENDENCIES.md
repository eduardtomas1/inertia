# Transport and dependency stabilization evidence

Scope: comparison against `c9740a51`, disposable synthetic fixtures only.
This is a bounded endpoint review, not certification of every transport or
authenticated upstream provider. Personal profiles and installed user CLIs were
not used for these checks.

## Endpoint inventory

| Endpoint | Envelope / authority / lifetime | Existing proof or change |
| --- | --- | --- |
| Main ↔ utility runtime | Main receives payload; utility receives `event.data`; runtime protocol parser, generation/request identities, sequencing and bounded replay. | `runtime-process-protocol`, `runtime-sync-hub` and runtime integration tests; no common envelope adapter added. |
| Attachment import utility | `event.data` in worker; strict operation UUID/request and bounded validation receipt; exact result ACK; runner owns timeout and drainage. | `utility-worker-result-ack-protocol.test.ts` and real Electron `utility-worker-result-ack.spec.ts`. Existing contract preserved. |
| Conversation attachment store utility | Strict operation identity and encoded-operation bound; exact result ACK; runner bounds active/pending work and returned content. | Same real-worker ACK suite and attachment store tests. Existing contract preserved. |
| Secure-file utility | Endpoint-specific operation schema, UUID and receipt; exact ACK; bounded active/pending helpers, timeout and cancellation. | `secure-file-protocol`, `secure-file-worker`, `secure-file-broker` and broker-cancellation tests. Existing contract preserved. |
| Candidate viability utility | Worker reads `event.data`; exact operation identity, bounded clone/journal work, safe failure code, two-second result ACK deadline. | Candidate viability worker/main tests and updater native evidence. Merged update behavior preserved. |
| Recovery import Node worker | Raw structured-clone message, not an Electron event wrapper. New strict version/operation receipt parser, bounded counts and fixed failure code. | New real-thread tests and existing recovery/export integration. Details below. |
| Read-only backup-validation Node worker | Raw message; result enum whitelist, SQLite closes before posting, successful publication waits for exit zero. | `database-recovery.test.ts` concurrent validation/publication and cancellation tests. Deliberately different cancellation authority, below. |
| Runtime WebSocket | Bounded frame, clients and in-flight commands; capability/origin admission and runtime synchronization. | `runtime-websocket`, detached WebSocket and runtime-sync suites. No new transport abstraction. |
| Private Connect HTTP/WebSocket | Session/ticket authority, strict requests, body/frame/rate/in-flight bounds, HTTP/transport deadlines and disposal. | Gateway-server and runtime-gateway suites. Existing boundary preserved. |

The table identifies existing evidence, not a claim that every listed suite was
re-executed independently in this subtask; final combined gates are recorded in
the main stabilization ledger.

## Confirmed recovery-import defect

An isolated copy of the baseline client was connected to a real Node Worker
that posted `null`. It raised an uncaught `TypeError` while reading `event.ok`
instead of rejecting the operation. The subprocess exited with the diagnostic
code 42. No database or personal data was involved.

The repaired endpoint accepts only its strict version-1 result with the exact
operation UUID and bounded receipt. Wrapped, malformed, foreign and duplicate
messages reject only after the worker has exited. Failure payloads contain a
fixed code, not a path or arbitrary exception message. Privileged worker input
is also validated before opening SQLite.

The caller in `src/server/index.ts` reconciles the recovery journal on rejection,
so failed termination is not sufficient authority: rejection remains pending
until that exact worker exits (or its `threadId` is already -1). The supervisor
retains the outer deadline. A valid committed receipt remains authoritative if
cancellation races exit, including a subsequent nonzero exit code. No new ACK
handshake was added to this Node endpoint.

Focused final proof: 44 tests in `database-recovery-import-worker.test.ts`,
`database-export.test.ts`, and `runtime-recovery-integration.test.ts` passed.
Real-thread cases cover malformed input/output, duplicate and foreign identity,
termination failure, cancellation/commit races, nonzero post-commit exit,
production-worker import, handle release and private-error exclusion.

### Why the read-only validator was not changed

`validateDatabaseOffThread` in `database-recovery.ts` does not authorize primary
database reconciliation on failure. Its caller only attempts removal of an
unpublished `.partial`. `database-backup-cancellation.ts` deliberately tolerates
Windows sharing errors (`EACCES`, `EBUSY`, `EPERM`, `ETXTBSY`) and leaves the
partial for recovery after the owning process exits. Cancellation also races a
non-interruptible read-only validation by design. Successful publication still
requires the valid receipt and exit zero. Copying the import-writer cancellation
contract into this endpoint would conflate distinct authorities.

## Integrated open Dependabot updates

Only updates from the five currently open bot PRs were selected. Transitive
changes follow their dependency graphs; security overrides and Electron fuses
were preserved.

| PR | Direct dependency | Resolved version |
| --- | --- | --- |
| #290 | `lucide-react` | 1.40.0 |
| #291 | `@testing-library/user-event` | 14.6.7 |
| #291 | `@types/react-dom` | 19.2.7 |
| #291 | `electron` | 44.2.0 |
| #291 | `electron-builder` | 26.16.0 |
| #291 | `happy-dom` | 20.14.0 |
| #292 | `vitest` | 5.0.0 |
| #293 | `@vitest/coverage-v8` | 5.0.0 |
| #294 | `@anthropic-ai/claude-agent-sdk` | 0.3.260 |

Vitest and coverage are pinned as an exact matching pair. Lucide is exact
because the range would already select 1.41.0, outside the requested bot PR.
Nineteen suites migrated removed `describe.sequential` calls to explicit
`concurrent: false`; their serialization and assertions remain intact. The
Claude capability manifest now records the actual bundled .260 identity.
Packaging tests retain exact reviewed builder/library pins and all existing
NSIS/native payload assertions.

Compatibility review used the official
[Vitest 5 migration guide](https://vitest.dev/guide/migration/),
[Claude SDK release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.260),
[Electron release](https://github.com/electron/electron/releases/tag/v44.2.0),
[builder release](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.16.0),
[Happy DOM release](https://github.com/capricorn86/happy-dom/releases/tag/v20.14.0),
[user-event release](https://github.com/testing-library/user-event/releases/tag/v14.6.7),
and [Lucide release](https://github.com/lucide-icons/lucide/releases/tag/1.40.0).
Node 22.23.2 and Vite 7.3.6 meet Vitest 5's minimums. New mock/async-assertion
semantics were not disabled; coverage thresholds were not lowered.

Recorded local checks after integration:

- All five TypeScript configurations passed before concurrent runtime edits.
- Renderer plus selected Claude/provider contracts: 1,704 tests / 232 files.
- Portable contracts: 1,061 passed, two platform skips.
- Windows Codex contracts on Linux: four passed, four native-Windows skips.
- Linux packaging contracts: nine passed.
- Builder/SDK identity contracts: 42 passed, one platform skip.
- Full and production-only npm audits: zero advisories, 829 locked dependencies.
- Third-party notices regenerated successfully; SQLite loaded and closed;
  Electron 44.2.0 binary resolved. `npm ls` reports a consistent matched pair.

These are focused integration checks, not substitutes for native Windows/macOS,
full coverage, packaged candidate testing or the final combined-SHA CI result.

## Controlled desktop discovery

The baseline benchmark already enabled discovery through its package-smoke
executable override despite its old report saying “providers disabled”. Report
definitions are corrected. New scoped Codex cases measure installed cold/warm
startup, an unavailable executable, and a version probe that never exits.

The controlled cases use synthetic home/config and an allowlisted environment.
A read-only preflight refuses measurement unless Linux global provider search
roots contain no host CLI. Unsupported/non-isolated hosts report not exercised;
they never silently claim a hermetic result. The existing benchmark launch and
cleanup owner remains responsible for native applications and late acquisition.
The slow fixture must have started and its PID must be absent after graceful
runtime shutdown. Production probe timeouts are unchanged.

Stage definitions distinguish first window, interactive runtime, visible
provider settlement (including opening Settings), and confirmed shutdown.
Existing streaming metrics separately measure command/provider/paint stages.
Native measurements and any failed attempts are recorded in the main ledger;
concurrent test workloads mean validation evidence, not a clean performance
comparison.

Local native result: full desktop benchmark passed (one test, approximately
1.8 minutes, three streaming samples, Electron 44.2.0, private Xvfb display).
Rounded controlled-scenario measurements in milliseconds:

| Scenario | First window | Interactive runtime | Visible provider settlement | Confirmed shutdown |
| --- | ---: | ---: | ---: | ---: |
| Installed, cold | 509 | 1,526 | 1,956 | 277 |
| Installed, same profile | 468 | 1,028 | 1,604 | 330 |
| Unavailable executable | 471 | 1,447 | 1,865 | 196 |
| Deliberately stalled probe | 479 | 1,500 | 5,732 | 187 |

All four scenarios confirmed graceful runtime shutdown. The stalled fixture
proved it started, then its PID returned `ESRCH` after cleanup. The first native
attempt failed because the new locator looked inside a button instead of its
containing provider row; no product change or timeout relaxation was required.
That failed attempt is not counted as a successful run. These samples are
validation, not statistically controlled cold-cache or before/after evidence.
