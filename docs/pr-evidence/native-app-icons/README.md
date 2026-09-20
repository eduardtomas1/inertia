# Native application icons

Base: `d56f972b32fadfa29169bb8390401f5ca49e419b` (v0.0.60 plus the merged snapshot fixture fix).

Windows windows previously received the 512px PNG. Electron 44.3.0 asks for the
system small/large HICON sizes, but its PNG bitmap path creates an HICON from the
full bitmap; the ICO path uses `LoadImage` with the requested size. The change
ships one ICO containing the existing logo at 16, 20, 24, 32, 40, 48, 64, 128 and
256px, and supplies it to both the packager and the shared main/detached window
asset resolver. Existing PNG pixels are unchanged.

Source: [Electron NativeImage](https://github.com/electron/electron/blob/v44.3.0/shell/common/api/electron_api_native_image.cc)
and [BaseWindow icon handling](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_base_window.cc).
The Windows E2E fixture reads the actual window's small and large HICONs, checks
their dimensions against system metrics, and compares pixel hashes to the ICO
loaded by Windows. Native Windows execution is required before merge; a macOS
unit test is not evidence of Windows taskbar rendering.

Linux packaging advertised `StartupWMClass=Inertia`, while Electron's desktop
identity produces `dev.inertia.app`. Align the packaged launcher with that
identity (and retain the existing distinct Canary identity). An AppImage embeds
an icon but does not itself leave a persistent host launcher that GNOME can use
after its temporary mount disappears. On first launch, register a matching
per-user desktop entry and persistent PNG. Preserve entries owned by another
integrator; refresh only an Inertia-managed entry. Publish complete files, reject
linked integration directories/entries, and quote Exec values without a shell.

On Ubuntu 24.04 ARM64, native validation proved:

- `desktop-file-validate` accepts the generated entry; `Gio.DesktopAppInfo` finds
  it by its desktop ID and resolves the persistent PNG.
- GLib launches the exact executable when its filename includes spaces, quotes,
  dollar signs, backticks, a backslash and a literal percent. The original direct
  Exec form failed GLib's executable lookup despite passing syntax validation.
  `/usr/bin/env --` places the escaped AppImage path after the lookup target and
  preserves the actual argument through field-code expansion.
- A real Electron window reports both X11 WM_CLASS values as `dev.inertia.app`.
- The emitted deferred caller runs the real utility worker inside the packaged
  ASAR, sets GIO `metadata::custom-icon`, and preserves a pre-existing user-selected
  icon. Archive inspection caught a relative path resolving from the deferred
  chunk's directory; the caller now receives the explicit application worker path.
  The optional operation is isolated from the main process with a five-second
  timeout and termination, plus explicit fatal-error,
  message-failure, nonzero-exit and termination-failure handling.

GLib's lookup order is visible in
[g_desktop_app_info_load_from_keyfile](https://github.com/GNOME/glib/blob/2.80.0/gio/gdesktopappinfo.c).
The file-manager icon depends on its metadata service and appears after launch;
the app cannot change the thumbnail of an unopened download. GNOME Wayland dock
appearance and Windows Explorer cache refresh were not visually exercised on the
local macOS host. Keep those limitations separate from the native GLib/X11 proof.

Validation: focused icon/runtime/channel tests passed (36 tests); Linux packaging
contracts passed (13 tests). Native Ubuntu ARM64 build, AppImage identity/icon
validation, package smoke and fuses passed. Final-container verification passed
the default mount/AppRun path, real installed update and relaunch with preserved
history/settings/provider sessions, guardian-sealed fd handoff, and extract-and-run
fallback. The isolated container needed an init reaper and FUSE device; initial
smokes correctly failed on zombie cleanup and unavailable FUSE until those local
test prerequisites were configured. No application assertion was relaxed.

The final Node 22 `npm run check`, after the caller-path correction, passed:
9,357 tests plus seven separately run process tests, with 146 documented skips;
quality, architecture, the application and Private Connect builds, and all
renderer budgets passed. Hosted native platform results remain required before
merge and are recorded in the PR. No release tag or version is changed by this
work.
