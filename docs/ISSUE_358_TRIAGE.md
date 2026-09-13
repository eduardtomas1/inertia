# Additional release review (#358)

This is a bounded triage of the new review against candidate `d0387990` and
the exact public v0.0.54 source, `3121f2098b0f93d8c8c16efd3df967f6cc9c4549`.
The issue's count and severity labels are external review claims, not a list
of independently verified defects. Issue #358 remains open.

## Text sanitizer correction

**W2 is new in v0.0.55.** The control-tag expression had overlapping optional
whitespace matches. An incomplete tag could therefore stall the runtime before
the output byte cap was applied. The correction binds whitespace after a slash
to that slash's optional group, preserving the existing neutralization and
capture groups. It still checks a control tag that ends beyond the returned
byte prefix; truncating first would miss that case.

A disposable Node process with a 64 MiB heap and bounded output exceeded its
three-second deadline on 200,000 spaces with the original expression. Corrected
inputs of 200,000, 400,000 and 800,000 spaces completed in 2, 2 and 4 ms locally.
These are one-machine observations, not a cross-platform timing guarantee.
The regression test isolates the synchronous work in a child with a four-second
deadline, 4 KiB output cap and no inherited credentials. Existing sanitizer,
managed-agent and context-packet tests retain their behavioral assertions.

## macOS deployment-target correction

**N1 is confirmed and predates v55.** The Darwin compiler invocation omitted
the deployment target and filtered the corresponding environment setting. A
local build therefore declared macOS 26.0 despite the app's macOS 13.0 minimum.
The build now reads the existing declared minimum from `package.json` and
passes it explicitly to clang. Native C source and process authority are
unchanged.

Package smoke checks the guardian's architecture and bounded Mach-O load
commands before parsing the app archive or launching the helper. It rejects a
newer required OS, missing/duplicate/malformed metadata and the wrong platform.
The actual production build script was exercised with a conflicting host target;
its output declared macOS 13.0. The old compiler invocation and omitted package
check each failed their respective negative control. The focused deployment,
architecture and packaged-legal-resource suites passed 29 tests. Actual execution
on macOS 13/14 was not available; native hosted package validation remains required.

## Existing limitations that remain open

- **W1, PDF expansion:** source inspection confirms that cross-reference,
  image and canvas limits do not bound general content-stream decoding in the
  shared runtime's PDF.js path. The admission and decode-limit gap already
  exists in public v54. The review's exact tiny-file and peak-memory figures
  were not reproduced here. A complete fix needs bounded extraction isolation
  and exact cleanup; a single-Flate scan or a worker-thread heap limit would
  not reliably bound all supported decoders and external allocations.
- **W3, large profiles:** restricted candidate preflight rejects a database
  clone above 256 MiB, including growth during migration. That existing bound
  can reject automated updates of a healthy large profile. It does not prove
  that every manual installation or ordinary launch is impossible. A private,
  disk-backed, WAL-inclusive snapshot needs disk/identity/cleanup bounds before
  replacing the current in-memory validation. The cap is not relaxed here.
- **N2, Linux census overflow:** the native guardian's bounded census can fail
  before cleanup with more than 256 direct children. Its source is byte-identical
  to v54. Bounded batching and complete-absence proof need their own native
  lifecycle tests; increasing the cap alone is not a correction.
- **N3, Linux elevation:** the guardian's inherited `no_new_privs` restriction
  predates v55 and prevents privilege-gaining child execution. Removing it
  changes process authority and requires an explicit elevated-child ownership
  and cleanup design. It is not removed as a release workaround.
- **U1/U2/U4:** surface-loader failure handling, review-note prompts and global
  shortcut handling are unchanged from v54. Their source-level concerns remain
  follow-ups; no native prompt failure, missing-chunk incident or keyboard
  failure was reproduced in this triage.

No malicious PDF was sent to the user's app, no over-cap database was created,
and no sudo command or process swarm was launched. The broader structural,
accessibility and repository-policy proposals have not been certified by this
limited pass. Existing signing limitations remain tracked separately in #286.
