# Windows installer guard failure evidence

## Unresolved hosted failure

Run `35760199099`, Windows unit shard 1 job `106864276341`, timed out the
inherited-modules compiled NSIS guard scenario at 90007.5009 ms. Its two recorded
probes completed with the expected outcomes: expected/actual exit 1/1, query `0`,
4077 ms; then expected/actual exit 0/0, query `1`, 525 ms. Both recorded Sysnative
PowerShell. The external-only modules scenario passed in 3044.3235 ms.

The downloaded `ci-test-results-windows-unit-1` artifact contained only Vitest
results and the shard plan. The old logger appended a probe after both the guard
await and query-file read. These two completed probes do not establish whether
the third probe began or which setup, guard, assertion, or cleanup phase stalled.
The fixture, installer include, bounded process implementation, and trampoline
were identical to main. No cause-specific product fix is established.

## Scenario-owned diagnostic change

`tests/main/windows-installer-guard.test.ts` now records up to 32 phase intervals
through `tests/helpers/windows-installer-guard-diagnostic.ts`. Compiler lookup,
compilation, blocker copy/spawn/close, guard awaits, query reads, assertions,
blocker cleanup, and root removal retain start/end elapsed times and a completion
or rejection marker. A timeout snapshot retains the pending phase, probe index,
expected exit, and root category. The existing `onSpawn` callback records only
the compiler/guard PID and spawn time; no global process instrumentation changes.

The failure hook emits one bounded JSON record with the module-path scenario,
trace, at most two fixture-owned children's PID/exit/signal/stdin state, and at
most four completed probe projections. It attempts the four fixed query-result
filenames, reading no more than 1025 bytes each (a 1024-byte prefix plus a
truncation check). Non-regular files and symlinks are refused. Query content is
reduced to known result codes and a PowerShell path category. Raw paths,
environment values, commands, arbitrary query text, and error strings are not
emitted. The original raw PowerShell path remains private to the existing
Sysnative assertion.

All query reads share a 250 ms reporting deadline; the output step has another
250 ms deadline. Rejection and expiry are best effort and cannot replace the
scenario's failure. Timed-out reads may settle later and close their handles;
diagnostics acquire no process ownership. Normal successful scenarios perform
no extra file reads or output. The original 90 s test, 30 s compilation, 20 s
guard, 15 s PowerShell query, and 5 s blocker EOF-to-kill fallback limits remain
unchanged, as do all assertions and cleanup operations. There are no production
or workflow changes.

## Local validation

The helper regressions cover pending-phase identity, immutable snapshots, phase
and collection caps, field projection, regular-file prefix bounds, query/path
redaction, identical operation errors, rejected reads/writes, hanging reads and
writes, and rejection after a diagnostic deadline. Hanging diagnostics preserve
the original failure and permit the fixture-style `finally` cleanup to proceed.

Final local validation used Node 22.23.2 on macOS ARM64:

- Focused diagnostic helpers and native fixture loading: 11 tests passed across
  two helper files; the two Windows scenarios were skipped on this host.
- `npm run check`: 899 files / 9693 tests passed, 16 files / 146 platform skips,
  plus 7 separate-process tests. Test phase: 116.91 s. Workflow concurrency,
  migration lineage, architecture, color themes, lint, all typechecks, production
  and Private Connect builds, and unchanged renderer bundle budgets passed.
- Independent review of the helper, regressions, and native fixture wiring found
  no substantive issue before push.

Local logs: `/tmp/inertia-pr431-diagnostic-focused.log` and
`/tmp/inertia-pr431-diagnostic-check.log`.

Native Windows NSIS/PowerShell behavior cannot be exercised on this macOS ARM64
host. The hosted timeout cause remains unresolved; this patch improves evidence
for a subsequent Windows run and does not claim to fix it.
