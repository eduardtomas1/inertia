# Security boundary coverage expectations

Global coverage is not a useful signal for authorization code. An authorization
bug usually lives in a branch that no test enters, so these areas carry
**branch-level** expectations and a named owning test file rather than a
percentage of lines.

Linux CI enforces dedicated coverage floors for the Private Connect shared
contract, main-process authority, runtime gateway, secure-file boundary,
and credential vault in addition to the global and renderer baselines. The
table below records the behavioral expectation behind those numeric floors.

| Boundary | Owning tests | Expectation |
| --- | --- | --- |
| Private Connect request parsing | `tests/main/private-connect/protocol.test.ts`, `tests/server/private-connect/runtime-gateway.test.ts` | Strict pairing, request, response, grant, and projection schemas reject unknown fields and bound violations without widening authority. |
| Private Connect authorization and grants | `tests/main/private-connect/service.test.ts`, `tests/server/private-connect/runtime-gateway.test.ts` | Device expiry, revocation, project/conversation grants, Monitor/Collaborate scopes, and exact run/input checks are covered. |
| Browser session handling | `tests/main/private-connect/gateway-server.test.ts` | Fragment pairing, Secure/HttpOnly/SameSite cookies, CSRF, same-origin mutation checks, and single-use WebSocket tickets are covered. |
| Credential vault | `tests/main/credential-vault.test.ts` | Every failure path returns without leaking material; no test fixture contains a real secret. |
| File authority and path containment | `tests/main/secure-file-*.test.ts`, `tests/server/project-identity-refresh.test.ts` | Symlink, realpath, traversal, and stale-identity refusal branches covered on POSIX and Windows shapes. |
| Runtime command validation | `tests/main/runtime-process-protocol.test.ts`, `tests/contracts*.test.ts` | Each command parser rejects extra keys, wrong id shapes, and cross-correlated ids. |
| Provider prompt-safety capability checks | `tests/server/private-connect/runtime-gateway.test.ts` | Every supported harness contract is checked; unknown, missing, throwing, and internally-permissive contracts fail closed. |

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
