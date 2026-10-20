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
| Initiative MCP servers and their secrets | `tests/shared/initiative-mcp.test.ts`, `tests/main/initiative-mcp-secret-ipc.test.ts`, `tests/server/initiative-mcp-servers.test.ts`, `tests/server/run-secret-redaction.test.ts`, `tests/server/initiative-mcp-config.test.ts`, `tests/server/initiative-mcp-injection.test.ts`, `tests/server/initiative-mcp-runtime.test.ts`, `tests/server/command-secrets.test.ts` | Malformed, reserved (including `codex_apps`), non-loopback `http:`, shell-shaped and oversized configurations, plain `Authorization`, `Proxy-Authorization` and `Cookie` headers, and variables named after Inertia's own launch credentials are refused at the command boundary; secret values are set only through the main-window IPC channel, refused with a readable message below 8 characters (or 8 after an authorization scheme), stored only in the vault under a reference derived from initiative, server, slot and destination, and answered only as "set"; the set channel accepts only a secret slot of the named transport, at most eight servers per initiative and 32 live references per server; a server moved to another URL or command has no secret until one is entered again, its old entries are forgotten and new slots are cleared before saving (a vault failure refuses the change); a failed removal is retried once and then kept as a reference for the next start; only member chats of non-archived initiatives on supported harnesses receive servers; a caller-supplied resolved list is refused; stdio servers on Claude, OpenCode and ACP get Inertia's launch credentials blanked; resolved values reach only the harness's request and are redacted once, by the run coordinator, as exact values in text-bearing fields only (never keys or identities), buffered across text and reasoning deltas so a value split across deltas never reaches a published event or SQLite, and never lengthening a bounded field; transformed or partial reproductions, including a value a harness's own length limit cut before redaction, are outside this guarantee. |
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
