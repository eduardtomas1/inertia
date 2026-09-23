# Completed-answer input diagnostics

This follow-up adds evidence for an unresolved hosted failure, not a proven product fix.

The validation below is historical, at `c1ceb4e4` on base `be12f1e2`. See
[the subsequent reviewed-main integration](main-integration.md) for current
integrated results; the hosted cause remains unresolved.

## Failure and limits

On PR head `9846a22195d65fd521966ce48271cdef9742f070`, [macOS ARM job 107050957549](https://github.com/eduardtomas1/inertia/actions/runs/35820397561/job/107050957549) failed the completed-answer scenario after Fill returned and Send initially resolved disabled. Click then exhausted its unchanged 30-second actionability deadline. The artifact contains a test call trace, but no renderer trace, DOM snapshot, or screenshot. It cannot distinguish a lost draft or admission gate from a renderer that stopped responding after that initial resolution.

The runtime remained ready with no turn started. Privileged cleanup completed in roughly 58 ms. The quit request returned, followed by `window-destroy-entered`, without `window-destroy-returned` or `process-exit-called`. The fixture force-stopped the main process after its existing five-second quit window. The native sample timed out during symbol processing without stack frames. These observations locate the teardown stall within window destruction, including synchronous callbacks, but do not identify its cause or prove a shared cause with the body failure.

The hosted merge `d7bd11df25cbf0b63b1101d146628aa9224c7f64` has tree `529474ed479ab47a3408327ea73413f6a854c697`, identical to the PR head. An unchanged local run passed both transcript cases; a two-worker control with the neighboring window-health/sidebar specs also passed. These bounded passes do not resolve the hosted failure.

## Scenario-owned evidence

Only the completed-answer scenario installs the observer. It retains at most eight input/change events with bounded counters and records:

- Value length and equality to the known fixture request, never raw draft text.
- Input presence, identity, connection, focus, and disabled state.
- Existing composer/Send busy and action state, route-readiness flags/repair code, and connection state. String fields use fixed allowlists; readiness prose and DOM text are omitted.

The pre-fill read is bounded at 500 ms. The post-fill read starts without awaiting it before the original Click. On failure, a concurrent state read and animation-frame heartbeat each have a 500 ms outer bound; the heartbeat reports frame/no-frame within a 100 ms renderer timer when the renderer is responsive. Failure attachments are bounded at 250 ms. Rejection or timeout is recorded as an outcome without error details. Disposal does not wait for the renderer before fixture cleanup. The observer retains no repeating timer and removes its input/change listeners on disposal or replacement.

The original Fill, Click, success assertions, timeouts, and cleanup failure aggregation remain intact. No refill, click retry, frame wait before Click, production test API, global tracing, workflow change, or GPU/shutdown change is included. A captured heartbeat only describes the diagnostic interval after failure; it does not prove the renderer stayed responsive throughout the preceding click.

## Native sampling control

Local `sample` help/man documents `-mayDie` as reading symbol locations before sampling; it does not document a mode that skips symbolication. An actual owned Electron 44.4.3 main process was sampled using the existing helper, two-second cap, 128 KiB output cap, and sampler-group cleanup:

- Existing mode completed with a main-thread call graph, observed by 1,861 ms; output reached the existing cap.
- `-mayDie` timed out at the unchanged cap, observed at 2,039 ms, with 85 bytes and no call graph.

The first temporary comparison probe missed the second mode's timeout transition because its polling cadence exceeded the remaining observation window. A mode-only control with 50 ms polling captured that timeout; the sampler deadline was never changed. The temporary probe was removed. There is no demonstrated sampling improvement to include, so the existing owned-process diagnostics remain unchanged. No renderer-process sampler was added; the existing helper retains the launch-owned main PID. Local macOS 26 behavior does not certify useful symbolication on the hosted macOS 15 stall.

The same native control verified the actual serialized input observer: pre-fill empty/disabled, one input event, post-fill matching value/send-ready, a captured frame, and no raw fixture text in the report.

## Validation

Eight cheap tests across two files passed, covering bounded rings, field redaction/allowlists, unrelated events, input replacement, listener disposal, frame/no-frame cleanup, a pending post-fill read, and rejected/hung evaluation or reporting preserving the original body error and reaching cleanup.

Final Node 22.23.2 / macOS ARM64 verification:

- `npm run check`: passed; 9,690 tests across 899 files, plus seven subprocess tests; 146 platform tests and 16 files skipped. Lint, all typechecks, architecture, migrations, and build/bundle gates passed. Core JavaScript remains 2,086.9 / 2,088.8 KiB.
- Native transcript, window-health-recovery, and work-sidebar specs: five passed with two workers in 22.2 seconds, including the unchanged completed-answer assertions and clean teardown.
- Actual Electron observer serialization/redaction/heartbeat control passed as described above. Sampler comparison established no improvement; its expected timeout is documented separately from the final passing scenario run.

No provider protocol, production, packaging, or workflow change was made in this diagnostic follow-up. Native Intel/Windows/Linux, live providers, and reproduction under the full hosted workload were not exercised. The hosted cause remains unresolved and requires the next failure's new renderer evidence; native stack collection remains subject to the existing bounded sampler limitation.
