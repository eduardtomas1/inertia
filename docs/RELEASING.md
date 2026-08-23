# Releasing Inertia

Inertia releases are built only from an exact `vMAJOR.MINOR.PATCH` tag. Linux,
Windows, and macOS artifacts are tested, checksummed, and published together.

Public releases fail closed unless every required signing secret is present.
macOS must be Developer ID signed and notarized, and Windows must carry a valid
Authenticode signature. Complete, partial, and completely missing secret sets
are validated before dependency installation; the release builder repeats the
platform-specific check before packaging. There is no unsigned or ad-hoc
public-release fallback.

For a signed macOS release, configure these GitHub Actions secrets:

- `MACOS_CSC_LINK`
- `MACOS_CSC_KEY_PASSWORD`
- `MACOS_APPLE_API_KEY_BASE64`
- `MACOS_APPLE_API_KEY_ID`
- `MACOS_APPLE_API_ISSUER`

For a signed Windows release, configure:

- `WINDOWS_CSC_LINK`
- `WINDOWS_CSC_KEY_PASSWORD`

For Discord release notifications, configure:

- `DISCORD_WEBHOOK_URL`

The workflow writes the Apple API key to a temporary runner file, never to the
repository or an uploaded artifact. Complete macOS credentials enable hardened
runtime, Developer ID signing, notarization, and fail-closed signature checks.
Complete Windows credentials enable fail-closed Authenticode signing.

Release packages use electron-builder's generic update provider at
`https://github.com/eduardtomas1/inertia/releases/latest/download`. Packaging
uses `--publish never`: platform jobs generate packages, update metadata, and
blockmaps, but they cannot create or modify a GitHub release. The final Ubuntu
job validates and publishes the exact combined asset set as the workflow's
single writer.

Pull-request and `main` CI packages are explicitly non-release contributor
builds. They use `dev.inertia.app.contributor-ci`, carry a manual-only update
capability, contain no stable update-feed configuration, and are never uploaded
as public release assets. Their macOS bundle remains ad-hoc signed solely so CI
can exercise native package, fuse, and smoke behavior without release secrets.

The packaged capability marker enables in-app delivery only for a real release
AppImage, a completely Authenticode-signed Windows build, or a Developer ID
signed and notarized macOS build. Public release consolidation rejects any
manual-only platform artifact. Linux additionally checks at runtime that
`APPIMAGE` identifies a replaceable regular file; electron-builder's AppImage
updater authenticates downloads through the release manifest checksum, while
the workflow also preserves the exact-union SHA-256 manifest and GitHub build
provenance.

Each platform stage validates its packaged `app-update.yml`, channel manifest,
package sizes and SHA-512 values, and required differential-download
companions. The consolidation job then revalidates every downloaded artifact,
rejects extra or duplicate names, and writes `SHA256SUMS.txt` over the complete
public asset union. Windows packages must carry the bounded publisher identity
used by the native installer verifier. Every platform contributes its channel
manifest and required differential-download companions. Build provenance
covers that same exact union.

Publishing is draft-first and fail-closed. A retry may reuse an existing draft:
identical assets are retained and missing assets are uploaded, while unexpected
assets or any size/digest mismatch stop the release. The workflow downloads and
hashes the complete draft before publishing it. It never overwrites an asset or
modifies an already-published release.

The release workflow sends the Discord notification after the exact-tag release
is published. This is intentionally part of the release workflow because
GitHub-created release events from the workflow token do not reliably start a
separate `release.published` workflow.

The first update-capable version must still be installed manually. Validate a
packaged update from that version to the following version on each eligible
platform before treating in-app delivery as proven.

Every package build runs `npm run notices:generate` first. The generator reads
the installed production dependency graph, fails when a package references
missing license material, and places deterministic third-party notices beside
Inertia's own license and Electron's Chromium notices in the packaged
resources. Release validation must not bypass that prebuild step.
