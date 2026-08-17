# Releasing Inertia

Inertia releases are built only from an exact `vMAJOR.MINOR.PATCH` tag. Linux,
Windows, and macOS artifacts are tested, checksummed, and published together.

Signing credentials are optional until the project has the corresponding
certificates. A credential-free build remains explicit: macOS uses the tested
ad-hoc signature and Windows remains unsigned. Supplying any part of a signing
set without the rest stops the build.

For a signed macOS release, configure these GitHub Actions secrets:

- `MACOS_CSC_LINK`
- `MACOS_CSC_KEY_PASSWORD`
- `MACOS_APPLE_API_KEY_BASE64`
- `MACOS_APPLE_API_KEY_ID`
- `MACOS_APPLE_API_ISSUER`

For a signed Windows release, configure:

- `WINDOWS_CSC_LINK`
- `WINDOWS_CSC_KEY_PASSWORD`

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

The packaged capability marker enables in-app delivery only for a real release
AppImage, a completely Authenticode-signed Windows build, or a Developer ID
signed and notarized macOS build. Unsigned Windows and ad-hoc macOS builds keep
the manual browser flow. Linux additionally checks at runtime that `APPIMAGE`
identifies a replaceable regular file.

Each platform stage validates its packaged `app-update.yml`, channel manifest,
package sizes and SHA-512 values, and required differential-download
companions. The consolidation job then revalidates every downloaded artifact,
rejects extra or duplicate names, and writes `SHA256SUMS.txt` over the complete
public asset union. Signed Windows packages must carry the bounded publisher
identity used by the native installer verifier. When Windows or macOS is built
for manual delivery because signing is unavailable, its channel manifest and
blockmap are deliberately excluded so an older signed installation cannot be
offered an uninstallable release. Build provenance covers that same exact
union.

Publishing is draft-first and fail-closed. A retry may reuse an existing draft:
identical assets are retained and missing assets are uploaded, while unexpected
assets or any size/digest mismatch stop the release. The workflow downloads and
hashes the complete draft before publishing it. It never overwrites an asset or
modifies an already-published release.

The first update-capable version must still be installed manually. Validate a
packaged update from that version to the following version on each eligible
platform before treating in-app delivery as proven.

Every package build runs `npm run notices:generate` first. The generator reads
the installed production dependency graph, fails when a package references
missing license material, and places deterministic third-party notices beside
Inertia's own license and Electron's Chromium notices in the packaged
resources. Release validation must not bypass that prebuild step.
