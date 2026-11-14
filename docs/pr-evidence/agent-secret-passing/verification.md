# Agent secret passing verification

Validated on Linux x64 with Node 22.23.2, through source revision `6dfeeaa6`. Heavy phases ran sequentially with reduced priority.

| Check | Result |
| --- | --- |
| `npm run check:quality` | Passed: migrations, architecture, color themes, lint and all typechecks |
| Focused secret and redaction suites | 389 passed, 3 skipped |
| Full `vitest run --maxWorkers=4` | 18,090 passed, 1 failed, 107 skipped |
| `npm run test:portable` | 3,565 passed, 3 skipped |
| `npm run build:bundle` | Passed, including all renderer bundle budgets |
| Electron `agent-secret-request.spec.ts`, one worker | 6 passed; actual private Secret Service restore and orphan cleanup ran |

The full suite was not wholly green. `backend-model-discovery.test.ts` received an unexpected `GET /` with `b3`/`traceparent` headers from another local process. That file and backend implementation are unchanged from the calling baseline. Isolated reruns passed 12/12, failed 11/12 with the same foreign request, then passed 12/12. The failure remains recorded rather than being counted as a passing full suite.

The Electron scenarios cover private entry, decline, Settings revocation, detached-window answering, split-output redaction, quit cleanup, keychain restoration and orphan removal. Separate runtime tests cover metadata rejection, linked-root refusal, locked-file recovery, failed forget retries and cleanup during an in-flight save.

No real provider calls, full five/ten-minute provider waits, macOS desktop runs or Windows desktop runs were exercised. Windows lock failures were injected in unit tests. Claude's total tool timeout remains unverified.

The screenshots were captured at `d73d41bb`; subsequent changes affect runtime behavior, schema loading, tests and measured budget accounting, with no product pixel changes. Screenshot binaries live on a separate assets branch and are embedded in the PR.

Bundle measurements and rejected optimization experiments are recorded in [renderer-bundle.json](renderer-bundle.json). The shared matcher measurement can be reproduced with `npm run benchmark:secret-redaction`; it uses structural assertions rather than timing thresholds.

## Synthetic fixture follow-up

GitHub secret scanning flagged two hard-coded renderer test constants introduced in `27c700be`. Both values were invented test data; their provider-shaped prefix caused the alerts. The secret tests now use neutral `fake-token-` and `fixture-` values, with split fragments kept consistent with the fixture constants. Production code and screenshot pixels are unchanged.

After this replacement, all 297 affected unit/DOM tests and all six Electron scenarios passed. The repository scan found no remaining Tailscale token prefix in tracked content. The two historical alerts can be resolved as false positives; the published history is preserved.

## Rebase onto main after custom agents and the thread feel pass

The feature was rebased onto main after #684 (custom agents) and #689 (folded turns, subagent groups, two-row composer). Validated on Linux x64 with Node 22.23.2.

| Check | Result |
| --- | --- |
| Migrations, architecture, color themes, workflow concurrency, both lints, all typechecks | Passed |
| Full `vitest run --maxWorkers=4` | 19,574 passed, 5 failed, 107 skipped; all 5 fixed and their 9 files rerun: 257 passed |
| Electron `agent-secret-request.spec.ts`, one worker | 6 passed |
| Renderer bundle budgets | Passed, each raised only to its measured size |

- The request table is migration 116, after custom agents (115). It now adds `messages.secret_request_json` only when the column is missing, like 115, because older-schema upgrade tests keep later columns; a test covers an existing column.
- Grok, added to main after this branch, gets the card over its ACP MCP host tools with the same ten-minute wait as Codex, Claude and OpenCode. Grok's bundled docs give both 60 and 6,000 seconds as the MCP tool timeout, so it was measured: over `grok agent stdio` 1.0.77 with the server passed in `session/new`, as Inertia does, a 90-second and a 630-second MCP call both returned their result.
- The E2E opens the settled turn's "Worked for" fold instead of Run details, which #689 replaced.
- The screenshots were recaptured on the rebased build.
