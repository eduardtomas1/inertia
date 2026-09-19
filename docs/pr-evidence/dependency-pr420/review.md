# Dependency batch review

Application baseline: main `19d8015735cae6f2bbbec2a46d78ebc6903c2f2d`; Node 22.23.2, macOS ARM64.

The lockfile changes exactly four direct dependencies and TanStack's virtual-core dependency. No provider SDK, native dependency, workflow, migration or application source changes are included.

- TanStack React Virtual 3.14.11 → 3.14.13 / virtual-core 3.17.9 → 3.17.11: reviewed the upstream changes to saved measurement keys, sliding windows, smooth-scroll prepend handling, scroll-end offset reads, and React ref-callback notifications. Inertia uses the virtualizer in chat, Files and the model chooser, so all three require native interaction coverage.
- Lucide React 1.44.0 → 1.46.0: shared icon renderer/context/factory code is identical apart from the version in license headers; icon additions and artwork changes remain tree-shaken through named imports.
- tailwind-merge 3.6.0 → 3.7.0: inspected the shipped runtime changes for CSS color functions, logical-axis conflicts and container sizes. No application import of tailwind-merge was found.
- Zod 4.6.2 → 4.6.5: reviewed upstream URL fast paths and properties-check API changes. Inertia does not use the removed standalone properties schema or currency code helper; the full contract suite remains required.

Production audit: zero vulnerabilities. Third-party notices regenerated with all five new package versions and their existing MIT/ISC licenses.

Upstream comparisons:
- https://github.com/TanStack/virtual/compare/@tanstack/virtual-core@3.17.9...@tanstack/virtual-core@3.17.11
- https://github.com/lucide-icons/lucide/compare/1.44.0...1.46.0
- https://github.com/dcastil/tailwind-merge/compare/v3.6.0...tailwind-merge@3.7.0
- https://github.com/colinhacks/zod/compare/v4.6.2...v4.6.5

The production build reproduces the original CI failure in three bundle limits. On identical application source and build configuration, this dependency graph adds exactly 1,156 bytes to main startup, detached startup and shared core. All other measurements are identical. Add only this measured delta to those three limits, preserving existing headroom and all lazy-load/route assertions. Full measurements are in `renderer-bundle.json`.

Validation:

- Full `VITEST_MAX_WORKERS=4 npm run check`: 9,254 tests passed, 145 platform/optional tests skipped; quality checks and production build passed.
- Five native Electron scenarios passed: reading-position restoration for short and virtualized chats, validated Java file navigation, first/last-line scrolling through 5,000 lines, and model chooser route/geometry interactions.
- Native architecture verification passed for macOS ARM64.
- Packaged the macOS ARM64 app, verified all Electron fuses, and passed package smoke, including legal resources, runtime guardian, Private Connect assets, PDF extraction, image retention, updater fallback, and clean shutdown.

Hosted Linux, Windows and macOS x64 execution remains required. Release artifact checksums and provenance workflows were not changed; no release was published.
