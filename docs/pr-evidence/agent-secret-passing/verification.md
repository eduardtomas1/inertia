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
