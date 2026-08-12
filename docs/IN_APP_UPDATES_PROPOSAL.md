# Proposal: Safe In-App Updates from GitHub Releases

> **Status:** Proposed  
> **Verified against:** `main`, Inertia `0.0.31`  
> **Investigation date:** 2026-08-12  
> **Implementation:** Separate follow-up pull request after this proposal is approved

## Contents

1. [Executive summary](#executive-summary)
2. [Decision](#decision)
3. [Current state](#current-state)
4. [Goals and non-goals](#goals-and-non-goals)
5. [User experience](#user-experience)
6. [Platform support and trust policy](#platform-support-and-trust-policy)
7. [Architecture](#architecture)
8. [Release-pipeline contract](#release-pipeline-contract)
9. [Security, privacy, and shutdown safety](#security-privacy-and-shutdown-safety)
10. [Implementation map](#implementation-map)
11. [Testing and verification](#testing-and-verification)
12. [Rollout and compatibility](#rollout-and-compatibility)
13. [Failure handling](#failure-handling)
14. [Alternatives considered](#alternatives-considered)
15. [Acceptance criteria](#acceptance-criteria)
16. [Codex implementation handoff](#codex-implementation-handoff)
17. [References](#references)

## Executive summary

Safe in-app updates are feasible for Inertia without replacing the release system that already exists.

Inertia already has the first half of the feature:

- [`src/main/app-update.ts`](../src/main/app-update.ts) performs a bounded, cached check against the latest public GitHub release.
- [`src/renderer/src/hooks/useAppUpdate.ts`](../src/renderer/src/hooks/useAppUpdate.ts) runs a delayed background check, supports manual refresh, and remembers a dismissed version.
- [`src/renderer/src/components/AppUpdateNotice.tsx`](../src/renderer/src/components/AppUpdateNotice.tsx) tells the user when a newer version exists.
- Settings already exposes update status and a manual check.
- The release workflow already validates exact tags, runs the cross-platform test suite, packages native applications, verifies Electron fuses, smoke-tests the packages, validates signatures when configured, creates checksums, and attests build provenance.

The missing half is delivery. Inertia currently opens the GitHub release page and asks the user to select an installer. It does not publish updater metadata, download an update, report download progress, or coordinate a safe restart and installation.

The recommended implementation is to place `electron-updater` behind the existing main-process update service. Inertia should continue checking automatically, but it must **not** download automatically, install automatically on quit, or restart silently. The user explicitly starts the download and explicitly chooses **Restart and install** after the package has been verified and after Inertia confirms that no active agent, terminal, maintenance, recovery, or persistence operation would be interrupted.

The existing public-release checker remains valuable as a manual fallback for development builds, community packages, unsupported package layouts, and production packages that do not satisfy the platform trust policy.

## Decision

Implement a user-controlled stable-channel updater with these product rules:

1. Keep the existing delayed background check and six-hour successful-check cache.
2. Use `electron-updater` only in an eligible packaged release build.
3. Set `autoDownload = false`.
4. Set `autoInstallOnAppQuit = false`.
5. Set `allowPrerelease = false` for stable builds.
6. Require an explicit **Download update** action.
7. Show bounded, accessible download progress and allow cancellation.
8. Require an explicit **Restart and install** action.
9. Never restart while authoritative active work or a protected local operation exists.
10. Run Inertia's orderly runtime and persistence shutdown before invoking `quitAndInstall`.
11. Preserve **View release** as a transparent fallback and as the source for complete release notes.
12. Do not render remote release HTML inside the trusted renderer.
13. Fail back to manual delivery instead of leaving the app in a broken or ambiguous state.
14. Keep the stable GitHub Release as the single production source of update artifacts.
15. Preserve the existing exact-tag, test, signing, checksum, provenance, and single-publisher release gates.

This proposal deliberately chooses a controlled updater rather than `checkForUpdatesAndNotify()`, whose default download and install-on-quit behavior is too implicit for an application that can have long-running agents, terminals, approvals, drafts, and local state.

## Current state

| Layer | Existing behavior | Gap to close |
| --- | --- | --- |
| Release discovery | `AppUpdateService` reads only the public latest-release tag, validates strict stable semantic versions, rejects redirects and oversized responses, coalesces concurrent checks, and caches successful results. | Discovery does not prove that a compatible, installable package and matching updater metadata exist. |
| Main process | Owns the update request and exposes a narrow `checkAppUpdate` IPC method. | No updater adapter, download lifecycle, install command, progress event, cancellation, or restart guard. |
| Preload/shared contract | Exposes a typed status snapshot and a single check method. | No typed push subscription or privileged download/install commands. |
| Renderer | Performs a delayed background check, shows an update notice, persists version dismissal, and provides a manual Settings check. | Only **View release** is available; no progress, downloaded state, retry, cancellation, or restart action. |
| Packaging | macOS arm64 builds DMG and ZIP; Windows x64 builds NSIS; Linux x64 builds AppImage. These are supported updater targets. | `electron-updater` is not an application dependency and the packaged app has no update-provider metadata. |
| Release assets | The latest release contains the DMG, macOS ZIP, NSIS installer, AppImage, and `SHA256SUMS.txt`. | It does not contain `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, or any updater companion files declared by those manifests. |
| Release workflow | Builds from an exact tag, tests all platforms, verifies packages, consolidates artifacts, attests them, uploads once, and publishes only after success. | The staging/finalization contract currently accepts only four desktop artifacts plus the checksum file. |
| Signing | macOS Developer ID/notarization and Windows Authenticode are supported when complete credentials are present; otherwise macOS uses the explicit ad-hoc path and Windows remains unsigned. | Production in-app eligibility must be explicit. A package must not claim it can safely self-install merely because it runs on a supported operating system. |
| Documentation | [`docs/RELEASING.md`](./RELEASING.md) accurately documents the current browser-only update notice. | It must eventually document updater metadata, trust eligibility, first-version bootstrap, and N-to-N+1 verification. |

The foundation is therefore sound. This is an extension of the current update service and release pipeline, not a rewrite.

## Goals and non-goals

### Goals

- Make stable Inertia releases discoverable, downloadable, and installable from inside the desktop application.
- Keep every disruptive action under explicit user control.
- Protect active work and local data before restart.
- Support the currently released package matrix:
  - macOS arm64 DMG/ZIP
  - Windows x64 NSIS
  - Linux x64 AppImage
- Keep update authority in the main process.
- Preserve the renderer sandbox and narrow preload bridge.
- Verify that updater metadata and binaries come from the same build.
- Preserve the current single-writer, publish-last GitHub Release workflow.
- Give users an honest manual fallback whenever in-app installation is unavailable.
- Make the updater deterministic and testable without contacting production GitHub Releases during unit or renderer tests.

### Non-goals

- Silent background downloads.
- Silent restart or forced installation.
- Installing automatically when the user closes Inertia.
- Pre-release, beta, nightly, or staged channels in the first implementation.
- Downgrades or same-version replacement releases.
- A custom update server.
- A hand-written installer or hand-written artifact downloader.
- Rendering GitHub release HTML in the renderer.
- Supporting package formats Inertia does not currently release.
- Treating unsigned or community packages as equivalent to trusted production packages.
- Making differential download a launch blocker. It is an optimization; a verified full download is an acceptable fallback.
- Publishing a tag or production release from the implementation pull request.

## User experience

### 1. Background check

After the desktop window is ready, Inertia keeps the existing delayed background check. The check is quiet and non-modal.

- A fresh successful result is cached for six hours.
- Repeated callers share one in-flight check.
- The Settings action can force a refresh.
- A network failure does not interrupt normal app use.
- A previously valid result may remain visible as cached, with honest stale/failure copy.

Only the selected update backend performs the check. Inertia must not make both a GitHub API request and an `electron-updater` request for the same cycle.

### 2. Current version

Settings displays:

- Current application version.
- Last successful check time.
- Whether the result is fresh or cached.
- **Check again**.

No global notice is shown.

### 3. Update available with in-app delivery

The global notice displays:

- `Inertia <version> is available`.
- **Download update** as the primary action.
- **View release** as the secondary action.
- A dismiss action for that specific version.

The renderer does not display remote HTML or trust remote asset names. Complete release notes remain on the externally opened GitHub release page.

### 4. Update available with manual delivery

When a newer version exists but the running package is not eligible for safe in-app delivery, the notice remains useful and honest:

- `Inertia <version> is available`.
- A short reason such as `This build must be updated manually`.
- **View release**.
- No disabled button that implies a temporary failure when the capability is structurally unavailable.

Examples include development/unpacked builds, unsupported package layouts, an ad-hoc macOS package, or an AppImage that cannot replace its source file.

### 5. Downloading

After explicit user action:

- The notice and Settings show percentage, transferred bytes, total bytes when known, and a restrained progress indicator.
- Progress values are validated and clamped before crossing the preload boundary.
- Accessibility announcements are throttled; the app must not announce every progress event.
- **Cancel download** is available.
- A second download request is idempotent and does not create a second transfer.
- The rest of Inertia remains usable.

### 6. Download complete

The notice changes to:

- `Inertia <version> is ready to install`.
- **Restart and install**.
- **Later**.
- **View release**.

`Later` removes the global interruption but keeps the downloaded state visible in Settings. Because `autoInstallOnAppQuit` is disabled, a normal quit must not unexpectedly install the update.

### 7. Restart safety

When the user selects **Restart and install**, the main process checks authoritative state before any window is closed.

The first implementation must block installation while any of the following is true:

- An agent turn is queued, starting, running, waiting for approval, or waiting for input.
- A terminal/PTY process is still active.
- A provider maintenance operation is running.
- A recovery import/export or another protected local data operation is running.
- The runtime is starting, restarting, or stopping.
- Persistence cannot be flushed or the runtime cannot stop cleanly within the bounded shutdown policy.

A blocked install explains what must finish. It does not cancel work, kill a process, or provide a force-install bypass in the first release.

When safe, Inertia:

1. Marks the update install request as accepted so duplicate commands are ignored.
2. Flushes required local state through existing authoritative persistence paths.
3. Performs the same orderly runtime/process-tree shutdown expected during a normal clean exit.
4. Confirms the shutdown receipt or fails without closing the app.
5. Calls `quitAndInstall(false, true)` only after preparation succeeds.

This explicit preparation is necessary because updater-driven quit ordering differs from a normal Electron quit and must not bypass Inertia's runtime lifecycle.

### 8. Error and retry

A check or download failure:

- Never crashes the app.
- Never erases a valid cached availability result unnecessarily.
- Produces a sanitized, user-actionable message.
- Returns to a retryable state.
- Retains **View release** whenever a trusted release URL is known.
- Does not expose local download paths, headers, stack traces, or provider internals to the renderer.

## Platform support and trust policy

| Platform/package | Technical updater path | Initial production policy | Fallback |
| --- | --- | --- | --- |
| macOS arm64 DMG + ZIP | `MacUpdater`/Squirrel.Mac. The ZIP target is already present and is required for macOS updater metadata. | In-app delivery only for a Developer ID-signed and notarized release. The current ad-hoc community path remains manual. | Open the exact GitHub release. |
| Windows x64 NSIS | `NsisUpdater`. The current installer target is compatible. | Enable in-app installation only after the release trust policy is explicitly satisfied. The recommended production policy is valid Authenticode signing; unsigned packages remain manual until maintainers deliberately approve otherwise. | Open the exact GitHub release. |
| Linux x64 AppImage | `AppImageUpdater`. | In-app delivery when the app is actually running from an AppImage and its source file can be replaced. Validate this at runtime rather than assuming every Linux launch is eligible. | Open the exact GitHub release. |
| Development/unpacked build | Fake/injected updater for tests only. | Never contact or install from the production update feed by default. | Optional manual latest-release check. |
| Community/repackaged build | Unknown package and signing guarantees. | Manual delivery unless the package opts into a separately documented and testable update policy. | Open the release page or distributor instructions. |

### Build-generated capability

The packaged app needs an explicit, deterministic capability marker generated by the release configuration, for example a small versioned resource such as:

```json
{
  "schemaVersion": 1,
  "channel": "latest",
  "delivery": "in-app",
  "platform": "windows-x64",
  "releaseBuild": true
}
```

The exact filename is an implementation detail, but the behavior is not:

- Local development defaults to manual delivery.
- A release build opts into in-app delivery only when its package and trust requirements are satisfied.
- Runtime checks may downgrade `in-app` to `manual`, never upgrade an ineligible build by guesswork.
- The marker contains no token, secret, mutable URL, or user-specific information.
- Tests validate all generated variants.

## Architecture

### Main-process ownership

`electron-updater` runs only in the Electron main process. The renderer never receives the updater object, a feed URL, a downloaded file path, request headers, or permission to choose an artifact.

The existing `AppUpdateService` becomes the stable façade and owns:

- Backend selection.
- State transitions.
- Successful-check caching.
- Request coalescing.
- Updater event listener lifetime.
- Download cancellation.
- Status broadcasting.
- Install eligibility.
- Graceful shutdown coordination.
- Sanitized diagnostics.

Do not spread direct `autoUpdater` calls through `src/main/index.ts`, IPC handlers, and renderer code. Wrap it behind an adapter that can be replaced by a deterministic fake.

### Backend selection

At startup the service selects exactly one backend:

1. **Installable updater backend** for an eligible packaged release.
2. **Manual public-release backend** using the current bounded GitHub latest-release checker for unsupported or ineligible builds.

Backend selection is fixed for the process lifetime. A network error must not cause the app to switch backends mid-download or report contradictory results.

### Updater configuration

For the installable backend:

- `autoDownload = false`.
- `autoInstallOnAppQuit = false`.
- `allowPrerelease = false`.
- `allowDowngrade = false`.
- Use the build-generated provider configuration; do not call `setFeedURL` from renderer data or settings.
- Use the official ESM-compatible import pattern required by the current CommonJS `electron-updater` package.
- Register listeners once and dispose them during service teardown/tests.
- Ignore or sanitize release HTML/content. Version and trusted release-page URL are sufficient for the UI.

### Proposed shared snapshot

The final names may follow repository conventions, but the renderer needs one authoritative serializable snapshot rather than several loosely synchronized booleans.

```ts
export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "downloaded"
  | "unavailable";

export type AppUpdateDelivery = "in-app" | "manual";

export type AppUpdateCapabilityReason =
  | "development-build"
  | "unsupported-package"
  | "signature-required"
  | "appimage-not-replaceable"
  | "active-work"
  | "shutdown-not-ready"
  | null;

export interface AppUpdateProgress {
  percent: number;
  transferredBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number | null;
}

export interface AppUpdateStatus {
  phase: AppUpdatePhase;
  freshness: "fresh" | "cached" | "unavailable";
  delivery: AppUpdateDelivery;
  capabilityReason: AppUpdateCapabilityReason;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  checkedAt: string | null;
  lastAttemptedAt: string | null;
  progress: AppUpdateProgress | null;
  retryable: boolean;
  message: string;
}
```

Important contract rules:

- Every numeric field is finite, non-negative, bounded, and validated before exposure.
- `releaseUrl` is constructed from the fixed Inertia repository and validated by the existing external-navigation policy.
- Error text is generated locally from a small reason-code mapping, not copied from arbitrary exception messages.
- Downloaded filesystem paths never cross IPC.
- `downloaded` is only reachable after the updater's verified `update-downloaded` event.
- `install` is only accepted from `downloaded` and after a fresh restart-safety check.

### Narrow IPC surface

Extend the desktop bridge with intent-oriented methods:

```ts
checkAppUpdate(force?: boolean): Promise<AppUpdateStatus>;
downloadAppUpdate(): Promise<AppUpdateStatus>;
cancelAppUpdateDownload(): Promise<AppUpdateStatus>;
installAppUpdate(): Promise<AppUpdateStatus>;
onAppUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void;
```

Requirements:

- Use the repository's existing trusted-sender IPC registration policy.
- Validate the optional `force` argument strictly.
- No method accepts a URL, channel, version, path, command, or installer name.
- Command responses return the latest authoritative snapshot.
- Push events keep all mounted surfaces synchronized.
- A newly mounted renderer can request the current snapshot without starting a new network operation.
- The preload listener returns an unsubscribe function and does not leak listeners across reloads.

### State and concurrency rules

- At most one check is active.
- At most one download is active.
- A check during download returns the current snapshot and does not replace it.
- A download is accepted only for the currently advertised newer version.
- Duplicate download/cancel/install commands are idempotent.
- A cancelled or failed download returns to `available` when the release remains known.
- A forced check bypasses the successful-check cache only when no download/install transition is active.
- An update event for an unexpected version is rejected and logged as a sanitized integrity/lifecycle failure.
- Status broadcasts are ordered and stale callbacks from a previous attempt cannot overwrite a newer attempt.

### Renderer integration

Evolve the existing `useAppUpdate` controller rather than creating a second updater state store.

- Keep version-specific dismissal for the `available` state.
- Do not hide active download progress merely because the original availability notice was dismissed.
- Let `Later` hide the downloaded global notice while preserving the state and action in Settings.
- Keep the always-loaded `AppStatusOverlays` boundary so update UI remains available independently of lazy Settings surfaces.
- Preserve quota/error overlay spacing and narrow viewport behavior.
- Add accessible labels, focus states, reduced-motion behavior, and throttled live-region updates.

## Release-pipeline contract

### Feed choice

The preferred first implementation uses an `electron-builder` **generic provider** whose fixed base URL is the public GitHub Releases latest-download endpoint:

```text
https://github.com/eduardtomas1/inertia/releases/latest/download
```

Why this is preferred for Inertia's current workflow:

- The app still downloads only from GitHub Releases.
- No update server is required.
- No client token is required for the public repository.
- `electron-builder` can generate provider metadata while the existing workflow remains responsible for uploading files.
- Matrix build jobs can retain read-only repository permissions.
- The final upload job remains the only GitHub Release writer.
- A draft release remains invisible until all platform artifacts are validated and the workflow publishes it.

The implementation must prove this behavior against the pinned `electron-builder` version before relying on it. The expected release build mode is a configured generic provider with explicit publish intent so update metadata is generated, while generic-provider files continue through Inertia's manual staging/upload pipeline. Do not change the workflow to direct matrix uploads merely to make metadata appear.

If the pinned builder cannot generate the required metadata without attempting an external write, stop and document the incompatibility in the implementation PR. Preserve the single-writer model and choose a tested metadata-generation approach rather than weakening release permissions or hand-writing undocumented YAML.

### Required generated metadata

At minimum, the release build must produce and publish:

- `latest.yml` for Windows.
- `latest-mac.yml` for macOS.
- `latest-linux.yml` for Linux.
- Every companion file referenced by those manifests, when generated by the pinned builder.
- The existing NSIS installer, DMG, macOS ZIP, and AppImage.
- `SHA256SUMS.txt` covering the complete final public asset set except itself.

The package must also contain the builder-generated `app-update.yml` in its resources. The implementation must test its provider, URL, and channel without exposing secrets.

Do not hard-code a final asset count until the pinned builder's output is verified. The finalizer should instead accept an exact allowlisted set derived from platform policy plus validated manifest references. Unexpected files still fail closed.

### Manifest validation

Extend `scripts/release-assets.mjs` or a focused validator so publication fails unless:

- Each metadata file parses under a bounded YAML parser.
- Its version exactly equals `package.json` and the exact release tag.
- Its stable channel is `latest`.
- Every referenced artifact exists in the same platform staging directory.
- Referenced filenames contain no path traversal, absolute path, URL, query, control character, or cross-platform collision.
- Declared sizes are finite positive safe integers when present.
- Declared SHA-512 values have the expected encoding and match files from the same build.
- Platform/architecture match the release matrix.
- The Windows metadata selects the normalized `Inertia.Setup.<version>.exe` name.
- The macOS metadata is backed by the required ZIP/DMG output from the same build.
- Linux metadata selects the exact x64 AppImage.
- No manifest points to a previous release artifact.
- No metadata or packaged provider configuration contains a token or mutable user input.

Artifact and updater metadata must be staged together before the matrix artifact is uploaded. The final job revalidates the downloaded stage manifests and bytes before consolidation.

### Existing gates that remain mandatory

The updater implementation must preserve, not bypass:

- Exact `vMAJOR.MINOR.PATCH` tag and commit validation.
- Locked dependency installation.
- `npm run check` on every platform.
- Portable provider/runtime tests.
- Electron end-to-end tests.
- Production dependency audit.
- Linux package validation.
- Electron fuse verification.
- Native packaged-app smoke tests.
- macOS signature/notarization verification when configured.
- Windows Authenticode verification when configured.
- Third-party notice generation.
- Per-platform staging manifests.
- Cross-platform consolidation.
- SHA-256 checksum publication.
- Build provenance attestation.
- Draft-first, publish-last GitHub Release behavior.
- Refusal to replace existing release assets silently.

### Publication atomicity

The published release must never expose metadata before all referenced packages exist.

The final job should:

1. Download all three platform build artifacts.
2. Revalidate bytes and updater manifests.
3. Consolidate the exact final asset set.
4. Generate checksums over that set.
5. Attest the complete set.
6. Create or reuse a draft release.
7. Upload every validated asset without replacement.
8. Verify the draft contains exactly the expected names and digests.
9. Publish it as latest only after verification succeeds.

Because draft releases are not visible to the updater, this preserves an atomic public transition.

## Security, privacy, and shutdown safety

### Fixed authority

- The update source is compiled/generated by the release build.
- The renderer cannot choose a provider, channel, URL, release, artifact, or path.
- The public app contains no `GH_TOKEN`, `GITHUB_TOKEN`, or private repository credential.
- The release-page fallback is constructed from the fixed `eduardtomas1/inertia` repository and a validated stable version.

### Artifact integrity

- `electron-updater` validates update metadata hashes before reporting a completed download.
- Inertia's release pipeline independently preserves SHA-256 checksums and provenance attestations.
- Metadata and binaries are generated and staged together.
- A mismatch fails closed; it does not fall back to launching an unverified downloaded file.
- No hand-written HTTP downloader or installer invocation is permitted.

### Signing

- macOS in-app delivery requires a real Developer ID-signed/notarized production package; ad-hoc signing remains a build/test path, not production auto-update authority.
- Windows production in-app policy should require valid Authenticode signing before rollout unless maintainers make and document a deliberate alternative decision.
- Linux has no equivalent platform code-signing gate in the current AppImage path, so it relies on the fixed HTTPS feed, builder metadata integrity, release checksums, provenance, and explicit user action.

### Renderer isolation

- Only validated snapshots cross the preload bridge.
- Remote release notes are not rendered.
- Download paths, exception stacks, request headers, and native updater objects remain privileged.
- IPC methods express fixed intents and accept no arbitrary filesystem or network capability.

### Diagnostics

Add privacy-safe lifecycle events such as:

- `update-check-started`
- `update-check-current`
- `update-check-available`
- `update-check-failed`
- `update-download-started`
- `update-download-cancelled`
- `update-download-completed`
- `update-download-failed`
- `update-install-requested`
- `update-install-blocked`
- `update-install-prepared`

Do not record release-note bodies, local installer paths, headers, project paths, prompts, messages, credentials, or raw exception output. Progress logging should be bucketed or omitted to avoid noisy diagnostics.

### Shutdown coordination

Calling `quitAndInstall` is a privileged lifecycle transition, not a UI shortcut.

The implementation must add a testable `prepareForUpdateInstall` path that:

- Queries authoritative runtime/operation state.
- Rejects while work is non-terminal.
- Flushes persistence.
- Stops runtime and child process trees using existing supervision.
- Waits for a bounded clean-shutdown receipt.
- Leaves the app open when preparation fails.
- Calls the updater only once after success.

A renderer-provided `safe: true` flag is not acceptable. The main process owns the decision.

## Implementation map

The follow-up implementation is expected to touch these areas. Exact file boundaries may change when the work begins, but responsibilities should remain separated.

### Dependencies and packaging

- `package.json`
  - Add `electron-updater` to `dependencies`, not `devDependencies`.
  - Add fixed generic-provider update configuration for the stable channel.
  - Keep DMG + ZIP, NSIS, and AppImage targets.
- `package-lock.json`
  - Commit the locked dependency graph.
- `scripts/electron-builder.release.cjs`
  - Generate the package eligibility marker from the exact platform/signing path.
  - Preserve fail-closed partial-credential handling.
- Add focused packaging tests for provider configuration and eligibility markers.

### Release pipeline

- `.github/workflows/release-platforms.yml`
  - Use explicit metadata-generation intent compatible with the generic provider.
  - Keep build jobs read-only and the final upload job as the single writer.
  - Stage updater metadata and companions with their platform packages.
  - Preserve every existing quality and signing gate.
- `scripts/release-assets.mjs`
  - Validate, stage, consolidate, checksum, and allowlist updater files.
  - Reject metadata/artifact mismatches and unexpected files.
- `docs/RELEASING.md`
  - Document metadata, eligibility, bootstrap, signed package requirements, and N-to-N+1 release validation.

### Main process

- `src/main/app-update.ts`
  - Evolve the existing service façade and preserve its bounded manual fallback, cache, and request coalescing.
- A focused updater adapter module
  - Encapsulate `electron-updater` import/configuration/events.
  - Provide a fake implementation for tests.
- `src/main/index.ts`
  - Register narrow IPC, trusted-sender checks, status broadcasting, and install-shutdown coordination without embedding updater policy inline.
- Existing runtime/persistence supervision
  - Expose an authoritative, bounded update-install readiness/preparation operation rather than duplicating lifecycle logic.

### Shared/preload contract

- `src/shared/desktop.ts`
  - Replace/extend the update snapshot and bridge methods.
  - Add strict parsers where request payloads require them.
- `src/preload/index.ts`
  - Expose fixed update intents and a disposable status subscription.
  - Keep `contextIsolation` and sandbox boundaries unchanged.

### Renderer

- `src/renderer/src/hooks/useAppUpdate.ts`
  - Consume authoritative push snapshots and issue idempotent commands.
  - Preserve delayed checking, forced refresh, dismissal, and external fallback.
- `src/renderer/src/components/AppUpdateNotice.tsx`
  - Add available, downloading, downloaded, blocked, retry, and manual-delivery presentations.
- `src/renderer/src/components/AppStatusOverlays.tsx`
  - Preserve overlay ownership and spacing.
- `src/renderer/src/components/SettingsView.tsx`
  - Provide durable status, progress, download, cancellation, and install actions.
- Styles/tests
  - Cover narrow layouts, keyboard use, accessible names, reduced motion, and live-region throttling.

### Tests

Extend the current update test locations rather than creating an isolated unowned test harness:

- `tests/main/app-update.test.ts`
- `tests/renderer/app-update-notice.test.ts`
- New focused adapter, IPC, release-metadata, shutdown-readiness, and packaged update tests where appropriate.

## Testing and verification

### Unit: service and adapter

Test with an injected fake updater; production GitHub must not be contacted.

- Backend selection for packaged, development, signed, unsigned, AppImage, and unsupported cases.
- Strict stable version handling.
- Check request coalescing and six-hour cache behavior.
- Forced refresh behavior.
- Listener registration exactly once and deterministic teardown.
- `checking -> current`.
- `checking -> available`.
- `available -> downloading -> downloaded`.
- Download progress validation and clamping.
- Cancellation and retry.
- Network, metadata, integrity, and updater errors.
- Stale callback suppression across attempts.
- Duplicate command idempotency.
- Manual fallback retaining the existing bounded response rules.
- Stable channel rejecting prerelease and downgrade candidates.

### Unit/integration: IPC and shutdown

- Trusted renderer can check, download, cancel, install, and subscribe.
- Untrusted sender is rejected.
- Malformed arguments are rejected.
- Renderer cannot provide a feed URL, version, path, or artifact name.
- Downloaded paths never appear in responses/events.
- Install is rejected before `downloaded`.
- Install is blocked for every non-terminal agent state.
- Install is blocked for active PTY, maintenance, recovery, and unstable runtime states.
- Failed persistence flush/runtime stop leaves the app open.
- Successful preparation calls `quitAndInstall` exactly once.
- Normal app quit after download does not install automatically.

### Renderer

- Delayed initial check still happens once.
- Dismissal is version-specific.
- Manual-only build shows **View release**, not a misleading download action.
- Download action, progress, cancellation, retry, downloaded state, and **Later** behavior.
- Settings always exposes the current update state.
- Push events and command responses cannot regress to stale state.
- Overlay offsets remain correct with quota and error notices.
- Keyboard focus, screen-reader labels, reduced motion, forced colors, narrow viewport, and progress announcement throttling.

### Release contracts

- Pinned builder produces `app-update.yml` and the expected platform metadata.
- Generic-provider build performs no GitHub Release write from matrix jobs.
- Metadata version equals package/tag version.
- Every declared artifact exists and matches SHA-512.
- Metadata and packages from different builds are rejected.
- Previous-version artifact names are rejected.
- Unexpected files and path traversal are rejected.
- Final checksums and provenance include all public updater assets.
- Draft remains unpublished if any platform or manifest fails.
- Final publication verifies exact names and digests.

### Packaged N-to-N+1 tests

The feature is not proven by a mocked event test alone.

Create a deterministic update fixture using two packaged versions and a local/static test feed:

1. Build version N with the updater enabled.
2. Build version N+1 from the same test fixture.
3. Generate matching metadata and serve it from an isolated local endpoint.
4. Install/run N using the native package format.
5. Verify it reports N+1.
6. Download and verify progress/completion.
7. Verify active-work blocking independently.
8. Restart/install when safe.
9. Verify the relaunched application reports N+1.
10. Verify the existing user-data directory and database remain intact.

Run the real packaged test on:

- Windows x64 NSIS.
- Linux x64 AppImage.
- macOS arm64 only with a signing setup accepted by the updater path; an ad-hoc package is not evidence that production macOS updating works.

Also test:

- Offline check.
- Interrupted download.
- Corrupt or mismatched metadata/artifact.
- Read-only AppImage location.
- User cancellation.
- Relaunch failure recovery.
- Full-download fallback when differential transfer is unavailable.

## Rollout and compatibility

### Bootstrap limitation

Inertia `0.0.31` and earlier can discover a release but cannot download/install it in-app. Therefore:

- The first updater-enabled stable version must still be installed manually.
- Only that version and later can exercise production in-app delivery.
- Release communication should say this explicitly.

### Recommended rollout

#### Phase 1: metadata and fake-adapter proof

- Add the dependency, configuration, state machine, IPC, UI, and deterministic tests.
- Prove metadata generation and single-writer publication contracts.
- Do not publish from the implementation PR.

#### Phase 2: native package canary

- Run signed/trusted packaged N-to-N+1 tests on each supported platform.
- Manually inspect the published draft asset set and `app-update.yml` configuration.
- Verify active work cannot be interrupted.

#### Phase 3: first stable updater release

- Publish version N through the normal exact-tag workflow.
- Users install N manually.
- Monitor privacy-safe update-check/download errors.

#### Phase 4: first production self-update

- Publish N+1 only after N has been exercised on canary machines.
- Verify N discovers, downloads, installs, and relaunches N+1 on all eligible platforms.

### Rollback

Do not replace or republish the same version. If a released updater version is faulty, publish a fixed version with a strictly higher semantic version. Clients already on the faulty version must have a monotonic upgrade path.

## Failure handling

| Failure | Required behavior |
| --- | --- |
| GitHub/feed unavailable | Keep Inertia usable; show cached status when valid; allow retry and release-page fallback. |
| Metadata missing | Report update check unavailable/manual; never guess an artifact. Release CI should prevent this in production. |
| Metadata/artifact hash mismatch | Abort download/install, discard the candidate through updater APIs, and surface a sanitized integrity failure. |
| Download interrupted | Return to a retryable available state; retain the installed app untouched. |
| User cancels | Stop the transfer and return to available without treating cancellation as an application error. |
| Disk full/permission denied | Keep current app installed and usable; show a local actionable message without paths. |
| AppImage not replaceable | Downgrade capability to manual and open the release page. |
| macOS package not production signed | Manual delivery only. |
| Active work exists | Block restart/install and identify the category of work that must finish. |
| Graceful shutdown fails | Do not call `quitAndInstall`; leave the app open and retryable. |
| Installation fails after handoff | Existing installed version/user data must remain recoverable through platform installer behavior; document diagnostics location. |
| Newer release appears during download | Finish or cancel the current authoritative attempt; do not silently switch artifacts mid-transfer. |
| Draft release exists | Ignore it; only published latest releases are eligible. |

## Alternatives considered

### Keep browser-only updates

This is safe and already implemented, but it leaves users to identify the correct architecture/package, download it, close Inertia, run an installer, and relaunch. It also reduces update adoption. Retain it as fallback, not the primary eligible-package experience.

### Electron's built-in `autoUpdater`

Rejected for this package matrix. `electron-updater` integrates with `electron-builder`, supports Inertia's Linux AppImage target, produces/consumes the required metadata, and exposes progress across supported platforms.

### `checkForUpdatesAndNotify()` with defaults

Rejected. Automatic download and install-on-quit defaults are inappropriate for an app with active agents, terminals, approvals, and local state. Inertia needs an explicit state machine and restart guard.

### Hand-written GitHub asset downloader

Rejected. It would duplicate metadata parsing, integrity verification, platform installer behavior, delta handling, cache behavior, and signature integration, while creating a larger privileged attack surface.

### Direct publishing from each matrix job

Rejected as the default design. It expands write permissions, introduces release races, and weakens the current single-writer validate-then-publish model. The generic-provider/manual-upload approach should be proven first.

### Separate update server

Rejected for the first implementation. Public GitHub Releases already host the packages, checksums, and provenance and can host the updater metadata. No additional infrastructure is necessary.

### Silent forced updater

Rejected. User control and active-work preservation are product requirements, not optional polish.

## Acceptance criteria

### Product behavior

- [ ] Inertia performs one delayed background update check without blocking startup.
- [ ] Settings can force a check and shows fresh/cached/unavailable status accurately.
- [ ] Stable eligible builds detect a newer published stable release.
- [ ] No prerelease or downgrade is selected.
- [ ] Automatic download is disabled.
- [ ] Automatic install on normal app quit is disabled.
- [ ] The user can explicitly download, cancel, retry, defer, and restart/install.
- [ ] Progress is bounded, accessible, and synchronized across the notice and Settings.
- [ ] Manual-only builds give an honest reason and retain **View release**.
- [ ] Remote release HTML is not rendered in Inertia.

### Safety and architecture

- [ ] `electron-updater` exists only behind a main-process adapter/service.
- [ ] Renderer IPC accepts no URL, channel, version, artifact, path, or installer command.
- [ ] Download paths and raw updater errors never cross the preload bridge.
- [ ] Checks/downloads/install requests are coalesced or idempotent.
- [ ] Event listeners are registered once and disposed in tests/teardown.
- [ ] The install command is rejected before a verified downloaded state.
- [ ] Every defined active-work/protected-operation condition blocks installation.
- [ ] A failed orderly shutdown leaves Inertia open and does not invoke the installer.
- [ ] A successful preparation invokes `quitAndInstall` exactly once.
- [ ] Existing user data remains intact across the packaged N-to-N+1 test.

### Platform trust

- [ ] macOS in-app delivery is enabled only for an accepted Developer ID-signed/notarized package.
- [ ] The Windows production policy is explicit and tested; recommended rollout requires valid Authenticode signing.
- [ ] Linux verifies it is running from a replaceable AppImage before advertising install capability.
- [ ] Development, unpacked, unsupported, and community packages default to manual delivery.
- [ ] Runtime checks may downgrade capability but cannot upgrade an ineligible build by inference.

### Release pipeline

- [ ] The pinned builder generates internal `app-update.yml` and all three public platform metadata files.
- [ ] Matrix jobs retain read-only repository permissions.
- [ ] The final release job remains the single GitHub Release writer.
- [ ] Metadata and declared artifacts are generated/staged together and cryptographically matched.
- [ ] Unexpected, missing, cross-version, cross-platform, or path-traversing manifest entries fail the release.
- [ ] Checksums and provenance cover the complete public updater asset set.
- [ ] A release remains draft/invisible until every package and manifest is present and verified.
- [ ] Existing exact-tag, tests, audit, fuse, package smoke, signing, notices, and no-replacement gates remain intact.

### Verification

- [ ] Unit tests cover every state transition, cancellation, retry, stale callback, and fallback.
- [ ] IPC tests cover trusted sender, malformed requests, authority boundaries, and shutdown readiness.
- [ ] Renderer tests cover actions, status synchronization, accessibility, narrow layouts, and overlay interaction.
- [ ] Release tests validate builder output and manifests from the pinned dependency version.
- [ ] Real packaged N-to-N+1 updates pass on every eligible platform.
- [ ] Offline, interrupted, corrupted, read-only, and active-work scenarios leave the current app usable.
- [ ] `npm run check` passes.
- [ ] Electron end-to-end tests pass on Linux, macOS, and Windows.
- [ ] Native package smoke, fuse, signature, and release-asset gates pass on the exact implementation head.

## Codex implementation handoff

Use this document as the authoritative implementation contract after the proposal is approved and squash-merged.

Codex should:

1. Start from the latest `main`, not this proposal branch.
2. Reinspect the pinned Electron/electron-builder versions and current release workflow before editing.
3. Implement the smallest coherent architecture that satisfies the decisions and acceptance criteria above.
4. Preserve the existing bounded manual checker as the unsupported-build fallback.
5. Keep `electron-updater` behind an injected main-process adapter and test with a fake.
6. Prove generic-provider metadata generation with the pinned builder before changing release staging.
7. Preserve matrix read-only permissions and the single final release uploader.
8. Add strict metadata validation; never hand-wave artifact/hash matching.
9. Reuse authoritative runtime/persistence shutdown logic and never trust the renderer to declare installation safe.
10. Keep auto-download, auto-install-on-quit, prerelease, downgrade, and silent restart disabled.
11. Add focused unit, IPC, renderer, release-contract, and packaged N-to-N+1 tests.
12. Update `docs/RELEASING.md` with the final verified behavior and operator procedure.
13. Do not bump the public version, create a tag, publish a release, merge, or alter signing policy silently in the implementation PR.
14. Document any necessary deviation from this proposal with evidence in the implementation PR before requesting review.
15. Run the complete repository gates and report exact commands/results, including platform limitations that require CI.

The implementation PR should reference this proposal PR, be reviewed on its exact head, and be squash-merged only after cross-platform CI and the real packaged update contract are green.

## References

- [electron-builder: Auto Update](https://www.electron.build/docs/features/auto-update/)
- [electron-builder: Publish configuration](https://www.electron.build/publish/)
- [electron-builder: Auto-update troubleshooting](https://www.electron.build/docs/troubleshooting/)
- [electron-updater API](https://www.electron.build/docs/api/electron-updater/)
- [AppUpdater API](https://www.electron.build/docs/api/electron-updater.class.appupdater/)
- [Generic provider options](https://www.electron.build/docs/api/builder-util-runtime.interface.genericserveroptions/)
- [Inertia release workflow](../.github/workflows/release-platforms.yml)
- [Inertia release asset validator](../scripts/release-assets.mjs)
- [Inertia release documentation](./RELEASING.md)
- [Current Inertia update service](../src/main/app-update.ts)
- [Current update service tests](../tests/main/app-update.test.ts)
