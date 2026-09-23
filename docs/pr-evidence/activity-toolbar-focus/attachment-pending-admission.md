# Pending attachment observations and import availability

This follow-up addresses two independently demonstrated timing boundaries on
top of reviewed main `558395da` and integrated PR head `a0e20dbd`. The saved
hosted artifacts do not establish the exact renderer scheduling or import
guard state at either failure.

This admission correction is a local integration candidate for the combined
PR. The coordinator owns all remote changes, CI and merge decisions. The
combined source has not yet completed its focused/native/full verification.

## Main's missed pending phase

The independently proven main Windows fixture correction is recorded in
[pending-attachment-phase.md](pending-attachment-phase.md) as a separable change.
It preserves the visible/no-preview pending assertion using an observation
armed before paste, without changing production or fixture delays.

## Attach availability during a pending send

[Windows ARM job 107068548473](https://github.com/eduardtomas1/inertia/actions/runs/35826198046/job/107068548473)
failed two later synthetic pastes: one after starting a held turn and one in
the third repeated-send attempt. Earlier images/digests passed; the runtime
stayed ready and cleanup completed. Later enabled Attach controls do not
prove their state at paste, and no renderer trace captured the guard values.

Source inspection and two actual Composer DOM controls establish a separate
availability bug. Import actions reject local `submitting`, external `sending`,
disabled state, and a concurrent attachment import. Attach instead inferred
submission from the primary action; that action prioritizes Stop while a turn
is running. Thus Attach could be enabled while picker and paste were correctly
blocked. Both controls failed before the change at the enabled Attach button:
an unresolved initial send followed by a running transition with external
`sending` still true, and an unresolved active follow-up with local
`submitting` still true.

Composer now supplies Attach's disabled state directly from those existing
four states. The toolbar retains its count and media-kind restrictions. Stop,
other toolbar controls, import/lease authority, and the original submission
latch are unchanged. Both DOM controls pass, also proving import and exact
lease commit resume after settlement. The repeated-send scenario waits for
the matching Attach affordance before each of its three pastes. The existing
queued/steered/later follow-up scenario already waits at that boundary and
keeps its digest and queue assertions.

The sole Toolbar caller is Composer. Main, detached, and split chats all use
ChatWorkspace/Composer and their existing sending projections. Read-only
inspection of #448's integrated toolbar confirms the same caller/guards;
none of its unmerged code is copied.

A native control reused the existing bounded WebSocket acknowledgement fixture
to hold a real `message.send` reply while the turn was already running. The
previous build kept Attach enabled for the entire 15-second assertion. The
fixed build kept it disabled, then the existing `pasteImages` wait proceeded
after acknowledgement release. The entire storage-full, steered, queued, and
later-image scenario passed (17.8 seconds). The temporary gate was released in
`finally` and removed from the final fixture; no production transport or test
timeout changed. Logs: `/tmp/inertia-pr457-admission-native-{before,after}.log`.

## Separate later-paste counterexample remains under investigation

The final native image/toolbar cohort passed repeated-send, native clipboard/
drop/picker plus restart, and toolbar navigation, but failed the last paste in
the image follow-up scenario, after its queued-image digest and queue removal
had passed. The Attach assertion ended at 15,982.827 ms; the separate paste
evaluation ran from 15,983.121 to 15,991.067 ms. No attachment then appeared.
The saved trace has no import-guard or lease observation at dispatch. An
earlier enabled affordance cannot guarantee the state at a later asynchronous
runner call or authority through import/commit. This failure is not attributed
to the main pending-phase fixture or claimed fixed by the availability change.

Queue dispatch does not update Composer's submission ref. App.tsx overrides
the scene builder's legacy busy-action projection with the per-conversation
sending set, so main, split and detached use that set. Neither fact justifies
a further source change. Import leases must still retain conversation,
running, turn and harness authority; these checks remain unchanged.

Trace/source snapshot: `/tmp/inertia-pr457-later-paste-failure`. The attempted
temporary production diagnostic build exceeded the unchanged detached bundle
cap (619.2 / 618.8 KiB), so its native replay never started. Its instrumentation
was removed; no cap was changed. The generated output must be rebuilt before
another native run. The current candidate is a temporary test-local observer,
which avoids a production/build change and can record delivery/import phases;
it cannot independently identify a private guard or authority rejection.

## Local validation before combined integration

Node 22.23.2 / Electron 44.4.3 / macOS ARM64:

- Focused composer/ownership/attachment checks: 136 tests across nine files
  passed (3.10 seconds).
- Native controlled acknowledgement: passed as above. Secure-attachments final
  scenario passed (20.8 s); image/toolbar cohort: three passed, one later-paste
  failure as documented above.
- Combined final `npm run check`: pending. The admission follow-up's separate
  full gate was not started after the later-paste counterexample; its existing
  focused/control results are not presented as combined validation.

This admission commit contains six files: `Composer.tsx`,
`ComposerToolbar.tsx`, `composer-lifecycle.dom.test.tsx`,
`image-send-regression.spec.ts`, this report, and the historical cross-link in
`main-integration.md`. The pending-phase correction remains a separate commit.
No temporary native observer or control is included in this unit.

Control logs are `/tmp/inertia-pr457-pending-{before,after,negative-controls}.log`
and `/tmp/inertia-pr457-admission-{before,after}.log`. Final logs use
`/tmp/inertia-pr457-attachment-*.log`. The earlier integration, package,
renderer-diagnostic and Windows-query results remain historical in
[the integration report](main-integration.md).

Native Windows/PowerShell, Intel Mac, Linux, signed packages, live providers,
and the full hosted workload were not exercised locally. These controls prove
the identified source/test mechanisms; they do not prove exact hosted causes.
The earlier Intel DMG, ARM Send/window-destruction, and Windows process-query
failures remain unresolved. No deadline, budget, ownership, containment,
workflow, provider protocol, or packaging change is included. CI evaluation
and any evidence-driven rerun remain the coordinator's responsibility.
