# v0.0.70 release preparation

This preparation integrates main with #587. It bumps the package and lockfile
root versions from 0.0.69 to 0.0.70, adds the curated 0.0.70 changelog
section, fixes the cause of both Linux release runners' red unit suite on
`v0.0.69`, and adds this report.

The changelog covers every change since `v0.0.69` (`d6543f75`):

- #587 Keep a resumed Claude parent alive when a watcher ends.
- This PR: the OpenCode human-wait test's inactivity window, the version bump
  and the provider review.

This release adds no migration. Schema stays at 92.

## Dependencies

No Dependabot pull request is open. On 2026-10-06 every direct package is
already at its newest version within the configured rules, so this PR changes
no dependency. `npm audit --omit=dev` and `npm audit` both report 0
vulnerabilities.

Deferred, as for v0.0.69: `vite` 8.3.3 and `@vitejs/plugin-react` 6.1.2
(majors, waiting on electron-vite), `@types/node` 26.6.4 (Node 22.13 line) and
`@babel/parser` 8.0.6 (major; Babel 8 requires Node 22.18).

## Providers and SDK usage

Every provider is at the version reviewed for v0.0.69 a few hours earlier:
Codex 0.160.1, Claude Agent SDK 0.3.291 (Claude Code 2.1.291), Anthropic SDK
0.131.0, ACP SDK 1.7.0 (Cursor installer 2026.10.01-e373342), Kimi Code 2.1.1,
OpenCode and its SDK 1.18.34, agy 1.3.0 and MCP SDK 1.32.1.

#587 changes only Inertia's Claude harness. Claude's own session transcript
for the reported failure shows the sequence the new test replays: a reply ends
with a background build and a Monitor running, the build ends and the parent
resumes (`status: requesting`), and the Monitor ends a second later. The empty
roster then re-armed the 2 s parent-resume bound, and the SDK was stopped
before its first output.

## Release CI on `v0.0.69`

Build Linux x64 and Build Linux ARM64 failed one unit test,
`opencode-descendant-interactions.test.ts` "keeps admitted human interactions
open beyond the provider inactivity window": "OpenCode's event stream became
inactive before the session completed". The test allowed 300 ms of provider
silence including the fixture server's startup, which a loaded release runner
exceeded before the first approval. It passed locally 5 of 5 times with the
machine saturated (load average 33), and no OpenCode code changed in
v0.0.69. Both jobs were rerun without code changes. This PR raises the window
to 1 s with 1.5 s human waits, which still proves that admitted interactions
outlive the inactivity deadline.

## Verification

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check:quality` | QUALITY_EXIT | QUALITY_RESULT |
| `npm run build` | BUILD_EXIT | BUILD_RESULT |
| `npx vitest run` | TEST_EXIT | TEST_RESULT |

## Changed files

- `package.json` and `package-lock.json`: the version bump.
- `CHANGELOG.md`: the curated 0.0.70 section.
- `tests/server/opencode-descendant-interactions.test.ts`: the inactivity
  window.
- This release preparation evidence report.

## Publication boundary

This PR's exact head must pass CI, and its merge commit on main must be fully
green before the annotated stable tag `v0.0.70` is placed on that merge commit.
