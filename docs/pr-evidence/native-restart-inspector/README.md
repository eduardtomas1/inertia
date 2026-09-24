# Native restart and completed-history corrections

## Restart cleanup

Fixture restart requested application quit without the final-exit inspector
closure already used by prepared fixture cleanup. A real Electron control that
keeps an independent main-process debugger attached failed with `forced/settled`
on the original restart helper. Sharing the final-exit observer makes that
control pass: the old process exits with code zero and no signal, the debugger
closes, and a new process presents a usable composer.

The application still owns cleanup and exit. The inspector closes only when
that path reaches `process.exit`; neither requesting quit nor rejecting cleanup
detaches it or bypasses cleanup. Prepared cleanup retains its receipt gate and
its existing exit path.

## Completed history must not start entrance transitions

PR CI `36010886110` on `bd3280e2`, Linux ARM64 Electron job `107671304827`,
reported four running animations on completed patch rows for the full unchanged
15-second assertion deadline. Main attempt 1 had previously reported the same
count on Linux x64.

The unchanged scenario passed in a fresh Ubuntu 24.04 ARM64 container. A bounded
native hidden-window control identified four pending `transform` CSSTransitions,
with `currentTime: 0` and no start time, on completed rows. The new regression
failed before the correction with those four objects. Limiting the inner-row
`@starting-style` transform to running activity prevents completed history from
creating that entrance work. The shown-window case retains every original
assertion; the hidden-window case additionally requires zero pending or running
animations before showing the window, without cancelling or ignoring animations.
Running-row entrance effects and expansion/folding transitions are retained.

The hosted trace records the count but not each animation's property or native
window visibility. The control proves this defect; it does not establish the
exact hosted window event sequence.

## Prepare the Windows test compiler during setup

Windows unit shard 4 job `107671304667` timed out at the unchanged 90-second test
limit. Its retained phase ledger shows 49.7 seconds resolving the compiler and
28.3 seconds compiling, with the first guard probe starting at 78.2 seconds.
The subsequent warm external-module case passed in 6.6 seconds. No failed guard
assertion or demonstrated shipped-installer defect was recorded.

CI shards and Windows release tests now prepare the existing compiler through
`getMakeNsisPath(undefined)` before Vitest starts. This is electron-builder's
existing pinned, checksum-verified tool resolver, not a new tool version or a
replacement cache. Compiler lookup remains in the test. Compilation and native
probe deadlines, the 90-second test deadline, assertions, worker policies and
whole-job budgets remain unchanged. A fresh private-cache local preparation
control downloaded and resolved the compiler, then resolved the same path warm.
The actual Windows compiled guard still requires hosted validation.

## Validation

Earlier restart correction, unchanged by the follow-up:

- Focused lifecycle/cleanup contracts: 41 tests passed.
- Five native inspector/window controls passed in 9.0 seconds.
- All 19 specs calling fixture restart plus activity lifecycle: display 24,
  isolated 18 and runtime recovery two passed, original phase worker counts.
- Seven specs containing the eight earlier ARM teardown failures: 21 passed
  locally with the original two-worker policy. This did not reproduce that stall.

Follow-up validation:

- Real Linux ARM64 failed-before completed-history control: four pending
  transform transitions. Corrected shown/hidden cases: two passed in 3.4 seconds.
- Linux ARM64 Quiet Ledger: one passed in 11.2 seconds; activity controls:
  three passed in 9.7 seconds. Fresh Linux bundle budgets passed.
- Actual compiler preparation in a fresh private local cache: cold and warm
  resolutions passed, returning the same existing compiler file.
- Both changed workflows passed actionlint with only the repository's existing
  concurrency-queue syntax exception.
- Frozen final Node 22.23.2 quality checks and full suite passed: 9,994 tests
  plus seven child controls, 146 skips, 435.15 seconds at two workers.
- Fresh application build passed unchanged bundle budgets.
- Final macOS display controls: three passed in 14.6 seconds; isolated activity
  and inspector/window controls: eight passed in 10.2 seconds, original workers,
  zero retries. All eight reviewed source/test/workflow inputs stayed unchanged.

## Other preserved failures and limits

Main `89b6ab0b74e4349bc26383954b9e4c503c891da3`, CI `35999329890`, attempt 3:

- Intel Electron browser lifecycle failed at first restart with `forced/settled`.
  Its trace does not identify the exact native shutdown phase. The local attached
  debugger control demonstrates a defect without proving that hosted cause.
- ARM Electron passed display tests, then eight isolated scenarios required
  forced termination after confirmed privileged cleanup. All eight recorded
  window destruction (or no retained window), the native exit call, the app quit
  listener tail and native exit returning. None recorded post-cleanup window
  creation or activation. Bounded samples did not produce stacks within their
  existing two-second deadline. This cause remains unresolved.
- Intel packaging passed tests, package smoke, fuses and signatures, then its
  performance artifact upload failed with `ETIMEDOUT` during CreateArtifact.
  Only that proven transport failure received one targeted job retry, which
  passed in attempt 4. The inherited Electron failures still leave main red.

PR `466` at `bd3280e2` also reported nine ARM isolated close failures after
confirmed cleanup. Each captured the app quit listener tail and native exit
returning, without post-cleanup window creation or activation. All bounded
samples timed out without stacks. In the attached-debugger restart scenario,
the old process exited with code zero, the debugger closed, and the replacement
composer became visible; the replacement's later prepared close stalled.
This recurrence remains unresolved and is not claimed fixed by these changes.

Full native trace archives, unit reports and raw logs are retained outside the
repository. Local passes do not certify other platforms or explain the earlier
Windows ARM mascot failure. No dependencies, migration or release version changed;
package smoke, fuses, signatures, checksum and provenance gates remain required.
