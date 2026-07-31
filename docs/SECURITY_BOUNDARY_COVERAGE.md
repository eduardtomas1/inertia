# Security boundary coverage expectations

Global coverage is not a useful signal for authorization code. An authorization
bug usually lives in a branch that no test enters, so these areas carry
**branch-level** expectations and a named owning test file rather than a
percentage of lines.

Coverage is not currently enforced in CI for these paths. This document is the
reviewed expectation; wiring per-path thresholds into `vitest --coverage` is
follow-up work, and the honest status is recorded per row.

| Boundary | Owning tests | Expectation |
| --- | --- | --- |
| Remote frame and request parsing | `tests/server/remote-authority-properties.test.ts`, `tests/main/runtime-process-protocol.test.ts` | Every rejection branch of `remoteCipherFrameSchema`, `remoteRequestSchema`, and `remoteAuthorizationSubjectSchema` is exercised, including bound violations and unknown fields. Fuzzed input must never produce a parsed value that widens authority. |
| Remote authorization and grants | `tests/server/remote-conversation-scope.test.ts`, `tests/main/remote-access-outbound-authority.test.ts` | Every conjunct of `remoteSessionRetainsAuthority` has a test that flips only that conjunct to false. Every operation (`state.get`, `conversation.get`, prepare, commit) has a granted and an ungranted case. |
| Cryptographic session handling | `tests/remote-crypto.test.ts`, `tests/main/remote-access-outbound-authority.test.ts`, `tests/remote-browser-device-keys.test.ts` | Sequence mismatch, handshake replay, discarded-frame sequence poisoning, and non-extractable key operation all covered. |
| Credential vault | `tests/main/credential-vault.test.ts` | Every failure path returns without leaking material; no test fixture contains a real secret. |
| File authority and path containment | `tests/main/secure-file-*.test.ts`, `tests/server/project-identity-refresh.test.ts` | Symlink, realpath, traversal, and stale-identity refusal branches covered on POSIX and Windows shapes. |
| Runtime command validation | `tests/main/runtime-process-protocol.test.ts`, `tests/contracts*.test.ts` | Each command parser rejects extra keys, wrong id shapes, and cross-correlated ids. |
| Provider remote-safety capability checks | `tests/server/remote-prompt-safety.test.ts` | Every known harness has an asserted contract; unknown, missing, throwing, and internally-permissive contracts all fail closed. |

## Rules

- A new branch in any listed file needs a test in that file's owning suite in the
  same change.
- Prefer a test that fails for exactly one reason. A test that would still pass
  with the authorization check deleted is not coverage.
- Do not add tests that only execute a line. Every listed expectation above is
  phrased as an observable refusal or acceptance, not as line execution.
- When a finding is "already fixed", add the regression test anyway and prove it
  fails against the pre-fix code. Two fixes in this pass were verified that way:
  the post-encryption revocation race and the markdown allowlist.
