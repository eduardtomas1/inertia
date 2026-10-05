# Snapshots and compaction receipts

## Protected snapshots

Snapshots is experimental. Open **Settings → Devices & integrations → Snapshots** and turn on **Window snapshots**. Return to your chat and focus its message box before switching to the window you want to share. On macOS and
Windows, press both physical Shift keys together while another application is
foreground. You can instead select Cmd+Option+S on macOS or Ctrl+Alt+S on Windows.
Linux X11 uses Ctrl+Alt+S. The selected chat receives a removable screenshot tile
with the application and window names. Open it to inspect the image or its
accessibility data before sending. Capture does not send a message automatically.

macOS requires Accessibility and Screen Recording permission; the Snapshots settings page
opens the relevant system settings only after an explicit click. Snapshots starts
disabled and saves the chosen setting locally. Linux requires an X11 desktop and
working AT-SPI accessibility. Inertia matches the X11 foreground process, window title, and geometry to one accessibility window, including Chromium windows that omit the accessibility active-window flag. Protected foreground capture remains unavailable on Wayland. Use the reviewed screenshot workflow below instead.
Applications that omit accessibility information can provide incomplete context.
On Linux, Chromium and Electron apps can expose an empty accessibility tree until
their accessibility bridge is enabled. Snapshots refuses to capture such a window,
because it cannot locate fields to mask, and suggests restarting the app with
`--force-renderer-accessibility` or `ACCESSIBILITY_ENABLED=1`. Only macOS has an
app-level permission that Inertia can check. Elsewhere access is established per
window at capture time, so the permission state is reported as unverified.

The protected capture worker verifies the window before and after taking pixels. It masks detected editable
controls and protected fields in the image and omits their text and descendants
from context. Screenshots and accessibility context may still contain sensitive
information. The [backend captures pixels under the window bounds](https://xa11y.dev/guides/screenshots/),
which can include overlapping windows outside that accessibility tree. Review the
attachment before sending it. A changed foreground identity, an
incomplete protected-field scan, changed protected-field geometry across the
screenshot, timeout, or oversized image fails the capture.
Failures keep a fixed category across the worker boundary: target accessibility
unavailable, no identifiable active window, an actual permission denial, invalid
protected geometry, or a native capture failure. Each has its own message, and
only a typed denial from the native backend is reported as a permission problem.
An unavailable accessibility tree or missing active window is retried twice,
250 ms apart, within the first second. Each retry repeats the full
foreground-identity and masking checks. The runtime log records only the capture
phase and category, never window titles, accessibility text, pixels, raw
exceptions or identifiers.
Only the two Shift modifiers are sampled for the default shortcut; no typed text
or general keyboard events are recorded. There is no continuous screen capture.

Accessibility output is limited to 512 nodes and 24 KiB, and images to 2048 pixels
on either edge and 8 MiB. Existing message and attachment budgets still apply.
Main owns capture, native workers, permissions, attachment capabilities and
cleanup. The renderer receives a validated attachment and source metadata, with
no filesystem or arbitrary native API. Native bytes are delivered only after the
capture worker exits. Disabling immediately revokes an active capture and its
import lease; acknowledgment waits for worker exit and import rollback. Revoked
work cannot attach or focus a window, even after re-enabling. Sending resolves the attachment again through the trusted
main/runtime broker; renderer-supplied snapshot substitutions are ignored. The
provider receives the accessibility tree as quoted, untrusted attachment context.
Visible user text and diagnostic execution manifests exclude that content.

## Reviewed screenshots on Linux

Click **Take reviewed screenshot** beside the composer attachment button. This
manual action works independently of the protected snapshot setting and shortcut.
On X11, choose a window or screen from the previews. On Wayland, Electron uses
PipeWire and the desktop's system picker; this requires a working desktop portal.
A cancelled, denied, empty, or ambiguous system selection stops the operation.
Inertia does not try another capture method after that outcome.

The selected image opens in a local review dialog. Automatic masking is **not
verified** in this mode. Drag a rectangle or enter its pixel coordinates, then
choose **Crop to area** or **Mask area**. Each edit produces a new preview. Only
**Attach reviewed image** imports those exact reviewed bytes into the originating
chat. The image has no inferred application identity or accessibility context.
Sending remains a separate composer action.

Unapproved pixels remain in memory. Review expires after three minutes without activity; changing
the selected chat, closing/navigating its window, discarding, disabling capture,
or quitting revokes it. Approvals are checked against the originating document,
chat, review identifier and current image revision. Attachment imports use the
existing leases and rollback handling. Images are bounded to 2048 pixels per edge
and 8 MiB. The X11 list shows up to 48 sources within a 4 MiB preview budget.
A selected screen is captured at its display's native resolution, scaled down to
fit 2048 pixels. Electron does not report a window's native size, so a selected
window, and the Wayland system selection, are scaled to fit 2048 pixels per
edge; a smaller window is enlarged to that size.

System selection has a two-minute deadline; ordinary X11 acquisition has a
15-second deadline. Electron does not expose a cancellation API for an open
system picker. Close that system dialog when cancelling; Inertia discards late
results and prevents a second picker until the native request settles. Disable
and shutdown report unconfirmed cleanup if it remains open. No desktop-specific
GNOME extension, KDE helper, or Wayland global shortcut is added by this workflow.

## Compaction receipts

Successful explicit `/compact` operations leave a persistent timeline separator,
with the provider's before/after context counts when both are known. For example:
**Compacted context 173K → 5.69K tokens**. Missing counts produce **Compacted
context**, without an estimated reduction. Failure, cancellation, unsupported
providers, and unconfirmed provider cleanup produce no success receipt. The
existing provider compaction operation and ownership rules are preserved; the
receipt is a system message, not a fabricated agent turn. Schema migration 71
adds its bounded metadata without changing any released migration.
If the provider completes compaction but local receipt storage or timeline refresh
fails, the success notice explains that reporting failure without inviting a
second compaction.

## T3 Code reference and adaptation

The supplied [SnapShots post](https://x.com/jullerino/status/2097144040076820983)
and [compaction post](https://x.com/maria_rcks/status/2095759183832383995) were
checked against their attached demo and image. The demo establishes the global
shortcut, return to composer, screenshot tile, application/window identity,
removal and inspectable accessibility JSON. The compaction image establishes
the `/compact` bubble and muted separator with an inward-arrow icon and exact
before/after label.

Source was inspected at T3 Code revision
[`134b7194b125dd4881ff6040f66997b23489b72e`](https://github.com/pingdotgg/t3code/tree/134b7194b125dd4881ff6040f66997b23489b72e):

- [Desktop snapshot coordinator and native helpers](https://github.com/pingdotgg/t3code/tree/134b7194b125dd4881ff6040f66997b23489b72e/apps/desktop/src/snapShot).
- [Snapshot attachment details](https://github.com/pingdotgg/t3code/blob/134b7194b125dd4881ff6040f66997b23489b72e/apps/web/src/components/chat/SnapShotAttachmentDetails.tsx).
- [ContextCompactionTimelineRow](https://github.com/pingdotgg/t3code/blob/134b7194b125dd4881ff6040f66997b23489b72e/apps/web/src/components/chat/MessagesTimeline.tsx).
- Initial native capture change
  [`299404a754f52c02c69634528d8856b3c93b378c`](https://github.com/pingdotgg/t3code/commit/299404a754f52c02c69634528d8856b3c93b378c)
  and compaction change
  [`c5ba51d629b3813182cf3e161cc3f23b1e541dc3`](https://github.com/pingdotgg/t3code/commit/c5ba51d629b3813182cf3e161cc3f23b1e541dc3).

Inertia currently uses the pinned native packages (`@crowecawcaw/xa11y` 0.15.0 and
`ffi-rs` 1.3.7), included in generated third-party notices and native/package
verification. The UI follows the compact preview and separator treatment using
Inertia's existing attachment modal, composer, timeline and focus rules. Arrival
uses a short composer animation that is disabled under reduced motion. Desktop
flight overlays, capture sound and native application icons are not included.

## Verification boundaries

Focused tests cover protected pixel masking, accessibility limits, foreground
changes, capture ownership/cancellation/timeouts, trusted attachment resolution,
provider context, receipt persistence and restart, and renderer focus/adoption.
Electron scenarios exercise real import leases, PNG validation, native IPC,
preview, keyboard focus, compact geometry, reduced motion, receipt reload, and
loading the actual native bindings in a utility process. Visual scenarios use
synthetic Notes content; they do not claim to capture a permission-protected OS
desktop. Package smoke also loads the shipped bindings without desktop access.
Interactive permission grants and real foreground capture were not exercised on
the locked macOS host. Windows/Linux capture also requires manual platform
validation, including overlapping windows, mixed-DPI monitors and partially
off-screen targets. Deterministic tests do not substitute for this physical
validation or prove complete screen redaction.

Reviewed Electron captures from synthetic Notes content:
[dark](screenshots/inertia-snapshots-compaction-dark.png),
[light](screenshots/inertia-snapshots-compaction-light.png),
[compact](screenshots/inertia-snapshots-compaction-compact.png), and
[accessibility preview](screenshots/inertia-snapshot-accessibility.png).

The measured macOS ARM64 renderer footprint is 738.3 KiB for the workbench,
565.1 KiB for detached chat, and 1,985.9 KiB for shared core. The snapshot setup
and attachment preview remain deferred; their measured additions have explicit
budgets with less than 2 KiB of headroom. Other bundle limits are unchanged.

Snapshot settings after disable revocation and masking-copy corrections:
[dark](screenshots/inertia-snapshot-settings-privacy-dark.png) ·
[light](screenshots/inertia-snapshot-settings-privacy-light.png).
These Electron captures use the controlled desktop fixture at source
`6ddedecdf0b62d79322aff70503ef90b0dda0c07`; both native UI scenarios passed.
They show the point-of-use wording, not permission-protected screen-redaction proof.
