# v0.0.62 release preparation

This preparation starts from main `c63936d90dbf8ff8ff7f12c75bd1dd4854ea6045`.
The curated changelog covers the changes since the published `v0.0.61` tag,
whose peeled commit is `67d81d24db60a2bbb5b6b361e44d9213737f8e52`.

The candidate updates the package and lockfile root versions together, refreshes
the README for the current workspace, and captures nine real Electron views.
Eight appear in the README, including the new Goal panel and image zoom views.
The capture script uses the current panel controls and synthetic demo data in
an isolated profile. The image preview imports the script's own fresh captures;
it does not send a provider turn. The Goal example is local tracking, clearly
distinguished in the UI from a provider-native goal.

All images are 3024 × 1736 PNGs and were visually checked for readable controls,
complete rendering, and absence of private data. Earlier capture attempts
exposed obsolete selectors; those were corrected before the successful final
nine-image capture. This candidate does not change application behavior,
provider protocols, dependencies, migrations, or CI and release gate limits.

## Local validation

- Node 22.23.2 and the locked dependency installation completed successfully.
- Release contract coverage passed 100 tests across eight files, including
  frozen tag identity, asset publication, signing configuration, package legal
  resources, container smoke contracts, and Windows predecessor selection.
- The full gate passed: quality checks, 9,992 tests plus seven child controls,
  146 platform-dependent skips, and a fresh production build within unchanged
  bundle budgets. Unit execution used the CI limit of two workers. The commands
  were `npm run check:quality`, `npm test -- --maxWorkers=2`, and
  `npm run build:bundle`, the same stages as `npm run check`.
- Native dependency architecture passed for macOS ARM64.
- The stable release configuration built the macOS ARM64 app, DMG and ZIP.
  Electron fuses, packaged application smoke, both final container smokes, and
  strict deep bundle-signature verification all passed. These local packages
  use ad-hoc signing; Developer ID signing and notarization were not exercised.
- README image links, PNG dimensions, matching package versions and whitespace
  checks passed. The capture script completed all nine views successfully.

## Publication boundary

These local checks do not certify the other five native targets. The exact
reviewed PR head must pass CI, and the resulting main commit must be fully green
before creating the stable release tag. The tag workflow must then certify all
six native platforms and validate the complete asset union, checksums and
provenance before publishing its draft. Use the curated changelog text for the
public release notes. No tag, public release or asset replacement is part of
this preparation commit.

## Changed files

- `package.json` and `package-lock.json`: version 0.0.62 only.
- `CHANGELOG.md`: compact release notes since 0.0.61.
- `README.md`: current feature descriptions and eight illustrated views.
- `scripts/capture-readme-screenshots.mjs`: current UI selectors, demo plan,
  Goal panel capture and image zoom capture.
- `docs/screenshots/`: refreshed `inertia-dark.png`, `inertia-light.png`,
  `inertia-message-search.png`, `inertia-project-picker.png`,
  `inertia-add-project.png`, `inertia-split-workspace.png` and
  `inertia-git-workflow.png`; added `inertia-goals.png` and
  `inertia-image-preview.png`.
- This release preparation evidence report.

Authenticated provider sessions, Windows, Linux, Intel macOS, and the final
exact-tag hosted release workflow were not exercised locally. The user owns
main CI repairs; this preparation is not a fix or a green certificate for main.
