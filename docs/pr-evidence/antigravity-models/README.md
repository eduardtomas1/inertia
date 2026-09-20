# Antigravity model discovery — 2026-09-19

## Cause and correction

On base `19d80157`, Antigravity has no available or probeable metadata fields,
no metadata-reader branch, and an unavailable model-discovery capability.
An installed, runnable CLI therefore always has an empty model catalog;
refresh never invokes a reader. The chooser correctly retains only its
synthetic **Provider default** route. Authentication and model discovery are
independent, so signing in cannot repair this omission.

The regression `loads and retries the Antigravity catalog independently of its
ready installation` failed before the implementation change: the injected
reader was called **zero** times instead of once. It passes after enabling
Antigravity's model field and routing it through `agy models`.

The selected executable, existing metadata cache, installation lease, backend
validation, and renderer projection remain authoritative. The reader accepts
bounded slug/name columns from stdout after a successful exit and confirmed
process-tree retirement. It never uses stderr as catalog data or exposes raw
provider failures. Invalid or failed refreshes remain unavailable/stale and
retry. Catalog entries establish no default, image input, reasoning options,
Fast mode, or context window.

## Upstream evidence

- [Official headless model selection documentation](https://antigravity.google/docs/cli/headless/#select-a-model-effort-or-agent)
  documents `agy models`, its slug/name output, and passing the slug with
  `--model`. No JSON model-list flag is documented.
- [Official installation documentation](https://antigravity.google/docs/cli/install/)
  links the [official installer](https://antigravity.google/cli/install.sh).
  The installer was inspected, not run.
- Its [macOS ARM64 release manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json)
  identified CLI **1.2.7** and the
  [Google-hosted archive](https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.7-6731160148115456/darwin-arm/cli_mac_arm64.tar.gz).
  The downloaded archive matched the manifest's SHA-512:
  `e26032ce420985a18e720b6ec1c09d8360aed851d3e3345148c9a052b7918989a52b62dd2c8db453599ea341b8b29720737846ffd37dd9c68b6bc6ece4a05994`.

The binary was extracted only to a private temporary directory and invoked
with a synthetic HOME/config/cache/workspace. macOS sandbox policy denied
the real home, external network, keychain/browser services, other executable
launches, and writes outside that temporary directory; loopback networking
was allowed for the CLI's local listener. Each invocation had closed stdin
and a bounded process-group deadline.

Observed: `--version` returned `1.2.7`; `models --help` advertised a model
listing and only help flags; signed-out `models` exited **1** promptly with
empty stdout and an instruction to sign in interactively. It did not launch
interactive authentication. No CLI was installed or upgraded, and no
real-account sign-in or model inference was performed.

## Verification and limits

Focused coverage includes catalog parsing and terminal escapes, malformed
and oversized output, stderr/nonzero-exit rejection, environment filtering,
cache freshness and retry, actual fixture discovery through chooser selection
to the exact `--model` argument, backend validation, and process ownership.
Deadlines are triggered after fixture readiness to avoid platform startup
timing races. Cancellation during natural-close retirement cannot publish
models.

Natural completion with a lingering descendant retires the guardian claim.
Forced cancellation after a descendant fork on macOS deliberately retains
the guardian's existing `NOTE_FORK` uncertainty and durable claim, even after
known processes stop. The new reader propagates this cleanup failure; the
guardian policy is unchanged.

Verified on macOS ARM64 with Node **22.23.2**:

- Initial focused run: **117 tests in 6 files** covering catalog, cache,
  harness, manifest, backend validation, and chooser routes.
- Additional negative controls exposed permissive handling of leading NUL,
  C1, and bidi characters in an earlier parser. The final catalog-only run
  passed **31 tests**, including all three controls.
- Final `npm run test:portable`: **100 files passed; 1,417 tests passed,
  9 skipped**. No production/test files changed during that run or afterward.
- Final `npm run check`: **869 files passed, 16 skipped; 9,287 tests passed,
  145 skipped**, followed by successful production/private-connect builds
  and renderer bundle budgets. Workflow, migration, architecture, theme,
  lint, and all type checks passed.

Local command logs are `/tmp/inertia-antigravity-focused.log`,
`/tmp/inertia-antigravity-catalog-final.log`,
`/tmp/inertia-antigravity-portable-final.log`, and
`/tmp/inertia-antigravity-check.log`.

An authenticated live catalog was unavailable on this machine. Successful
catalog enumeration and selection use deterministic fixtures following the
official format. Native Windows/Linux execution and the user's other PC were
not exercised locally.
