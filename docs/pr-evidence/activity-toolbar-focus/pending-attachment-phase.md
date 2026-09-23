# Main Windows pending-attachment correction

This separable follow-up corrects observation of a transient pending attachment
in the native fixture. It is based on reviewed main `558395da` and PR integration
`a0e20dbd`; it makes no production or import-authority change.

## Main's missed pending phase

[Main Windows x64 job 107071621246](https://github.com/eduardtomas1/inertia/actions/runs/35827187837/job/107071621246)
successfully pasted an image in `sent-attachments.spec.ts`. The paste evaluation
ended at 52,096.956 ms. The subsequent name-visibility assertion ran from
52,097.661 to 57,080.046 ms; only afterward did the pending-state assertion
begin, at 57,080.901 ms. It failed at its original 30-second deadline. Later
ARIA context shows a normal preview/remove control. The trace contains test
API calls, source and earlier screenshots, not a renderer timeline; it cannot
establish when the pending phase existed.

The fixture uses 750 ms import-validation and commit-response delays. A temporary
five-second delay in the test runner before the original pending assertion
reproduced its exact missing-pending failure in native Electron. The change
arms a scenario-local MutationObserver before paste and retains the first
matching pending row's visible geometry and image count. The original
requirements become one atomic assertion on that observed state: visible,
with zero images. The observer disconnects after capture and is disposed in
`finally`. No global state, repeating timer, production hook, or commit gate
is added. The subsequent name, settled image, pending removal, preview content,
tamper/identity, cleanup, runtime-crash and restart assertions remain intact.

With the same temporary five-second delay before reading the observation, the
entire native scenario passed in 24.9 seconds. Separate real-import native
negative controls passed in 10.6 seconds:

| Controlled pending state | Captured result | Satisfies assertion |
| --- | --- | --- |
| Visible, no image; read after commit | `visible: true, imageCount: 0` | Yes |
| Premature image injected before observation | `visible: true, imageCount: 1` | No |
| Pending row hidden before observation | `visible: false, imageCount: 0` | No |
| Pending attribute removed before observation | `null` | No |

The temporary delay and negative-control spec were removed. The committed
scenario retains both 750 ms fixture delays, its 75-second deadline, the
runtime-recovery project's 30-second assertions, and all existing security and
recovery checks. The negative controls prove the recorder does not convert a
missing or unsafe pending state into a pass.

## Validation and scope

On Node 22.23.2 / Electron 44.4.3 / macOS ARM64, the actual native scenario
passed with the five-second delayed-reader control (24.9 s), and passed again
without temporary controls (20.8 s). Both runs retain content/identity tamper,
secure preview, cleanup, runtime-crash and restart assertions. The separate
native negative-control run passed in 10.6 s. No arbitrary delay or gate is
present in the committed source. The helper is serialized into Electron's
renderer, holds one scalar snapshot, and creates no repeating timer.

Files: `tests/e2e/sent-attachments.spec.ts`,
`tests/e2e/support/pending-attachment-observation.ts`, and this evidence report.
Logs: `/tmp/inertia-pr457-pending-before.log`,
`/tmp/inertia-pr457-pending-after.log`,
`/tmp/inertia-pr457-pending-negative-controls.log`, and
`/tmp/inertia-pr457-attachment-native-sent.log`.

The full gate for this follow-up has not run yet. A separate later-image paste
failed during the combined attachment cohort after a queued turn completed;
that secondary issue is under bounded investigation and is not attributed to
this pending-phase observation change. The final integrated full gate and
hosted evaluation remain outstanding. Native Windows and the exact hosted
scheduling were not reproduced locally. Existing timeouts, process ownership,
attachment leases, containment, security checks and cleanup remain unchanged.
