# Releasing Inertia

Inertia releases are built only from an exact `vMAJOR.MINOR.PATCH` tag. Native
macOS x64 and arm64, Windows x64 and ARM64, and Linux x64 and ARM64 artifacts
are tested, checksummed, and published together. Each package is built and
smoked on a matching GitHub-hosted architecture; macOS is intentionally built
per architecture because host-selected provider executables and native modules
make a cross-host universal bundle incomplete.

Canary releases are the same source and version discipline under the distinct
`canary-vMAJOR.MINOR.PATCH` tag namespace. They are prereleases and are never
marked as GitHub's latest stable release. A stable tag must point to a commit
that `main` already contains, while a Canary tag may come from any branch.
The release workflow packages Canary
with its own application ID, product/executable names, protocol scheme,
Chromium partition, profile/data/workspace/temp roots, updater cache, generic
feed, metadata channel, and artifact names. A Canary process ignores packaged
data/workspace environment overrides, so it cannot be pointed at stable data.

To install Canary, open the exact `canary-vMAJOR.MINOR.PATCH` GitHub prerelease,
download the Canary-named package for the target platform and verify it against
that release's `SHA256SUMS.txt` before running the installer. It installs beside
stable Inertia rather than replacing it. On first launch, confirm **Inertia
Canary** and **Canary rollback** in **Settings → Help → About and updates**;
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

For either stable or Canary, the credential-free public union is exactly 12
files: four macOS packages (DMG and ZIP for x64 and arm64), two Windows
installers, two Linux AppImages, the two architecture-qualified Linux update
manifests, a CycloneDX dependency inventory (`Inertia-VERSION.sbom.cdx.json`),
and `SHA256SUMS.txt`. Manual macOS and Windows releases do not publish
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
For a manual Windows update, quit Inertia and wait for its processes to close
safely before launching the verified installer. Setup must refuse rather than
terminate any process running from the installation directory; close Inertia
cleanly and retry if that safety check blocks installation.
GitHub/browser downloads do not retain an AppImage's executable permission.
Linux instructions must name the exact architecture-qualified file, verify that
exact line from `SHA256SUMS.txt`, then use `chmod 0755 ./<exact filename>` before
launch. Never recommend a wildcard chmod or installing development libraries.
The public AppImage assets remain architecture-qualified and versioned. The
first successful in-app update installs Stable as `Inertia.AppImage` and
Canary as `Inertia Canary.AppImage`; every later update preserves that channel
identity. The updater copies into the active AppImage's real containing
directory, uses only same-directory atomic renames, retains an inode-verified
rollback link until the replacement launches, and journals bounded recovery.
Symlinked files, escaping or occupied paths, ownership changes, and incomplete
rollback proof fail closed without cross-directory renames or broad deletion.

For a signed macOS release, configure these GitHub Actions secrets:

- `MACOS_CSC_LINK`
- `MACOS_CSC_KEY_PASSWORD`
- `MACOS_APPLE_API_KEY_BASE64`
- `MACOS_APPLE_API_KEY_ID`
- `MACOS_APPLE_API_ISSUER`

For a signed Windows release, configure exactly one of two sets. Azure
Artifact Signing (formerly Trusted Signing):

- `WINDOWS_AZURE_TENANT_ID`
- `WINDOWS_AZURE_CLIENT_ID`
- `WINDOWS_AZURE_CLIENT_SECRET`
- `WINDOWS_TRUSTED_SIGNING_ENDPOINT`
- `WINDOWS_TRUSTED_SIGNING_ACCOUNT_NAME`
- `WINDOWS_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `WINDOWS_TRUSTED_SIGNING_PUBLISHER_NAME`

Or an exportable PFX certificate:

- `WINDOWS_CSC_LINK`
- `WINDOWS_CSC_KEY_PASSWORD`

Configuring both complete sets stops the build. See [Code signing](#code-signing)
for the one-time setup.

For Discord release notifications, configure:

- `DISCORD_WEBHOOK_URL`

The workflow writes the Apple API key to a temporary runner file, never to the
repository or an uploaded artifact. Complete macOS credentials enable hardened
runtime, Developer ID signing, notarization, and fail-closed signature checks.
Either complete Windows set enables fail-closed Authenticode signing.

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

Stable PR and release jobs download the checksummed preceding public installer
for each native Windows architecture and upgrade its existing installation.
The predecessor saves a conversation and completes a synthetic-provider turn;
after its verified shutdown, the fixture binds a unique retained image to that
saved message. The candidate must preserve the captured identities, content,
settings and image bytes, complete a distinct new turn, and retain both turns
after shutdown. Expected history is stored outside the app profile so recreating
the profile cannot satisfy the check. This is installed data-preservation proof,
not attachment-upload UI coverage.
Canary retains its isolated fresh-install gate. macOS tag builds run the complete
unit suite with the same two-worker limit as PR CI.

Both Windows architecture jobs also inspect the NSIS application archive for
an install-time-decodable 7-Zip method, silently install the exact generated
installer into a temporary directory, verify the installed executable, native
modules, provider helper, and Electron DLLs have the runner architecture, and
run the complete packaged runtime smoke from that installed location. The same
gate then performs a silent uninstall and requires clean removal with exit code
zero; a reboot-success code is a failure, not an installation strategy. This
gate runs in pull-request CI as well as the exact-tag release workflow so an
unpacked app cannot conceal a broken public installer.

Native macOS jobs additionally extract the exact ZIP, mount the exact DMG
read-only, verify the complete signature and selected native binaries in each,
and run the complete packaged runtime smoke from both contained apps. Native
Linux jobs reject unversioned AppImage runtime dependencies, execute the exact
AppImage wrapper and its statically linked process guardian in pristine
`ubuntu:22.04` (glibc 2.35), exercise the guardian's seccomp and `/proc`
identity paths, extract through that wrapper
without an `unsquashfs` fallback, verify selected native binaries, and run the
complete smoke twice through the exact AppImage entry point: once through the
durable installed filename and advertised default FUSE mount/AppRun path, and
once through the versioned public asset's explicit
extract-and-run fallback. These final-container gates do
not replace the separate checksum, provenance, signature, fuse, update-metadata,
or unpacked-package checks.

The Linux guardian is statically linked with musl so it does not inherit the
runner's glibc floor. Ubuntu/Debian development hosts therefore need
`musl-tools`, `linux-libc-dev`, and `binutils`; CI installs that reviewed
toolchain explicitly and verifies that the packaged ELF has no interpreter or
dynamic dependencies. The packaged third-party notices include musl's license.

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

Linux v0.0.52 needs a one-time manual installation of the release containing
the installed-update repair. Its update validator reads Electron's message
envelope instead of its payload, and its parent updater waits for
stdout EOF while the extract-and-run wrapper remains alive. New release metadata
cannot change that already-installed reader. Quit the old app cleanly, verify the
new architecture-specific AppImage against its release's `SHA256SUMS.txt`, apply
`chmod 0755` to that exact file, and launch it with the existing profile. Do not
delete the profile or recreate projects to update.

The stable Linux final-container gate now drives the production installed update
coordinator and candidate bootstrap through extract-and-run, checks atomic
replacement and owner shutdown,
resumes the saved conversation's provider session, refreshes its Git workspace,
and reopens the durable AppImage filename. The fixture substitutes the release
download with the locally built package and advertises a synthetic older source
version; both executables contain the candidate source. This is an installed
handoff regression, not proof that an unmodified published v0.0.52 can update
itself. Existing checksum, metadata, fuse, guardian and package gates remain
separate requirements.

Every package build runs `npm run notices:generate` first. The generator reads
the installed production dependency graph, fails when a package references
missing license material, and places deterministic third-party notices beside
Inertia's own license in the packaged resources. Release validation must not
bypass that prebuild step.

## Code signing

Signed macOS and Windows builds are what turn on in-app updates for those
platforms. With no signing secrets, the release still succeeds. It ships
unsigned Windows and ad-hoc macOS packages that update manually from the
release page, and leaves out `latest.yml` and `latest-mac.yml`. Every secret
below is a GitHub Actions repository secret (**Settings → Secrets and variables
→ Actions → New repository secret**). A blank secret counts as unset. A
partially configured set stops the build, and the error names only the missing
variables, never a value.

### Windows: Azure Artifact Signing

Since June 2023, publicly trusted OV and EV code-signing certificates must be
generated and kept on hardware security modules, so a newly bought certificate
can't be exported as a PFX. For a small publisher, Azure Artifact Signing
(Microsoft's renamed Trusted Signing service) is the practical route.
electron-builder 26 signs through it with `win.azureSignOptions`: on the Windows
runner it installs the `TrustedSigning` PowerShell module and calls
`Invoke-TrustedSigning`, which reads the service principal from
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`.

One-time setup in the Azure portal:

1. Under an Azure subscription you own, register the `Microsoft.CodeSigning`
   resource provider (**Subscription → Resource providers**).
2. Create an **Artifact Signing account** in a resource group. Pick its region
   carefully, because the account endpoint depends on it, for example
   `https://eus.codesigning.azure.net/` for East US or
   `https://weu.codesigning.azure.net/` for West Europe. The **Account URI** on
   the account overview is the exact endpoint value.
3. Assign yourself the **Artifact Signing Identity Verifier** role on the
   account (**Access control (IAM) → Add role assignment**).
4. On the account, open **Identity validations → New identity → Public**. Fill
   in the legal name and address exactly as they appear on your registration
   documents, and complete Microsoft's verification. Public validation can take
   from one to many business days. Individual developers are eligible only in
   the countries Microsoft currently supports, and the billing account must be
   of type Individual. Check the current list on Microsoft Learn before you
   start.
5. When the validation shows **Completed**, open **Certificate profiles →
   Create → Public Trust**, select that validation, and name the profile.
   Record the account name and the profile name.
6. Record the certificate subject common name (CN) the profile issues. It is
   the validated legal name as shown on the profile, without `CN=`. This is the
   publisher name.
7. In **Microsoft Entra ID → App registrations**, register an application, for
   example `inertia-release-signing`. Record the **Directory (tenant) ID** and
   the **Application (client) ID**. Under **Certificates & secrets**, create a
   client secret and copy its **Value** immediately. Note its expiry date, and
   rotate the secret before it expires.
8. On the certificate profile (or the account), open **Access control (IAM) →
   Add role assignment**, choose **Artifact Signing Certificate Profile
   Signer** (earlier portal versions call it **Trusted Signing Certificate
   Profile Signer**), and assign it to the application from step 7. Give the
   application no other role.

Create these repository secrets:

| Secret | Value |
| --- | --- |
| `WINDOWS_AZURE_TENANT_ID` | Directory (tenant) ID |
| `WINDOWS_AZURE_CLIENT_ID` | Application (client) ID |
| `WINDOWS_AZURE_CLIENT_SECRET` | The client secret value |
| `WINDOWS_TRUSTED_SIGNING_ENDPOINT` | Account URI, such as `https://weu.codesigning.azure.net/` |
| `WINDOWS_TRUSTED_SIGNING_ACCOUNT_NAME` | Artifact Signing account name |
| `WINDOWS_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | Certificate profile name |
| `WINDOWS_TRUSTED_SIGNING_PUBLISHER_NAME` | The certificate subject CN, exactly, without `CN=` |

The release configuration requires an `https` endpoint with no path, query or
credentials, account and profile names of letters, digits and hyphens, and a
publisher name with no surrounding whitespace, no `=` and no control
characters. The publisher name goes into each packaged `app-update.yml`.
electron-updater compares it with the CN of every downloaded installer and
refuses an update signed by anyone else. The release job also checks that the
signed installer's signer CN equals it exactly. Keep the PFX secrets empty
while the Azure set is in use.

If the validated legal name ever changes, the CN changes with it. Installs that
carry the old publisher name will then reject in-app updates and need one
manual install of a build signed under the new name.

### Windows: exportable PFX certificate

`WINDOWS_CSC_LINK` holds a base64-encoded `.pfx` (or an HTTPS URL to one), and
`WINDOWS_CSC_KEY_PASSWORD` holds its password. electron-builder reads the
publisher name from the certificate's CN. This path exists only for a
certificate that can still be exported. A newly issued public certificate
cannot be.

### macOS: Developer ID and notarization

The macOS path signs with a Developer ID Application certificate, enables the
hardened runtime with electron-builder's default entitlements (JIT,
unsigned executable memory, and disabled library validation, which Electron and
the unpacked native modules need), and notarizes with an App Store Connect API
key through `notarytool`.

1. Enroll in the Apple Developer Program.
2. In Keychain Access on a Mac, choose **Certificate Assistant → Request a
   Certificate From a Certificate Authority** and save the request to disk. In
   **Certificates, Identifiers & Profiles → Certificates**, create a
   **Developer ID Application** certificate from that request, then download
   and open it.
3. In Keychain Access, select the certificate together with its private key,
   choose **Export 2 items**, save as `.p12`, and set a strong password.
4. In App Store Connect, open **Users and Access → Integrations → App Store
   Connect API → Team Keys**, generate a key with the **Developer** role, and
   download the `.p8` file. Apple lets you download it only once. Record the
   **Key ID** and the **Issuer ID** shown above the key list.
5. Create these repository secrets:

| Secret | Value |
| --- | --- |
| `MACOS_CSC_LINK` | `base64 -i DeveloperID.p12` output |
| `MACOS_CSC_KEY_PASSWORD` | The `.p12` export password |
| `MACOS_APPLE_API_KEY_BASE64` | `base64 -i AuthKey_KEYID.p8` output |
| `MACOS_APPLE_API_KEY_ID` | The API key ID |
| `MACOS_APPLE_API_ISSUER` | The issuer ID |

The workflow decodes the `.p8` into a mode-0600 runner temporary file, passes
its path as `APPLE_API_KEY`, and removes it after packaging. The bundle check
then requires a `Developer ID Application` authority and a stapled
notarization ticket.

### Moving existing installs from unsigned to signed builds

Unsigned Windows and ad-hoc macOS installs are built for manual delivery, so
they never start the native updater. They keep showing the new version with a
link to its release page. On macOS, an ad-hoc install can't take a Developer
ID update in-app, because Squirrel.Mac requires the update to satisfy the
running app's code requirement. On Windows, electron-updater checks the
publisher against the installed app's own `app-update.yml`. An unsigned build
has no `publisherName` there, so it could not verify a signed update even if it
ran the updater. Every existing user therefore installs the first signed
release once, by hand, from the release page. That signed install carries the
publisher name and in-app delivery, and later signed releases update in-app
with the publisher check active.

### Verifying the first signed release

Release N is the first signed release. Release N+1 is the first in-app update
between two signed builds.

- [ ] The release run shows Windows packages signed (no `forceCodeSigning`
      failure), the Authenticode step passes with the expected signer CN, and
      the macOS step reports `Authority=Developer ID Application:` and a valid
      stapler ticket.
- [ ] Release N publishes `latest.yml` and `latest-mac.yml`, and both Windows
      and macOS packages report `delivery: in-app` in their packaged
      capability.
- [ ] On Windows x64 and ARM64, install release N from the release page and
      confirm that **Properties → Digital Signatures** on the installer and on
      `Inertia.exe` shows the publisher. Confirm the installed
      `resources\app-update.yml` lists that `publisherName`.
- [ ] On macOS arm64 and x64, install release N from the DMG and confirm that
      `spctl --assess --type execute -vv /Applications/Inertia.app` reports
      `source=Notarized Developer ID`.
- [ ] After publishing release N+1, open release N on each OS and architecture,
      check for updates, download, restart to update, and confirm the app
      relaunches as N+1 with conversations intact.
- [ ] On Windows, check the updater log for
      `Verifying signature` with no `ERR_UPDATER_INVALID_SIGNATURE`.
- [ ] Repeat the N to N+1 check for Canary once Canary is also signed.

## What ships

Packaging excludes files the application never executes: dependency source
maps and type declarations, better-sqlite3's C sources, and prebuilt binaries
for other operating systems. Each platform file list repeats the shared
inclusions: the pinned builder normalizes shared files into a separate matcher,
so a negative-only platform matcher would add an include-all fallback and ship
the repository. Platform resources are combined with the shared resources and
must not repeat them. Tests exercise the builder's normalized file matchers to
keep source files out, runtime files in, and each legal resource copied once.

Electron already installs its Chromium credits beside the executable on Windows
and Linux, so only macOS, whose application bundle does not contain that file,
packages a copy. `package-smoke-legal-resources.mjs` verifies whichever layout
applies, so previously installed builds keep passing.

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
