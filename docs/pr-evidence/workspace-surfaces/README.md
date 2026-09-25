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
