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

Only the terminal fixture enables `INERTIA_RUNTIME_SHUTDOWN_TRACE=1` through its
`additionalEnvironment`. The worker environment forwards this exact value only
under `NODE_ENV=test`; no CI or workflow setting is needed. Successful shutdown
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

The final fixture enablement has not received another local native run or full
gate in this task. It is diagnostic coverage for an informative next-head run,
not a proven fix for the macOS ARM shutdown failure. The hosted owner remains
unknown. The separately retained HTTP-owner sample was synthetic, not native
failure evidence.
