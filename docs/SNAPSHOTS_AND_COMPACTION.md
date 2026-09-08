# Snapshots and compaction receipts

Open **Snapshots** in the composer toolbar and enable capture. On macOS and
Windows, press both physical Shift keys together while another application is
foreground. You can instead select Cmd+Option+S on macOS or Ctrl+Alt+S on Windows.
Linux X11 uses Ctrl+Alt+S. The selected chat receives a removable screenshot tile
with the application and window names. Open it to inspect the image or its
accessibility data before sending. Capture does not send a message automatically.

macOS requires Accessibility and Screen Recording permission; the setup dialog
opens the relevant system settings only after an explicit click. Snapshots starts
disabled and saves the chosen setting locally. Linux requires an X11 desktop and
working AT-SPI accessibility. Wayland is reported as unavailable because reliable
foreground-window cropping is not available through the selected native backend.
Applications that omit accessibility information can provide incomplete context.

The capture worker reads the current window once. It masks editable controls and
protected fields in the image and omits their text and descendants from context.
Static content elsewhere in a window may still contain sensitive information:
review the attachment before sending it. A changed foreground identity, an
incomplete protected-field scan, changed protected-field geometry across the
screenshot, timeout, or oversized image fails the capture.
Only the two Shift modifiers are sampled for the default shortcut; no typed text
or general keyboard events are recorded. There is no continuous screen capture.

Accessibility output is limited to 512 nodes and 24 KiB, and images to 2048 pixels
on either edge and 8 MiB. Existing message and attachment budgets still apply.
Main owns capture, native workers, permissions, attachment capabilities and
cleanup. The renderer receives a validated attachment and source metadata, with
no filesystem or arbitrary native API. Native bytes are delivered only after the
capture worker exits. Sending resolves the attachment again through the trusted
main/runtime broker; renderer-supplied snapshot substitutions are ignored. The
provider receives the accessibility tree as quoted, untrusted attachment context.
Visible user text and diagnostic execution manifests exclude that content.

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

Inertia uses the same pinned native packages (`@crowecawcaw/xa11y` 0.13.0 and
`ffi-rs` 1.3.2), included in generated third-party notices and native/package
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
validation; deterministic tests do not substitute for it.

Reviewed Electron captures from synthetic Notes content:
[dark](screenshots/inertia-snapshots-compaction-dark.png),
[light](screenshots/inertia-snapshots-compaction-light.png),
[compact](screenshots/inertia-snapshots-compaction-compact.png), and
[accessibility preview](screenshots/inertia-snapshot-accessibility.png).

The measured macOS ARM64 renderer footprint is 738.3 KiB for the workbench,
565.1 KiB for detached chat, and 1,985.9 KiB for shared core. The snapshot setup
and attachment preview remain deferred; their measured additions have explicit
budgets with less than 2 KiB of headroom. Other bundle limits are unchanged.
