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
All four Windows unit shards, both Windows Electron jobs and both Windows
package jobs passed on the follow-up head `22abbc65` in CI `36016227500`.

## Separate native hidden rendering from full-app navigation

The first hidden variant timed out during a hidden `page.reload()` on Linux
x64. Moving its reload before hide did not make the added interaction reliable:
CI `36026529744` on `a8310bad` failed Linux ARM64 and Windows x64 in
`history.dispatchEvent("click")`, and Linux x64 in the subsequent heading check.
The retained traces contain no browser/CDP event stream that establishes the
underlying stall. One local Linux window-manager control reproduced a dispatch
timeout; subsequent controls passed. No focus or dispatch workaround is claimed.

The original shown full-app database/history/virtualization scenario is restored
byte-for-byte. A separate native Electron scenario renders the actual production
React `ActivityGroup` and global/component CSS. It waits for both native hide and
`document.visibilityState === "hidden"` before the first React mount, without
attaching a renderer debugger. Its input retains two running activities and 320
completed patches with `settled=false`. It requires five mounted terminal patch
rows, wrench icons, the exact collapsed summary and zero pending/running
animations before showing the window, then checks the same state after showing.
No animation is finished, cancelled or ignored. This is focused hidden-rendering
coverage; it no longer performs hidden full-app sidebar navigation.

The final fixture fails against the original CSS with four pending transform
transitions at time zero on both macOS ARM64 and Linux ARM64, and passes with the
correction on both. It uses the existing 45-second display-test limit and one
worker. Failure cleanup uses the existing complete-process-tree termination
proof and preserves its private directory if cleanup cannot be confirmed.

## Make prepared-transaction timeout tests independent of child startup

The same run's Intel unit job timed out awaiting a prepared Git callback, then
reported an unhandled transaction timeout and `git-unavailable` in the later
locale test. The old test started a 250 ms deadline, awaited preparation before
attaching a rejection handler, and restored its temporary PATH only afterward.
A temporary 600 ms preparation-acknowledgement delay reproduced that complete
failure cascade. The exact hosted startup delay was not measured.

The two callback-timeout cases now wait for real child preparation with a
controlled clock, then expire the unchanged logical 250 ms deadline. The test
wrapper restores real time before invoking the production deadline callback,
so native tree cleanup uses real time.
An immediately handled outcome races preparation, and awaited afterEach cleanup
expires any pending deadline, waits for settlement and restores PATH before
fixture-directory deletion. Delayed mutation completion is awaited directly.
The production Git runner and every timeout/revocation assertion are unchanged.

The corrected delayed-acknowledgement control passes both cases and the following
locale check. A never-prepared control hits its expected unchanged 15-second
outer limit, then cleans up and lets the following locale check pass without an
unhandled rejection. Temporary controls were removed.

## Preserve evidence for the remaining Intel timeout

Intel package/unit job `107689742472` timed out at the existing 15-second deadline
in the fixed hung-attempt unit control; 9,993 other tests passed. The log did not
identify the awaited operation. Independent source inspection found no proven
missed-listener race. The wrapper's report-file waits and sequential process-tree
settlement waits are separate from its command timeout; neither observation
establishes what stalled on the runner.

A temporary local phase control passed, reaching report close about 206 ms after
report open. The test now reports only its fixed stage and bounded fixed-payload
attempt evidence on failure, preserving it before directory removal. This adds
no retry or shutdown intervention. Command, process settlement, assertions and
the 15-second outer deadline are unchanged. The Intel cause remains unproven.

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

Earlier fixture/evidence follow-up (a8310bad):

- Revised Linux ARM64 hidden-mount control failed against the original CSS at
  the intended four-pending-transform assertion; corrected shown/hidden cases
  passed. Both old and corrected fresh bundles passed unchanged budgets.
- Final macOS activity lifecycle and Quiet Ledger: three passed in 15.7 seconds,
  one worker and zero retries.
- The complete repeated-lifecycle test file passed seven tests plus its seven
  real child-suite controls. Two intentionally failing temporary controls
  verified owner, terminal outcome and stage survive directory cleanup, both
  before and after the normal evidence read. Temporary mutations were removed.
- Exact two-file independent review found no remaining issue.
- Final frozen Node 22 quality, 9,994 full tests plus seven child controls
  (146 skips, 932 passed files) and fresh build passed; full-suite duration
  462.06 seconds, original two workers and unchanged bundle budgets.

Current native-rendering and Git-timeout follow-up:

- Exact final Git-runner file: 31 tests passed on macOS ARM64 and Linux ARM64.
- Exact final display controls (shown history, native hidden component, Quiet
  Ledger): three passed on each platform, 13.7 seconds on macOS and 13.6 seconds
  on Linux, one worker and zero retries.
- Final native fixture with old CSS: expected four-pending-transform failure on
  both platforms. The original shown full-app test remains byte-identical.
- Independent source review found no remaining issue after correcting the native
  helper to require complete-tree cleanup proof.
- A temporary forced-hang control reached the unchanged 40-second parent wait,
  confirmed complete-tree cleanup and removed its private directory (40.6 seconds).
  Temporary fixture edits and the control spec were removed.
- Final frozen Node 22.23.2 quality and full suite passed: 9,994 tests plus seven
  child controls, 146 skips, 932 passed files, 449.32 seconds at the original two
  workers. Fresh build and unchanged bundle budgets passed.

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
Mac ARM64 passed all phases on the following `22abbc65` run. The historical
recurrence remains unexplained and is not claimed fixed by these changes.

Full native trace archives, unit reports and raw logs are retained outside the
repository. Local passes do not certify other platforms or explain the earlier
Windows ARM mascot failure. No dependencies, migration or release version changed;
package smoke, fuses, signatures, checksum and provenance gates remain required.
