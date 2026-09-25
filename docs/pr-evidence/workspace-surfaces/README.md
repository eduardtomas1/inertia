# Workspace surfaces and working indicators — v0.0.63

Terminal is available in the surface launcher and add menu. Its existing four-tab
limit, split controls and workspace ownership remain intact. One retained portal
host moves the same mounted terminal panel between the dock and surface; changing
location does not recreate, detach or close its shell capabilities. Closing the
surface hides the panel; explicit terminal-tab close retains the existing native
cleanup path. The bottom toolbar reflects either visible location.

Attachments move out of Agents into their own surface. The newest 60 distinct
retained attachments remain the bound, with a truthful limit label, empty state,
viewport-loaded image originals, keyboard targets, existing ID-based previews,
focus restoration and missing-file feedback. Agents retains delegated work and
runtime warnings. No attachment paths or new privileged API cross the boundary.

Fixed orb styles now use the same scope as Classic: the Work tab and working cue.
Only Automatic can substitute icons in tool rows, reasoning steps and subagent
status marks. Switching away from Automatic leaves its saved activity preference
intact; the corresponding setting is disabled for fixed styles.

## Loading and size accounting

The terminal layout loads on first use, and the surface launcher and open tabs
share their icons. Current surfaces no longer construct unused legacy Environment
projections. The existing full projection and its regression tests remain
available, while its unused helpers are removed from the production initial
route. Visible runtime, run authority, usage, Git notice and attachment
projections share the same implementation.

This moves existing Git action helpers into their actual deferred consumers.
[Exact emitted sizes and allowance transfer](renderer-bundle.json) records the
2,900-byte transfer from the overlapping startup/core ceilings into deferred Git
closures. Their combined allowance does not grow. No test deadline, worker count,
retry policy, assertion, terminal limit, thumbnail bound, package check, checksum
or provenance gate was reduced.

## Verification

Local validation uses Node 22.23.2 on macOS ARM64. Focused DOM coverage exercises
real terminal panel ownership under Strict Mode, retained shell IDs and selected
tabs across dock/surface/hide transitions, toolbar state, dedicated attachments,
and fixed versus Automatic indicators. The former terminal source-string check
is replaced by the real DOM lifetime regression.

Native coverage exercises multiple shell tabs, split sessions, persisted shell
state after reload, cross-project split ownership, keyboard navigation, responsive
layouts, live indicator settings and restart persistence. Attachment coverage
includes retained images across send/restart, missing previews, gallery scrolling,
and keyboard access to a 40-megapixel image while offscreen originals stay
unloaded.

The frozen product/unit inputs passed `check:quality`, the complete unit suite
with the CI two-worker limit (9,995 tests plus seven child-process controls;
146 skips across 933 passing and 16 skipped files, 437.98 seconds), and a fresh
bundle build. After the gallery CSS correction below, quality and build passed
again; product/unit JavaScript remained unchanged.

The terminal/layout/indicator native cohort passed all 15 scenarios with the
original two workers and zero retries (20.2 seconds). The display cohort passed
the gallery/40-megapixel, split ownership and recent-attachment scenarios; its
sequential image case exposed the readiness issue below. The final two image scenarios passed three consecutive executions each at the
original single worker and zero retries (six passes, 1.7 minutes). The unchanged
provider-terminal resume scenario passed in 4.6 seconds. The complete desktop
benchmark passed at its original sample counts, worker policy and budgets in
1.6 minutes.

Two failures were investigated locally before publication:

- A real gallery-height assertion found the old Environment selector still
  imposing a 340px maximum (429px unused height). The dedicated Attachments
  selector now overrides that limit. The unchanged scroll/viewport assertions
  and the new available-height check passed after correction.
- Sequential image imports could start while the previous turn was still
  finishing. In a bounded instrumented native control, import entry was
  unblocked; on return from the native lease, the same conversation, turn and
  harness had changed only from running to idle. The existing ownership guard
  correctly cancelled it. Both sequential tests now wait for the real composer's
  `aria-busy=false` and enabled attachment action before importing. No production
  ownership code changed. The earlier uninstrumented drop failure did not
  capture its exact key transition, so the same cause is not asserted for it.

Temporary product instrumentation and its artifacts are kept only outside the
repository; the two instrumented product files were restored byte-for-byte.
Independent source review found no remaining issue in the surfaces, indicator
scope or final readiness assertions. Public release notes retain both the full
0.0.62 highlights and the new 0.0.63 fixes, as requested.
Other native operating systems and architectures require hosted CI; local macOS
results are not a substitute for those checks.

## Per-chat panels and composer context follow-up

New chats now start with a closed panel. Existing chats keep their saved surfaces,
selection and open/closed state, including the legacy per-chat storage migration.
The global startup preference and last-tool replay no longer seed unrelated
chats, and project import no longer reapplies that preference. Settings describes
the per-chat behavior; persisted server contracts remain compatible.

Chat reference cards, their preview and the agent context request now live in the
composer's padded input zone. A zero-minimum grid track and bounded flex cards let
long titles shrink while keeping preview/remove controls accessible. Native
coverage uses a long chat title, enlarged zoom and the narrow chat beside an open
right panel, in addition to snapshot and regular attachment coverage.

The new panel expectations failed before the correction (a new chat inherited
Changes). A native inset assertion also failed before the layout change; the
initial diagnostic selector was corrected from a nonexistent form ancestor to
the actual composer before recording that geometric failure. Focused DOM tests
passed 47 cases; the six composer/context/snapshot native scenarios passed in
21.6 seconds, followed by the extended narrow-context and responsive-panel checks
(two passes, 9.6 seconds). Original project worker policies and zero retries were
retained. The retained context captures were visually inspected. The 125% claim is based
on measured viewport/containment assertions; its PNG does not show the complete
outer composer at the image boundary.

The first published PR head's Windows shard 3 failed the provider-refresh
shutdown authority test with an owned-resource cleanup deadline. Source review
found that its synthetic refresh gate was released before close, allowing real
host provider discovery to start in teardown. The fixture now proves a real
settings command is accepted after the update blocker, then begins close before
releasing the gate, and awaits cleanup. No runtime implementation or deadline
changed. A temporary controlled provider detector proved that the old ordering
entered discovery and the corrected ordering did not (two controls, plus all
seven authority cases passed). That control was removed. This demonstrates the
fixture boundary defect; the retained hosted log does not identify the slow
cleanup owner, so no exact hosted root-cause claim is made.

The final frozen follow-up passed quality, the complete two-worker Node 22 suite
(9,995 tests plus seven child-process controls; 146 skips, 933 passing files and
16 skipped files, 416.30 seconds), and a fresh bundle build under the same caps.
All 48 source/test/script blobs were checked against the reviewed manifest.
The earlier terminal, gallery, image-send and desktop benchmark evidence above
records validation of the original three fixes. The follow-up uses the focused
and full gates reported here; the complete desktop benchmark was not repeated
after the per-chat change. Hosted Windows, Linux and Intel macOS must still pass
on the final published revision.

### Hosted macOS follow-up

The same first PR run later failed two macOS ARM64 isolated cases. The terminal
helper observed a missing dock after reload and clicked a toggle; it now reads
the toolbar's retained open state before deciding whether to click, and still
requires the dock to become visible. A temporary native visibility-gap control
proved the old helper could close an already-open terminal and the corrected
helper preserved it (one pass, 2.7 seconds). The hosted trace lacks the DOM state
at the click, so it does not prove the precise historical lazy-import sequence.
Attempts to hold the generated import did not establish their intended gate and
are excluded from causal evidence; temporary controls were removed and the build
restored before final native validation.

The separate composer scenario passed its functional assertions, then stalled
with Private Connect cleanup pending after the runtime stopped. The main inspector
was responsive; no native stack was captured. This precedes prepared/native exit
and is not attributed to the earlier exit-return stall. Independent source review
found no demonstrated Private Connect defect to patch. Its 102 focused shutdown
and service tests passed with unchanged limits; the hosted cause remains unknown.


### Draft materialization and final panel contract

The complete local isolated phase caught two remaining old-contract assumptions:
a freshly imported draft expected the global startup preference to open tools,
and the layout test expected a global last-tool write. The corrected checks
require the new default to be closed and validate scoped persistence instead.
Once explicitly opened, the draft then exposed a real identity transition bug:
its panel choice was lost when the first message created a saved conversation.

The confirmed, still-owned draft creation now hands off only its explicitly
stored panel state from that exact draft ID to the saved conversation ID. It
neither copies another chat/global preference nor replaces an existing target or
moves terminal ownership. Storage failures cannot interrupt message creation.
The layout switches to the saved identity immediately, including a failed first
send, so later edits and recovered retries use the same saved state. A composed
DOM regression changes and closes the panel after a not-sent failure, remounts,
retries, reconciles the conversation and reopens the latest selected surface.

Native coverage explicitly selects Usage before sending and requires it to remain
selected after materialization, then verifies Files becomes available. The layout
case also reloads while closed and reopens the saved Files selection. Early
phase-callback code was rejected during review for storage-error propagation and
stale retry state, replaced before publication with this identity-based handoff.
The interrupted intermediate full run is not claimed as final validation.

The final identity-based source passed quality, 49 focused DOM cases, all seven
native draft/layout cases in 12.6 seconds, and a fresh bundle build. Its complete
Node 22 suite passed 10,001 tests plus seven child-process controls, with 146
skips (933 passing and 16 skipped files) in 419.34 seconds at two workers.
All 51 source/test/script blobs match the final independently reviewed manifest.

The complete final isolated Electron phase then passed 102 cases with the three
platform-specific skips in 3.3 minutes, at the original two workers and zero
retries. This includes the hosted-failed composer cleanup and terminal reload
scenarios, with no claim that local success identifies the historical hosted
Private Connect stall.

The final six display-sensitive composer/context/snapshot cases also passed in
22.7 seconds on that same source, with the original one worker and zero retries.
The initial command used an incorrect project selector and ran no tests; the
reported result comes from the configured display-sensitive project.
