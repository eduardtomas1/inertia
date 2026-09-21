# Package-size review

Initial package review against main `d56f972b` using Node 22. The transcript
follow-up below incorporates main `67d81d24` through an ordinary merge; it makes
no independent version or release-tag change.

The production graph does not import `tailwind-merge`. The excluded dependency
files are source maps, TypeScript declarations, SQLite build inputs, and foreign
prebuilds; native binaries and dynamically loaded PDF/image/spreadsheet modules
remain packaged. Notices are regenerated from the resulting production graph.

The original macOS resource list duplicated every shared resource. The pinned
builder combines these lists, so macOS now adds only Chromium credits. Its file
lists behave differently: normalization creates a separate shared matcher, and
a negative-only platform matcher triggers include-all. The shared file
inclusions therefore remain in each platform list. Tests exercise normalized
builder matchers, preserve the include-all regression check, and verify unique
resource destinations.

Validation on macOS ARM64:

- Focused packaging/legal tests: 24 passed.
- Linux package contract tests: 9 passed.
- Full `npm run check`: 9,351 passed, 146 platform/optional tests skipped; quality,
  typecheck, production builds and renderer budgets passed.
- Real `npm run build` and `npm run package:mac`, with native rebuild enabled.
- Archive inspection: only `out`, `node_modules`, `package.json`, and `resources`
  at its root; 10,197 entries, zero source maps and zero documentation entries.
- Packaged smoke: actual utility runtime started, PDF extraction and image
  retention passed, and main/runtime shutdown completed cleanly.
- Packaged Electron fuse verification passed with existing protections intact.

The initial PR's macOS x64 failure was the desktop benchmark's Settings-first-open
measurement (359.1 ms against 100 ms), after package/container and application
checks passed. This branch incorporates current main and keeps the benchmark
threshold unchanged. All required native CI checks must pass on the reviewed
head before merge; local ARM64 results alone do not establish Windows, Linux,
or macOS x64 behavior.

The PR's original Windows size comparison reported 13.10 MiB less download and
94.28 MiB less installed storage. Those numbers describe that before/after
measurement, not a new six-platform measurement.

## Follow-up CI investigation

The next macOS x64 run passed package smoke but failed two native scenarios:
runtime recycle exceeded its unchanged 12.75-second shutdown deadline, and an
upward transcript gesture did not expose Jump to latest. The lifecycle evidence
does not identify which resource delayed shutdown; no shutdown fix is claimed.

A deterministic DOM negative control reproduced a reader-intent race: a queued
bottom-scroll event, or a small upward move inside the follow tolerance, erased
fresh wheel intent and let later virtual measurements pull the reader downward.
Keep the existing bounded 750 ms gesture guard through those scroll events.
Explicit navigation and the existing expiry still clear it. The focused
transcript/navigation batch passes all 54 tests, including both event orders.

Both failing native scenarios passed three repetitions each on macOS ARM64 with
two workers. Temporary instrumentation of ignored build output recorded nine
complete shutdowns with no unresolved operation; the longest command-quiescence
phase took 5.79 seconds. The original build output was restored byte-for-byte,
and both scenarios passed again without instrumentation. These eight passes do
not establish the cause of the hosted Intel timeout; fresh native CI remains
required.

The full local gate also exposed a fixture setup timeout while creating 999
loose Git refs. Seed real sorted packed refs in the disposable test repository
instead. The real Git enumeration, current branch, symbolic aliases, 1,000 versus
1,001 branch bounds and production deadlines remain unchanged. All six focused
branch-limit tests pass.

## Retained-intent follow correction

Review found that the 750 ms gesture guard could discard the final content
correction while navigation still followed the latest content. Deterministic
DOM regressions reproduced both streaming and persisted updates leaving a
300 px bottom gap after expiry. Both regressions fail without the fix.

On expiry, retry instant following only when the gesture's conversation is
still active and navigation still follows content. Reuse the existing bounded
measurement correction and final-answer ownership checks. New gestures renew
the guard; history reading prevents the retry, and switching conversations or
unmounting cancels the timer. The queued-bottom-event protection remains intact.

The follow-up changes no package selection, dependencies, provider protocol,
deadlines, coverage requirements or bundle limits. Original native packaging,
smoke and fuse evidence above remains historical evidence for the package
changes, not a claim that new installers were produced for this renderer fix.

Final local validation on Node 22.23.2 / Electron 44.3.0 / macOS ARM64:

- Focused transcript DOM/state tests: 63 passed across five files. The eight new
  cases cover the final streaming/persisted update, fresh wheel/touch/keyboard
  intent, active and pending final-answer ownership, switch and unmount cleanup.
- Full `npm run check`: 9,604 passed, 146 skipped, plus seven separate-process
  tests. All quality checks, builds and unchanged renderer bundle budgets pass;
  packaging selection, legal-resource and Linux contract tests are included.
- `npx playwright test tests/e2e/transcript.spec.ts
  tests/e2e/transcript-turn-anchor.spec.ts tests/e2e/chat-scroll-memory.spec.ts
  --workers=1`: all five native scenarios pass in 36.8 seconds, including both
  4-turn and 80-turn history restoration, long-transcript keyboard/geometry,
  delayed accepted-turn following and final-answer positioning.

This follow-up was not exercised locally on Windows, Linux, macOS Intel, live
providers or newly packaged installers. Hosted CI remains the user's
responsibility; no CI retry, monitoring, PR merge or release was performed.
