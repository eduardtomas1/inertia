# v0.0.69 release preparation

This preparation integrates main `7f05ea97` (#585). It applies the dependency
updates the Dependabot groups define, checks every provider integration
against its current upstream release, bumps the package and lockfile root
versions from 0.0.68 to 0.0.69, adds the curated 0.0.69 changelog section and
adds this report.

The changelog groups the release as Plan tab, Kimi Code, Diagnostics, and
Providers and dependencies. It covers every change since `v0.0.68`
(`2050555f`):

- #584 Fix Kimi plan-mode resume and render the plan as markdown.
- #585 Stop treating the retired kimi-cli as a working Kimi.
- This PR: dependency updates and the provider review.

This release adds no migration. Schema stays at 92.

## Dependencies

No Dependabot pull request is open, and the next scheduled run is on
2026-10-12. This branch applies every update the configured groups define, at
the newest versions on the registry on 2026-10-06, with `npm install
<package>@<version>` and an npm-generated lockfile, one commit each.

| Package | From | To | Dependabot group | Commit |
| --- | --- | --- | --- | --- |
| `vite` | 7.3.6 | 7.3.7 | development-patch-and-minor | `b5518e80` |
| `@anthropic-ai/claude-agent-sdk` | 0.3.290 | 0.3.291 | Excluded (provider SDK); own commit | `60e8f9b4` |

Every other direct package is already at its newest version within the
configured rules. electron-builder 26.17.0 and electron-updater 6.8.10 are on
their `v26` dist-tag, while the registry's `latest` tag still names 26.15.3 and
6.8.9.

Deferred, as for v0.0.68:

| Package | Available | Reason |
| --- | --- | --- |
| `vite` | 8.3.3 | Major; ignored until electron-vite declares Vite 8 support. |
| `@vitejs/plugin-react` | 6.1.2 | Major; moves with Vite. |
| `@types/node` | 26.6.4 | Minor and major ignored; 22.13.17 stays on the Node 22.13 minimum runtime line. |

GitHub Actions: every pin is already the exact commit of its action's newest
patch and minor tag (checked with `gh api
repos/actions/<action>/git/matching-refs/tags/<major>.`): attest-build-provenance
v4.2.2, cache v6.1.0, checkout v7.0.1, download-artifact v8.0.1, github-script
v9.0.0, setup-node v7.0.0 and upload-artifact v7.0.1.

### Audits

`npm audit --omit=dev` and `npm audit` both report 0 vulnerabilities before and
after these commits.

### Runtime dependencies and packaging

The Claude Agent SDK update changes only its own version and its native
optional packages, which move from 0.3.290 to 0.3.291 with the same package
set. Third-party notices are regenerated from the installed production graph
by the build's prebuild step.

## Providers and SDK usage

| Adapter | Inertia before | Inertia after | Upstream current (2026-10-06) | How verified |
| --- | --- | --- | --- | --- |
| Codex App Server (JSON-RPC, no SDK) | Verified against 0.160.1 | unchanged | `@openai/codex` 0.160.1 | Registry; same version as reviewed for v0.0.68. |
| Claude Agent SDK | 0.3.290 (Claude Code 2.1.290) | 0.3.291 (Claude Code 2.1.291) | 0.3.291; `@anthropic-ai/claude-code` 2.1.291 (`stable` tag 2.1.285) | Packed 0.3.290/0.3.291 diff: `sdk.d.ts` is byte-identical, `package.json` changes only versions and the bundled core chunk names. The 2.1.291 changelog fixes dropped permission answers in cloud sessions and lost final messages on quit. The capability manifest pin follows; Claude and manifest suites pass. |
| Anthropic SDK (drift surface, Claude peer) | 0.131.0 | unchanged | 0.131.0 | Registry. |
| Cursor (ACP) | ACP SDK 1.7.0 | unchanged | ACP SDK 1.7.0; the Cursor installer still points at 2026.10.01-e373342 | Registry and installer script read as text. The CLI was not run. |
| Kimi Code (ACP) | ACP SDK 1.7.0; reviewed at 2.1.1 | unchanged | `@moonshot-ai/kimi-code` 2.1.1 | Registry. #584 and #585 were exercised against the real Kimi Code 2.1.1 and kimi-cli 1.52.0 binaries with a local model endpoint (see those PRs). |
| OpenCode (owned `serve --pure`) | SDK 1.18.34 | unchanged | `opencode-ai` and `@opencode-ai/sdk` 1.18.34; OpenCode 2 is `@opencode/cli` 2.0.24 | Registry; OpenCode 2 is still reported as unsupported. |
| Antigravity (`agy` headless stream-json) | Minimum agy 1.2.2; reviewed at 1.2.17 | unchanged | agy 1.3.0 (2026-10-06) | google-antigravity/antigravity-cli 1.2.17...1.3.0 changes only CHANGELOG.md: the conversation view's default verbosity, `/diff` keys, scrolling and path handling for mentions and links, all in the interactive terminal UI. The `--output-format stream-json` headless stream is not mentioned. |
| MCP SDK (host-tool server, Claude in-process tools) | 1.32.1 | unchanged | 1.32.1 | Registry. |

No provider code changes in this PR.

### Not verifiable without a live account

No provider CLI ran against a real account, and the agy 1.3.0 binary was not
run.

## Renderer bundle

This PR adds no renderer code. `mainWorkbenchFirstLoadJavaScript` (873,776
bytes) and `coreJavaScript` (2,281,573 bytes) equal the budgets #584 set.

## README views

No README view shows the Plan tab or Kimi's provider status; the seeded plan
appears only in the Goal panel, which this release does not change. No view
was recaptured.

## Verification

On this branch's candidate head (the two dependency commits, the version bump
and the changelog), on Linux x64:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check:quality` | 0 | Workflow concurrency, migrations, architecture, color themes, lint and typecheck pass. |
| `npm run build` | 0 | Typecheck, electron-vite build, Private Connect build and renderer bundle budgets pass. |
| `npm audit --omit=dev`, `npm audit` | 0 | 0 vulnerabilities. |
| `npx vitest run` | 0 | 1,167 files and 12,974 tests pass; 8 files and 99 tests are skipped by platform. |

## Not exercised

Windows and macOS packaging, installers and signing run in CI and in the
release workflow, not on this machine.

## Changed files

- `package.json` and `package-lock.json`: the dependency updates and the
  version bump.
- `src/server/provider/capability-manifest.ts`: Claude's bundled SDK version.
- `CHANGELOG.md`: the curated 0.0.69 section.
- This release preparation evidence report.

## Publication boundary

This PR's exact head must pass CI, and its merge commit on main is tagged
`v0.0.69` for the release workflow.
