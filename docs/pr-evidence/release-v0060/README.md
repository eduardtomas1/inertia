# v0.0.60 release candidate

This candidate retains the reviewed changes and seven refreshed README
screenshots from #424, the clock-fixture correction from #425, and the
scroll-measurement correction from #426. Versions 0.0.58 and 0.0.59 remain
unpublished with their existing tags unchanged. The changelog carries the
complete user-facing changes since the last published version, 0.0.57.

## Windows installer failure

The v0.0.59 exact-tag release run `35490577320` passed the other five native
platforms but stopped before upgrading the Windows ARM64 predecessor. The
unchanged, checksummed 0.0.57 installer exited 2 because its bounded installed
process query could not finish. Its native PR/main counterpart passed.

A fresh ARM64 reproduction under the release's Git Bash launcher
(`35498345995`) failed the original installer in 17.2 seconds and its actual
compiled guard in 15.5 seconds. The guard recorded the native Sysnative
interpreter and the raw `nsExec` result `timeout`. This reproduced independently
of the preceding unit suite.

A same-machine Bash → PowerShell → Bash comparison (`35499182643`) isolated
the inherited module environment: the same native query took 32.8 seconds,
0.86 seconds and 23.0 seconds respectively. Phase measurements put the delay
before process enumeration, during command discovery for `Get-Item`.
Removing the module-path environment variable did not cure the delay.

The follow-up (`35499515661`) measured 31.8 seconds for the inherited query,
22.6 seconds when setting a native module path only in the child environment,
and **0.95 seconds** when assigning that interpreter's `$PSHOME/Modules`
inside the query before command discovery.

## Correction and preserved boundaries

- Setup and the smoke test's process census restrict module discovery inside
  their native PowerShell query. They require only Windows' built-in modules.
- Stable and Canary Windows installer smoke steps use PowerShell, matching
  native CI. This also lets the immutable 0.0.57 predecessor run in the already
  validated native CI environment; its bytes are not patched.
- The installer still has its 15-second query deadline, refuses live owned
  processes, rejects unsafe roots and unavailable identity queries, and never
  force-closes the application. Restricted-policy inline execution remains
  covered.
- Compiled native guard coverage exercises inherited and custom module paths,
  live installed processes, a simultaneously running sibling outside the root,
  a drained installation, a fresh destination and an invalid root. An empty
  custom module path also passes with the old guard, so it is compatibility
  coverage, not failure-before evidence. The actual ARM64 reproduction above
  supplies that evidence.
- No dependency graph, migration, credential boundary, package fuse, checksum,
  provenance or performance limit is weakened.

## Validation scope

The complete local Node 22 gate passed 9,341 tests, with 146 platform-dependent
skips, plus type, lint, architecture, migration, theme and build checks. Focused
packaging and process-drain coverage passed 44 tests with one native Windows
skip. The final candidate additionally requires native compiled-guard checks,
all six native PR targets, and its own exact-tag release certification before
publication. CI and the release workflow record those results on their exact
commits; this document does not substitute for them.

Provider code and dependencies are unchanged by this candidate. The integrated
portable-contract evidence and platform limitations in
`../release-v0058/README.md` still apply. Authenticated Antigravity listing was
not available locally. Linux Snapshots remains X11/AT-SPI only; macOS and
Windows packages remain manual installs when signing credentials are absent.
