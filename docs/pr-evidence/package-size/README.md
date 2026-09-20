# Package-size review

Reviewed against main `d56f972b` using Node 22. No version or release-tag change.

The production graph does not import `tailwind-merge`. The excluded dependency
files are source maps, TypeScript declarations, SQLite build inputs, and foreign
prebuilds; native binaries and dynamically loaded PDF/image/spreadsheet modules
remain packaged. Notices are regenerated from the resulting production graph.

The original macOS resource list duplicated every shared resource. The pinned
builder combines these lists, so macOS now adds only Chromium credits. Its file
lists behave differently: normalization creates a separate shared matcher, and
a negative-only platform matcher triggers include-all. The shared file
inclusions therefore remain in each platform list. Tests exercise normalized
builder matchers, preserve the include-all regression check, and verify unique
resource destinations.

Validation on macOS ARM64:

- Focused packaging/legal tests: 24 passed.
- Linux package contract tests: 9 passed.
- Full `npm run check`: 9,351 passed, 146 platform/optional tests skipped; quality,
  typecheck, production builds and renderer budgets passed.
- Real `npm run build` and `npm run package:mac`, with native rebuild enabled.
- Archive inspection: only `out`, `node_modules`, `package.json`, and `resources`
  at its root; 10,197 entries, zero source maps and zero documentation entries.
- Packaged smoke: actual utility runtime started, PDF extraction and image
  retention passed, and main/runtime shutdown completed cleanly.
- Packaged Electron fuse verification passed with existing protections intact.

The initial PR's macOS x64 failure was the desktop benchmark's Settings-first-open
measurement (359.1 ms against 100 ms), after package/container and application
checks passed. This branch incorporates current main and keeps the benchmark
threshold unchanged. All required native CI checks must pass on the reviewed
head before merge; local ARM64 results alone do not establish Windows, Linux,
or macOS x64 behavior.

The PR's original Windows size comparison reported 13.10 MiB less download and
94.28 MiB less installed storage. Those numbers describe that before/after
measurement, not a new six-platform measurement.
