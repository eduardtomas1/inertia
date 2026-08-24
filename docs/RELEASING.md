# Releasing Inertia

Inertia releases are built only from an exact `vMAJOR.MINOR.PATCH` tag. Native
macOS x64 and arm64, Windows x64 and ARM64, and Linux x64 and ARM64 artifacts
are tested, checksummed, and published together. Each package is built and
smoked on a matching GitHub-hosted architecture; macOS is intentionally built
per architecture because host-selected provider executables and native modules
make a cross-host universal bundle incomplete.

Canary releases are the same source and version discipline under the distinct
`canary-vMAJOR.MINOR.PATCH` tag namespace. They are prereleases and are never
marked as GitHub's latest stable release. The release workflow packages Canary
with its own application ID, product/executable names, protocol scheme,
Chromium partition, profile/data/workspace/temp roots, updater cache, generic
feed, metadata channel, and artifact names. A Canary process ignores packaged
data/workspace environment overrides, so it cannot be pointed at stable data.

To install Canary, open the exact `canary-vMAJOR.MINOR.PATCH` GitHub prerelease,
download the Canary-named package for the target platform and verify it against
that release's `SHA256SUMS.txt` before running the installer. It installs beside
stable Inertia rather than replacing it. On first launch, confirm **Canary
channel · isolated profile** in **Settings → General → Application updates**;
stable projects and conversations are intentionally not imported. Use **Check
now** for subsequent Canary updates. Before any update download begins, the
application must show a verified last-known-good build; use **Prepare rollback**
when the current package has not yet been retained.

The Canary feed is one immutable commit per published version on the
`canary-feed` branch. Its small update
metadata points to immutable assets on the exact versioned Canary prerelease;
the branch advances only after every platform package, smoke test, fuse check,
signature check, asset digest, consolidated checksum, and provenance
attestation succeeds. Publication compares the candidate version with the
current branch head and retries a non-force fast-forward after concurrent
updates, so an older workflow that finishes late cannot replace a newer feed.
Linux update metadata is always required; credential-optional manual macOS or
Windows builds are omitted from the feed until that platform is update-capable.
Stable packages read GitHub's `releases/latest/download` feed and never this
branch. Canary packages read only the raw `canary-feed` branch and never
`releases/latest/download`.

Before an in-app Canary update downloads, Inertia downloads the immutable
package for the currently running version, verifies it against that release's
`SHA256SUMS.txt`, and retains exactly one last-known-good package inside the
Canary profile. The Settings update surface reports the channel and verification
state. After an update, the macOS and Windows **Open rollback v…** action
rehashes the retained installer before asking the operating system to open it.
The Linux **Show rollback file v…** action rehashes and reveals the retained
AppImage without trying to launch it under the running profile lock. Quit
Canary, replace the active `APPIMAGE` path named in the status message with the
revealed file, preserve
the destination's executable permission, and reopen Canary. A missing release,
truncated download, digest mismatch, substituted file, invalid active AppImage,
or OS open/reveal failure is reported without starting the new update or
touching the prior retained package. The first
Canary installed outside the release workflow may need **Prepare rollback**
once; updates remain blocked until the running build is retained successfully.
After opening a macOS or Windows rollback package, follow the platform installer
prompt and restart Canary; the retained checksum remains the authority for the
selected package.

Signing credentials are optional until the project has the corresponding
certificates. A credential-free build remains explicit: macOS uses the tested
ad-hoc signature and Windows remains unsigned. Supplying any part of a signing
set without the rest stops the build.

For either stable or Canary, the credential-free public union is exactly 11
files: four macOS packages (DMG and ZIP for x64 and arm64), two Windows
installers, two Linux AppImages, the two architecture-qualified Linux update
manifests, and `SHA256SUMS.txt`. Manual macOS and Windows releases do not publish
their update metadata or desktop blockmaps. Linux remains in-app capable and
retains both metadata manifests.

Unsigned/manual installation is checksum-first. Download `SHA256SUMS.txt` from
the same exact tagged release and compare the selected package before opening
it. An ad-hoc macOS package is not notarized, and a browser download normally
retains quarantine, so Gatekeeper may block the first open. After checksum
verification, open it from Finder and use **System Settings → Privacy &
Security → Open Anyway**, confirm the exact package, then choose **Open**. Do
not strip quarantine attributes or disable Gatekeeper. On Windows, an unsigned
installer may show **Windows protected your PC**; after verifying the checksum
and exact release source, use **More info**, confirm the filename and **Unknown
publisher** status, then **Run anyway**. Do not disable SmartScreen.

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

Stable release packages use electron-builder's generic update provider at
`https://github.com/eduardtomas1/inertia/releases/latest/download`. Canary
packages instead use the isolated raw `canary-feed` branch described above.
Packaging uses `--publish never`: platform jobs generate packages, update
metadata, and blockmaps, but they cannot create or modify a GitHub release. The
final Ubuntu job validates and publishes the exact combined asset set as the
workflow's single writer.

The packaged capability marker enables in-app delivery only for a real release
AppImage, a completely Authenticode-signed Windows build, or a Developer ID
signed and notarized macOS build. Unsigned Windows and ad-hoc macOS builds keep
the manual browser flow. Linux additionally checks at runtime that `APPIMAGE`
identifies a replaceable regular file.

Each platform stage validates its packaged `app-update.yml`, channel manifest,
package sizes and SHA-512 values, and required differential-download
companions. The consolidation job then revalidates every downloaded artifact,
rejects extra or duplicate names, and writes `SHA256SUMS.txt` over the complete
public asset union. Because the macOS and Windows updaters use one channel name
per operating system, consolidation also creates one validated `latest-mac.yml`
and one validated `latest.yml` whose exact file union contains both native
architectures; Linux retains its architecture-qualified channel manifests.
Signed Windows packages must carry the bounded publisher identity used by the
native installer verifier. When Windows or macOS is built for manual delivery
because signing is unavailable, its channel manifest and blockmap are
deliberately excluded so an older signed installation cannot be offered an
uninstallable release. Mixed update capability between two architectures of
the same operating system is rejected. Build provenance covers that same exact
union.

Publishing is draft-first and fail-closed. A retry may reuse an existing draft:
identical assets are retained and missing assets are uploaded, while unexpected
assets or any size/digest mismatch stop the release. The workflow downloads and
hashes the complete draft before publishing it. It never overwrites an asset or
modifies an already-published release.

The release workflow has one authoritative Discord notification job after the
exact-tag stable release is published. Canary releases never run that job. The
notification remains inside the release workflow because GitHub-created release
events from the workflow token do not reliably start a separate
`release.published` workflow; there is no second release-event notifier.

The first update-capable version must still be installed manually. Validate a
packaged update from that version to the following version on each eligible
platform before treating in-app delivery as proven.

Every package build runs `npm run notices:generate` first. The generator reads
the installed production dependency graph, fails when a package references
missing license material, and places deterministic third-party notices beside
Inertia's own license and Electron's Chromium notices in the packaged
resources. Release validation must not bypass that prebuild step.

## Database migration lineage

`database-migration-lineage.json` is the durable released migration order and
semantic digest manifest. `npm run check:migrations` validates its shape, while
the focused Vitest lineage test reconstructs all migrations from the runtime
catalog and compares every version, name, foreign-key mode, SQL body, or data
migration callback digest. Data migrations that call imported helpers also pin
sorted SHA-256 digests for the named top-level helper declarations and their
relevant transitive helpers. Unrelated declarations in the same live module can
continue to evolve without rewriting released lineage. The dedicated CI
workflow additionally compares the
PR merge base (or previous `main` commit) and rejects any edited, removed, or
reordered released entry even when the proposed branch also edits the manifest.
Only new entries may be appended. Release migrations are never rewritten.
