# Terminal runtime shutdown diagnostic

Main `558395da97498dd06201d7e5802b446272afd56c`, run `35827187837`, macOS ARM
job `107071621254`, failed at `terminal.spec.ts`'s `app.recycleRuntime()`.
The call took 12798.660 ms; supervisor records reported a resource-close deadline
12760 ms after restarting, near the unchanged 12750 ms Darwin shutdown budget.
The existing worker failure event discarded the internal shutdown phase. No
artifact identified the unfinished resource owner.

The later forced Electron termination was the fixture's explicit fallback for
unconfirmed cleanup: it skipped the normal quit callback and allowed zero time
for graceful exit. That receipt does not establish a window-destruction hang.

## Failure evidence added

The terminal fixture and the native attachment send/restart scenario enable
`INERTIA_RUNTIME_SHUTDOWN_TRACE=1` through `additionalEnvironment`. The worker
environment forwards this exact value only under `NODE_ENV=test`; no CI or workflow setting is needed. Successful shutdown
emits nothing.

The diagnostic observes the existing awaits without replacing their promises,
changing invocation order, or modifying deadlines and ownership predicates. It
retains up to 32 intervals from 12 literal owner names, relative times, and
started/settled/rejected states. The existing `RuntimeShutdownDeadlineError`
phase is allowlisted; the original error is then rethrown unchanged. Records
contain no raw paths, commands, environment, content or exception strings.

One exclusive synchronous write, capped at 8192 bytes, completes before the
worker posts shutdown-unconfirmed and the supervisor can terminate it. The
file is `<fixture>/data/runtime-shutdown-trace.json`. The recycle failure catch
copies an existing regular file within that cap to the test's output directory
before fixture removal, independently of the runner's environment. Missing
evidence or copy/write failure cannot replace the original test error.

## Validation and limits

An earlier version of the same owner instrumentation, enabled manually, passed
the single existing terminal scenario in **8.8 seconds** on macOS 26.6.2 ARM64,
Node 22.23.2 and Electron 44.4.3. It used one worker, zero retries, the original
90-second test timeout and 12750 ms shutdown deadline. Its build, notices,
typechecks and unchanged renderer bundle checks passed. It emitted no failure
record. This did not reproduce or identify the hosted failure.

The subsequent fixture enablement and bounded child-control changes have only
focused local validation: **10 tests across two files passed**, plus focused
standard/type-aware lint and unit/E2E TypeScript checks. The controls cover
promise/error identity, ordering, fixed projection and size caps, failure-file
write refusal, and the hung owner's original deadline. The file is verified
complete at the existing worker failure-post boundary and readable after an
owned Node child is killed. The marker wait is capped at 2 seconds and the
post-kill exit wait at 2 seconds; an explicit missing-marker case uses a 200 ms
marker deadline and confirms child exit. There is no asynchronous reporter.

The later combined integration passed 26 native scenarios, including terminal
recycling, and the full local gate; see the [combined report](../combined-review/README.md).
This remains diagnostic coverage, not a proven fix for the macOS ARM shutdown
failure. The hosted owner remains unknown. The separately retained HTTP-owner
sample was synthetic, not native failure evidence.

## Native attachment cleanup follow-up

Combined head `8574a3a65e836e1f2b07286f9fcb5dbbfc64b543`, run `35841843026`,
Linux ARM64 job `107119116668`, failed only during the native attachment
send/restart scenario's `afterEach`. All test-body checks completed, including
post-restart previews and image digests. The first runtime stopped cleanly;
final teardown of the replacement runtime reported `process-tree-stop-unconfirmed`
after 14,501ms. The fixture's privileged-cleanup receipt did not settle within
17,000ms and forced termination followed. A 3,445ms phase query was within its
actual 5,000ms RPC bound; it does not prove a scheduling or transport overrun.

Neither the runtime records nor the lifecycle receipt identifies the unfinished
resource. A process-tree proof failure also cannot distinguish a failed process
snapshot from a still-live or unconfirmed process. No production correction is
supported by that evidence alone.

The specific image scenario now opts into the existing worker trace. On fixture
cleanup failure, a test-owned collector reads it alongside the existing runtime
records before directory removal. It accepts only the fixed regular file under
the fixture's real data directory, rejects symlinks and oversized data, checks
opened-file identity, and projects only known phases, owners, states and bounded
integer timings. Extra fields and arbitrary error content are never attached.
Reading is bounded at 500ms and reporting at 250ms under the unchanged 1,000ms
failure hook; abort prevents late attachment. Original cleanup errors and all
product deadlines remain unchanged.

The collector explicitly reports unavailable, invalid or timed-out evidence.
The worker writes only when its close operation fails: no file does not prove
that a particular owner stalled, or that shutdown never began. This addition
makes a subsequent failure more informative without claiming its cause is fixed.


The final collector and existing cleanup-reporting controls pass 34 focused
tests across two files. They cover the real writer payload, collection before
removal, unchanged error identity, missing/invalid/oversized data, field
projection, bounded reads/reporting and abort handling. File-link rejection uses
a real symlink on POSIX and path-specific link metadata on Windows, where file
symlinks require an additional privilege; the same metadata control also runs
on POSIX. The parent-directory case uses a real junction on Windows. The
unchanged native send/restart scenario passed locally with tracing enabled in
21.6s on macOS ARM64. This successful run did not reproduce the hosted failure.
