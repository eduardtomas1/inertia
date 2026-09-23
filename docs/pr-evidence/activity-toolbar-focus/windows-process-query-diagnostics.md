# Windows install-root query evidence

This is a diagnostic follow-up, not a proven fix for Windows process discovery.

## Observed failure

At PR head `c1ceb4e4b37006c41ac87e77903ba4191266d7c4`, [Windows x64 job 107064228955](https://github.com/eduardtomas1/inertia/actions/runs/35824739433/job/107064228955) passed the installed N-1 package smoke: ready 2,672 ms, shutdown 169 ms, post-exit cleanup 2 ms, with PDF/image/history persistence checks. Its following install-root process query timed out. The original `BoundedProcessTimeoutError` confirmed termination of the complete query process tree and retained only `#< CLIXML` from the child output.

The named `performance-windows-x64` artifact contains the successful package report, not query-phase evidence. The header does not identify PowerShell initialization, module loading, CIM enumeration, or per-process path resolution. The approximately 56.5-second gap includes work outside the query timer, including bounded process admission/cleanup and installer-smoke cleanup; it is not proof that the query alone exceeded its 30-second budget or that the N-1 application remained alive. A connection to the separate installer-guard timeout is unproven.

## Narrow instrumentation

Only this smoke query writes progress markers to stderr. The existing bounded runner already preserves stderr in timeout errors and excludes it from successful stdout, so no new collector, parser, process hook, or reporting framework is added.

The marker is `INERTIA_INSTALL_ROOT_PHASE|phase|elapsedMs|rows|paths`. Phases are fixed literals; elapsed time is capped at 60,000 ms and counters at 1,000,000. No paths, PIDs, process names, environment values, command text, or error details are added. There are at most 17 short markers (less than 2 KiB):

- Script entry, canonical module-path setup, install-root lookup start/verification, CIM start and its first yielded row.
- Start and complete/rejected path resolution at nonempty-path counts 1, 16, 64, and 256; a coverage-limit marker at 257.
- Completed enumeration and completed JSON output.

The query retains its streaming `Get-CimInstance | ForEach-Object` pipeline. Every original `Get-Item`, reparse-point rejection, case-insensitive containment check, failure, process result, stdout schema, and trusted PowerShell selection remains unchanged. Diagnostic writes are caught locally. Query/admission/settlement deadlines and process-tree ownership are unchanged. The installed NSIS guard and workflows are untouched.

Interpretation remains bounded: no marker cannot distinguish admission from PowerShell startup, and work between checkpoints or after 256 paths can still leave CIM versus path-resolution uncertainty. `json-written` before a runner failure would place that failure after JSON production. Markers share the runner's existing 16 KiB diagnostic tail; unrelated later child output can evict earlier markers. None of these markers establishes a root cause by itself.

## Verification

Two real child-process controls use the unchanged bounded runner: one emits phase markers beside a CLIXML header and stalls, proving the original timeout error retains them and confirms cleanup; the other emits phase stderr with valid process JSON, proving stdout still parses unchanged. These test actual output transport, not just source strings.

The focused installer-smoke suite passed locally: 22 tests, with the native Windows process-boundary case skipped (8.33 seconds). Both new transport controls allow five seconds for cold Node startup; this changes no production budget. That existing native case continues to exercise the instrumented query and exact install-root/sibling boundary on Windows.

Final Node 22.23.2 `npm run check` passed: 9,692 tests across 899 files, plus seven subprocess tests; 146 platform tests and 16 files skipped. All lint, type, architecture, migration, build, and bundle gates passed, with core JavaScript unchanged at 2,086.9 / 2,088.8 KiB. No additional native suite was repeated for this Windows-script-only follow-up. Native Windows PowerShell 5 syntax/CIM execution is unavailable on the local macOS ARM host; no such validation is claimed.

This follow-up was validated on the PR's existing base `be12f1e28ba784b62f2b3ca149519c99a8d34deb`. Main subsequently advanced to `558395da97498dd06201d7e5802b446272afd56c`; that integration is not included in these results. No discovery optimization or product/installer behavior fix is claimed.
