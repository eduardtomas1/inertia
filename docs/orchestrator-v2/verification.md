# Verification record

## Environment and scope

- Inertia source base: `9340d9f2b66a880890337d1b1563d5944ce7025d`, package `0.0.80`.
- Platform: macOS / Darwin arm64.
- Runtime used: Node `v22.23.2`, from `/opt/homebrew/opt/node@22/bin`; the default shell's Node 26 was not used for repository checks.
- Change scope: research documentation under `docs/orchestrator-v2/`. No production source, schema, dependency manifest, lockfile or provider protocol change.

## Executed repository verification

```sh
env PATH=/opt/homebrew/opt/node@22/bin:$PATH npm ci
env PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run check
```

Both completed with exit code 0. `npm run check` included workflow concurrency validation, 106 immutable database migration lineage entries, architecture checks, generated color-theme consistency, standard and type-aware lint, TypeScript checks, the complete configured Vitest suite, Electron/Vite bundles, the private-connect build and renderer bundle budgets.

Vitest reported **1,404 passed / 13 skipped test files**, and **17,600 passed / 149 skipped tests**. The skipped tests were not treated as executed. The log includes expected fault-fixture output and Happy DOM iframe-load diagnostics; the suite and enclosing command completed successfully.

Local logs are retained at `.cache/orchestrator-v2/npm-ci.log` and `.cache/orchestrator-v2/npm-check.log`. These ignored files are not part of the PR. `npm ci` reported one moderate audit finding; no dependency change or automatic audit fix was made in this documentation task.

The independent Inertia study separately passed **5 files / 85 tests** for continuation policy, authoritative run state, bounded interleavings, provider capability manifest and host harness capabilities. Its exact command and scope are recorded in [inertia-current-state.md](inertia-current-state.md). These tests overlap the full suite; the counts should not be added together as unique coverage.

## Research evidence validation

The [manifest](source-manifest.json) pins Inertia, the upstream PR merge, the audited T3 main commit, release observations and selected evolution commits. The T3 source map was generated from paths verified to exist in the local pinned checkout. Checks cover local link targets and line bounds, pinned upstream paths/symbol anchors, internal headings, JSON syntax, balanced code fences and whitespace. External links outside the source checkout are citations, not a claim that every URL received a fresh HTTP request.

T3 implementation/test sources were read, selected post-merge diffs were compared, and the original merge was checked for disputed claims. No T3 tests were executed. “Traced” and “located” in the coverage document are source-audit levels, not test results.

The independent Inertia researcher also cross-checked the comparison and index against its audit and found no material factual contradictions. Its suggested clarification—that compaction has exact provider correlation without a durable chat turn—was incorporated into the proposed-contract discussion. The review record preserves the fingerprints it reviewed; the subsequent one-sentence clarification intentionally changes the comparison's fingerprint.

## Not exercised

- Authenticated live Codex, Claude, Cursor, Pi, OpenCode, ACP or other provider behavior.
- T3's desktop, web or mobile UI and its full test suite.
- Inertia Electron Playwright scenarios, packaged desktop smoke tests, release signing/provenance/fuse checks, or Windows/Linux execution.
- Separate portable-provider, Windows Codex or Linux packaging commands; no corresponding production boundary changed in this PR.
- Upstream performance benchmarks; performance commit titles are historical evidence, not reproduced measurements.

This research establishes a reviewed design basis. Runtime behavior should be proven with focused fixtures and the relevant platform/provider gates when implementation begins.
