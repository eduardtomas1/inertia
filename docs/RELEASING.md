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

Inertia’s in-app update notice only checks the repository’s public latest
release. It never downloads or installs an update silently; the user opens the
release page and chooses an artifact.

Every package build runs `npm run notices:generate` first. The generator reads
the installed production dependency graph, fails when a package references
missing license material, and places deterministic third-party notices beside
Inertia's own license and Electron's Chromium notices in the packaged
resources. Release validation must not bypass that prebuild step.
