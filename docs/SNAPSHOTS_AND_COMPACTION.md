# Snapshots and compaction receipts

## Protected snapshots

Snapshots is experimental. Open **Settings → Devices & integrations → Snapshots** and turn on **Window snapshots**. Return to your chat and focus its message box before switching to the window you want to share. On macOS and
Windows, press both physical Shift keys together while another application is
foreground. You can instead select Cmd+Option+S on macOS or Ctrl+Alt+S on Windows.
Linux X11 uses Ctrl+Alt+S. The selected chat receives a removable screenshot tile
with the application and window names. Open it to inspect the image or its
accessibility data before sending. Capture does not send a message automatically.

A shortcut press is never dropped silently. If no chat message box is open (for
example while Settings is showing, or after the chat window closed), the capture
is kept as a pending snapshot and Inertia comes forward with the selected chat,
or starts a new chat when neither a chat nor a new-chat draft exists; the first
chat whose message box binds receives every pending snapshot, oldest first. If
the macOS main window was closed while Inertia kept running, it is opened again;
a notice from that moment is shown once the reopened window's message box binds. Pressing the shortcut while
another capture is still running shows a notice in the main window instead of
starting a second capture, and a failed capture with no open chat is reported
the same way. The notice uses the main window's existing status notice and does
not move focus while the running capture is still checking the foreground window.

Pending snapshots are stored in a private `snapshot-queue` folder inside
Inertia's application data (folder `0700`, files `0600`, created exclusively and
never followed through links: each file is checked with `lstat` and `realpath`
before it is opened and must be the same file after opening, which also refuses
symbolic links and junctions on Windows, where `O_NOFOLLOW` does not exist). On macOS that is
under `~/Library/Application Support` (`Inertia` for the stable build), which
Time Machine backs up, so a
snapshot that is pending while a backup runs can be copied into it. The `0700`
and `0600` modes are POSIX permissions; on Windows the files are protected only
by the per-user profile folder's access control list. The folder must resolve
inside the real application-data path, or the capture fails. At most four
snapshots wait at a time; a press beyond that takes no pixels and says why. Each
one is deleted when its own ten minutes from capture end, whether or not a chat
opened. Quitting Inertia deletes the folder, and so does turning Snapshots off
(before the setting is acknowledged); a launch removes anything a crash left
behind. A pending snapshot that fails to
import is reported once in the chat that received it and then deleted, so it
cannot reappear on every focus; one whose chat closes before delivery stays
pending for the next chat.

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
information. On macOS the worker matches the accessibility window to exactly one
window-server window by process, bounds (within one point) and, when macOS
reports it, title, then runs `/usr/sbin/screencapture -l <window> -o -x` without
a shell, with an empty environment, in its own process group and with a
three-second limit. The unmasked image is written to a folder that the main
process creates for each capture under `snapshot-capture` in application data
and deletes when the worker exits, however it exits; the worker kills the whole
`screencapture` process group when it is stopped or exits, and a launch deletes
any capture folder a crash left behind. The image therefore holds only that window, without its shadow or any
window overlapping it. The window number is part of the before/after identity,
so a different window matching after the screenshot discards the pixels. Masks
are mapped from accessibility points onto the image's pixels, including Retina
images at two or more pixels per point and windows on displays left of or above
the main display. No match, more than one match, or an image that is
not within one pixel of the window frame at one shared scale on both axes fails
the capture instead of guessing where masks belong. On Windows and Linux the
[backend captures pixels under the window bounds](https://xa11y.dev/guides/screenshots/),
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
Window matching reads the real macOS window list (numbers, owners, layers and
bounds) and reads a real CoreFoundation string through the title path in unit
tests on macOS hosts. Interactive permission grants and real foreground capture were not exercised on
the locked macOS host. Windows/Linux capture also requires manual platform
validation, including overlapping windows, mixed-DPI monitors and partially
off-screen targets. Deterministic tests do not substitute for this physical
validation or prove complete screen redaction.

### Owner verification on a signed macOS build

Nobody has yet granted permissions to a signed Inertia build and taken a real
snapshot. The capture runs in an Electron utility process (the `Inertia Helper`
executable), not in the Inertia executable that macOS lists in Accessibility and
Screen Recording. T3 Code found that the helper does not share the Accessibility
grant and forks its accessibility reader from the main executable with
`ELECTRON_RUN_AS_NODE`. Inertia cannot do that: its packaged build turns off
Electron's `RunAsNode` fuse, and the release checks require it to stay off.
Instead, a denial is detected at run time: when the helper reports a permission
denial while macOS reports Inertia as allowed for both permissions, the chat
shows "macOS lists Inertia as allowed in Accessibility and Screen Recording, but
denied access to its snapshot helper" and Diagnostics records the category
`helper-permission-denied`.

On a signed and notarized build:

1. Turn on Window snapshots, allow Inertia in Accessibility and Screen Recording
   when asked, and quit and reopen Inertia.
2. Focus a chat, switch to TextEdit with a document open, and press both Shift
   keys.
3. Expected: a tile with TextEdit's window only. Place another window partly
   over TextEdit and repeat: the tile must not show the covering window.
   Type into a TextEdit find field or a Safari password field and repeat: the
   field must be masked.
4. If nothing arrives, open Settings → Help → Diagnostics. A
   `snapshot.failure` with category `helper-permission-denied` means the grant
   does not reach the helper. Then the choice is between running the
   accessibility read and capture in the main process (no separate process to
   kill on a hang or a native crash) and turning `RunAsNode` back on (weaker
   packaged-app hardening); neither is done without that decision. A category
   `permission-denied` means macOS itself reports Inertia as not allowed. A
   `native-failure` in phase `screenshot`, or a tile that arrives blank or shows
   only the desktop, means Screen Recording does not reach `screencapture`
   started by the helper.
5. Also check whether macOS asks for Screen Recording again for
   `screencapture`. It is started by the helper, so it should be attributed to
   Inertia; a prompt naming another program is a finding to report.
6. Open Settings, press both Shift keys in TextEdit, and confirm Inertia comes
   forward with the selected chat holding the tile. Press twice quickly and
   confirm the second press shows the notice instead of a second capture.

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
