# v0.0.59 release candidate

This candidate retains every reviewed product change and all seven refreshed
README screenshots from #424. Only the three manifest version roots, the
changelog, and a benchmark-diagnostic unit fixture change after `b353c8d0`,
along with this evidence record.
The `v0.0.58` tag remains at that commit and is never moved or reused. Its
release stayed a draft with no public assets.

## Native failure and reproduction

The v0.0.58 exact-tag run `35478940172` certified five native platforms but
stopped on Windows ARM64. Its first attempt rejected the checksummed v0.0.57
predecessor install with exit 2 from the installed-process safety query, before
the candidate upgrade. That unchanged predecessor and complete in-place
upgrade passed in the exact-commit main CI run `35478889271`.

The second Windows ARM64 attempt passed 9,144 tests but failed
`desktop-benchmark-readiness-diagnostic.test.ts`: the real fixture returned the
expected login output, but its marker was rejected. The diagnostic reader
deliberately rejects `observedAt > Date.now()`. Assuming that independently
started processes have perfectly synchronized wall clocks made the unit test
intermittent.

An isolated, branch-only Windows ARM64 probe (`35484905899`, Node 22.23.2)
repeated the unchanged fixture and reader 2,000 times. **269 markers were
rejected**, all with valid `write-completed` JSON whose observation time was
**1–8 ms ahead** of the parent before the read. For example, the child recorded
`1789873213517` while the reader observed `1789873213511`; the file was complete
and the child had exited. A matching macOS ARM64 probe rejected none of 2,000
launches. The probe does not modify authentication behavior or the release tag.

## Correction

The unit test runs the same fixture source with a controlled child clock and
controls the reader's clock independently. It now checks the exact start and
completion times, checks the stale-launch boundary, and explicitly requires
rejection of a marker just one millisecond in the future. The clock spy is
restored in `finally`.

No production code, diagnostic reader, benchmark limit, retry policy,
installer safety check, release workflow or required native gate changes.
There is no tolerance added for future timestamps.

The first exact-tag macOS ARM64 attempt separately exceeded the existing 100 ms
Settings first-open budget at 126.4 ms. The certified PR, exact-commit main CI,
local recheck and full successful native retry measured 30.4, 32.3, 24.2 and
31.9 ms respectively. The limit and all native checks remain unchanged.

## Validation

- Focused diagnostic unit and DOM coverage: **11 tests passed** on macOS ARM64.
- Complete Node 22 local gate: **9,341 tests passed, 145 skipped**; lint, types,
  migration, architecture, theme, build and bundle checks passed.
- Windows ARM64 corrected probe (`35485642865`): **2,000 launches, zero rejected
  markers**, plus all nine tests in the actual diagnostic unit file passed.
- A negative control that removed the reader's future-timestamp rejection failed
  the new one-millisecond-future assertion. The reader was restored unchanged.
- macOS ARM64 production build, packaged third-party notices, Electron fuse
  verification and packaged smoke passed at version 0.0.59, including native
  runtime cleanup, PDF extraction and image retention.
- The unchanged provider/dependency tree passed **1,424 portable tests** during
  integrated certification recorded in `../release-v0058/README.md`.
- The replacement version still requires its own native PR certification and
  exact-tag release build before publication.
- The v0.0.58 main CI run passed all six native targets. That evidence supports
  the unchanged product implementation but does not substitute for certifying
  the replacement version.
- Authenticated Antigravity model listing was not available locally. The
  deterministic provider and native owned-process coverage recorded in
  `../release-v0058/README.md` remains the applicable evidence.
