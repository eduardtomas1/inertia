# Working in Inertia

This file is the repository-level guide for coding agents. Human-facing setup
and product behavior live in `README.md`; release mechanics live in
`docs/RELEASING.md`.

## Repository map

- `src/main`: privileged Electron main-process code.
- `src/node`: Node-only contracts shared by Electron main and the supervised
  utility runtime.
- `src/preload`: the narrow renderer-to-main bridge.
- `src/renderer`: the React user interface.
- `src/server`: the local runtime, persistence, Git operations, and provider
  adapters.
- `src/shared`: contracts shared across process boundaries.
- `tests`: unit, integration, portability, migration, and packaging coverage.
- `scripts`: architecture, build, release, and packaging checks.

Keep privileged behavior in the main process or local runtime. Do not widen the
preload API or move secrets, filesystem access, Git execution, or provider
process control into the renderer.

## Setup and verification

Use Node.js 22 and install the reviewed dependency graph:

```sh
npm ci
```

Run the smallest relevant test while iterating, then run the full gate before
handoff:

```sh
npm run check
```

Provider protocol changes also require `npm run test:portable`. Windows Codex
discovery changes require `npm run test:windows-codex`; Linux packaging changes
require `npm run test:linux-package`. Build or release changes must preserve
the package-smoke, Electron-fuse, checksum, and provenance checks.

Use the cheapest test layer that proves the behavior:

- Pure state, projection, protocol, persistence, and failure behavior belongs
  in ordinary `*.test.ts` unit or integration tests.
- Renderer focus, keyboard, effect, and state transitions belong in focused
  `*.dom.test.tsx` Happy DOM tests.
- Real geometry, virtualization, xterm, IPC, restart, and packaged desktop
  wiring remain Electron Playwright scenarios in feature-owned E2E specs.
- Upstream provider drift is checked separately by the secret-free scheduled
  canary; deterministic portable fixtures remain the release-blocking contract.

## Non-negotiable invariants

- Spawn Git and provider executables without a shell. Bound runtime, output,
  and input sizes; sanitize child environments; terminate complete process
  trees on timeout or cancellation.
- Keep credentials in the privileged credential vault. Never persist them in
  the application database or expose them to the renderer, logs, issue
  reports, diagnostics, test fixtures, or provider drift jobs.
- Preserve project, conversation, workspace, repository, and run identities
  across every command boundary. Enforce realpath and symlink containment
  before reading, writing, importing, or reversing files.
- Treat the user's working tree as valuable. Do not discard unrelated changes
  or run destructive Git commands. Reversal behavior must remain scoped,
  attributable, and covered by tests.
- Make database migrations append-only and transactional. Test upgrades from
  representative older database fixtures; never rewrite released migrations.
- Validate IPC payloads and trusted origins at the boundary. Keep the preload
  surface explicit and minimal.
- Treat provider output as untrusted. Protocol changes need deterministic
  fixtures for success, failure, cancellation, malformed messages, output
  limits, and clean shutdown.
- Preserve keyboard access, focus behavior, readable labels, and React hook
  correctness in renderer changes.
- Use platform-safe path and executable handling. Cover Linux, macOS, and
  Windows differences explicitly instead of assuming POSIX behavior.

## Dependencies and releases

Keep `package-lock.json` synchronized with intentional dependency changes.
Protocol-facing SDK updates should be isolated and reviewed against their
portable contract tests. Never expose credentials to scheduled jobs that
download latest provider code.

Runtime dependency changes must update generated third-party notices and
packaging verification. Do not weaken action SHA pins, production dependency
audits, Electron fuse checks, artifact checksums, or provenance attestations.

In the final handoff, list changed files, focused tests, the full verification
result, and any platform or provider behavior that could not be exercised.
