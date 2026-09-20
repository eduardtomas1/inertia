# Windows/native correctness audit — wave 1

Baseline: `d56f972b32fadfa29169bb8390401f5ca49e419b`, branch `codex/full-correctness-audit`. Local host macOS ARM64, Node 22.23.2. No native Windows execution was performed locally. No releases, native benchmarks, E2E runs, Docker/Colima changes, or edits to sibling worktrees.

## Confirmed defect and fix

**P2 — synchronous journal failure escapes an unexpected utility exit.** `RuntimeSupervisor.handleDrainedExit` invoked `recoverOwnedProcesses` outside a try/catch in its unexpected-exit path. The default recovery constructs `RuntimeOwnedProcessJournal`, whose `pinDirectRuntimeJournalRoot` synchronously throws on an unavailable/unsafe directory. This exception escaped the UtilityProcess exit handler (or became an unhandled rejection after secure-file drain), instead of retaining a stopped safety-locked generation. Pending stop/recycle operations also did not settle correctly.

Fix commit: `fb4e5e0c fix: retain runtime cleanup authority when recovery throws`. Changed only `src/main/runtime-supervisor.ts` and `tests/main/runtime-supervisor-lifecycle.test.ts`. The catch disables replacement admission and uses the existing unconfirmed-cleanup settlement path. It preserves the generation lease, process session, ownership evidence, and pending stop/recycle outcomes. Native receipts, containment, timeouts, identity checks, and successful recovery policy are unchanged.

Failing-before evidence: three new cases failed before the change, including a real temporary directory rename causing default recovery `ENOENT`, and injected synchronous failures during stop/recycle. The real-filesystem test checks journal/session preservation after the same directory is restored. After fix, focused lifecycle/recovery suites passed. The new tests are marked portable through the containing suite.

## Coverage map and inspection depth

This maps the owned surfaces actually inspected. A group marked targeted was reviewed by lifecycle entry points, important transitions/authority checks, call sites and tests; it is not a claim that every line in the group received independent deep review.

| Surface | Inspected implementation | Evidence/depth |
| --- | --- | --- |
| Runtime lifecycle | `runtime-supervisor.ts`, `runtime-supervisor-{connection,process-record,process-safety,recycle,startup-recovery,stop-recovery,values,types,snapshot}.ts`, `runtime-process-containment-admission.ts`, `runtime-windows-job-bootstrap.ts` | Full lifecycle trace: constructor/start, async containment, readiness, request routing, invalid messages, unexpected exit, graceful/forced stop, quarantine, restart budgets, recycle. Confirmed defect above. |
| Recovery and persistent ownership | `runtime-owned-process-recovery.ts`; `runtime-owned-processes.ts`; `runtime-owned-process-{active,journal,record,session-journal,taint,invocation,posix,darwin,darwin-stop,linux,linux-stop,diagnostic}.ts`; `direct-runtime-journal.ts`; generation cleanup/lease call sites | Targeted authority and race review: journal begin/claim/release, session fencing, registry taint, async guardian admission, exact PID birth identity, Windows named-job recovery, retained failed cleanup. Full read of spawn child/PTY ownership and recovery entry points; journal/OS helpers targeted. |
| Windows native containment | `windows-runtime-job.ts`; `native/runtime-process-guardian/windows.cs`; `windows-terminal.cs`; `windows-terminal-authority.ts` | Full read of terminal helper and TypeScript broker protocol/admission/shutdown portions. Native job/update helper targeted at kill-on-close, process identity, parent/image checks, helper lifetime, job drain and receipts. Not a full independent proof of all 2,495 lines in windows.cs. |
| POSIX fallback and guardians | `runtime-process-tree.ts`, `process-lifecycle.ts`, `posix-process-tree.ts`, native Linux/Darwin guardians | Full read of process termination orchestration; targeted native census/fork/identity/stop/authorization boundaries and test inventory. Did not re-run native guardian stress scenarios locally. |
| Terminals | All `src/server/terminal*.ts`, `windows-managed-terminal.ts`, `windows-cleanup-diagnostics.ts`, `runtime-owned-pty-invocation.ts` | Full read: owner limits, reservation replacement, detached reattachment/history, output buffering, input/resize, Windows first-output resize deferral, natural exit vs stop, installation transfer/release/quarantine, deadline tightening, managed watcher receipts, complete-tree vs Darwin terminal-session boundary. Reviewed command/provider/workspace-run call sites to distinguish managed action scope. |
| Windows executable discovery | `provider/windows-codex.ts`, `environment.ts`, process launch/quote call sites and existing native discovery tests | Full known-path candidate implementation; environment/readiness/child env/executable resolution targeted. Auth parser ownership belongs to provider agent. No edits here. |
| App updates | `app-update.ts`, `app-update-install.ts`, `electron-app-updater.ts`; `windows-update-supervisor.ts`, `windows-update-terminal-receipt.ts`; `app-update-{bootstrap,handoff,startup,candidate-viability,runtime-readiness,capability}.ts` | Full service/install coordinator and Windows prepare/install flow. Targeted journal phases, exact snapshot matching, rollback token authority, helper staging, authenticated terminal receipt, restricted candidate admission, singleton transfer, Linux transaction rollback and timeout boundaries. No update/release change. |
| Linux launch/desktop | `linux-singleton-launch.ts`, `linux-singleton-metadata.ts`, `runtime-assets.ts`; index lifecycle/window wiring | Full singleton code: bounded raw-ASAR manifest read, exact owner process start identity, changed-owner refusal, bounded wait, no lock stealing; runtime asset resolution. Targeted AppImage transaction/identity source and tests. Icons deliberately left to parent. |
| Desktop integration | `index.ts` registration/window/startup/shutdown portions, `main-window-state.ts`, `window-bounds.ts`, `window-appearance.ts`, `thread-notification-activation.ts`, `external-link-open.ts`, `project-path-open.ts`, `system-boot-id.ts`, `runtime-process-environment.ts`, `privileged-shutdown.ts` | Full small modules, targeted index wiring and safe environment/boot identity. IPC/attachment/Private Connect content remains other reviewers' ownership. |
| Build/package/release | `package.json`; `scripts/build-runtime-process-guardian.mjs`, `verify-electron-fuses.mjs`, `validate-linux-package.mjs`; CI native matrix and package/installer steps; runtime asset and release test inventory | Read-only boundary review: native compiler choice, sanitized spawn env, bounded managed compiler, integrity sidecar, static Linux helper, exact fuse schema, package/installer checks. No dependency, CI-speed, icon or release implementation duplicated. |

## Rejected suspicions / preserved design

- Windows terminal resizes issued before first ConPTY output already coalesce behind output readiness, and a new resize supersedes the pending callback. Existing tests cover fast exit and stale-size replay; no new bug established.
- Managed Windows terminal cleanup already uses a private native watcher receipt plus close, and exact named nested Job identity. PTY text cannot forge cleanup; ordinary terminal/managed action scopes are intentionally distinguished. No change made.
- Windows taskkill fallback does not by itself retire uncertain owned trees; main can recover a persisted named Job when taskkill races exit. Existing native-only tree recovery tests skipped locally and are present in native CI.
- Late ordinary PTY close and installation authority are held through ownership retirement instead of treating root close alone as success. Natural exit vs signalled exit paths and release/quarantine checks were retained.
- Darwin shell replacement intentionally preserves an interactive terminal session separately from complete-tree provider ownership. No attempt to merge these authorities.
- Linux singleton contention observes exact ownership and retries the Electron lock only after release, rather than killing an older process or stealing its profile lock.
- Windows update helpers are staged outside the installation directory; authenticated terminal receipts and token-vault authority are retained after uncertain launch. No guess-based deletion/retry added.
- Provider `ComSpec`/`SYSTEMROOT` case concerns are not a confirmed production bug: Windows process environment access is case insensitive and the runtime supplies reviewed normalized keys; no speculative change.

## Local verification

- New regression failing-before: 3 failures (actual missing-directory ENOENT; synchronous failure during stop; synchronous failure during recycle).
- `npx vitest run tests/main/runtime-supervisor-lifecycle.test.ts tests/main/runtime-supervisor-windows-tree-recovery.test.ts tests/main/runtime-supervisor-stop-recovery.test.ts tests/main/runtime-supervisor-startup-recovery.test.ts tests/main/runtime-supervisor-recovery-admission.test.ts`: **57 passed, 4 skipped** (native Windows suite skipped on macOS), 5.31s.
- Focused terminal/update/native-boundary batch: **19 files passed; 348 tests passed, 16 skipped**, 9.13s. Exact files: terminal, terminal-detach, terminal-windows-resize, windows-managed-terminal, terminal-shutdown-deadline, terminal-provider-auth-lifecycle, runtime-process-tree, windows-runtime-job, windows-update-supervisor, windows-update-terminal-receipt, app-update-install, app-update, electron-app-updater, app-update-handoff, app-update-startup, app-update-bootstrap, linux-singleton-launch, linux-singleton-metadata, main-window-state.
- `npx oxlint src/main/runtime-supervisor.ts tests/main/runtime-supervisor-lifecycle.test.ts --react-plugin --report-unused-disable-directives --deny-warnings`: pass.
- `npx tsc --noEmit -p tsconfig.test.unit.json`: pass.
- `git diff --check`: pass. Runtime supervisor remains at the existing 1,250-line ceiling; no check weakened.
- Full gate and final independent diff review remain coordinating task's responsibility after all fixes land.

## Native CI evidence, exact baseline only

Run [35511703984](https://github.com/eduardtomas1/inertia/actions/runs/35511703984), head `d56f972b32fadfa29169bb8390401f5ca49e419b`, success.

- [Windows x64 job 106080718537](https://github.com/eduardtomas1/inertia/actions/runs/35511703984/job/106080718537): success; native Codex discovery/shim launching, native package creation, fuse verification, unpacked package smoke, N-1 installer upgrade/smoke/uninstall, Electron display-sensitive/isolated/destructive recovery E2E all success.
- [Windows ARM64 job 106080718488](https://github.com/eduardtomas1/inertia/actions/runs/35511703984/job/106080718488): same applicable native evidence plus ARM64 portable runtime/provider suite, success.
- Windows unit shards 1–4: jobs 106080718466 / 106080718433 / 106080718451 / 106080718449, all success.
- Linux x64 job 106080718461 and ARM64 job 106080718480: static guardian, packaged Xvfb smoke and display/isolated/recovery E2E success.
- macOS x64 job 106080718543 and ARM64 job 106080718553: package/fuses/E2E success.
- These are historical baseline checks, not native certification of audit commit fb4e5e0c. Final PR needs fresh relevant CI.

## Separate parent icon diff review (read-only)

Worktree `the separate native icon worktree`, uncommitted diff observed during audit. No edits made.

**Actionable P2 reported to coordinator:** `src/main/linux-file-icon.ts` starts a UtilityProcess without an `error` listener. Electron declares FatalError events before `exit`; an unhandled Node EventEmitter error escapes into main, defeating optional icon-worker isolation. Reproduced directly against the new source using Node22 stripTypeScriptTypes + VM with a fake UtilityProcess: `child.emit('error','FatalError',...)` throws `Unhandled error. ('FatalError')`; a subsequent exit only resolves the promise after that escape. Recommended consuming error, preserving failure result, handling postMessage failure and timer kill exceptions. Parent owns the fix.

ICO directory offsets/dimensions/generated PNG identity, Windows runtime ICO path, HICON WM_GETICON fixture, GIO native worker, XDG desktop Exec quoting and user override policy inspected. No further confirmed defect. Windows native test proves window HICONs against the ICO; separate packaged executable/installer icons and high-DPI runtime scaling still need hosted evidence. Parent already owns real Ubuntu ARM64 GDesktopAppInfo special-character launch and worker/user-override evidence.

## Remaining risks / limits

No local Windows or Linux native execution, no live external provider binaries/authentication, no RDP/fast-user-switching, unusual corporate policy/antivirus, ARM64 emulation, malformed real installers, power failure, multi-monitor/high-DPI window shell interactions, or real time-of-check mutation of native assets exercised in this wave. Deterministic tests and baseline CI reduce uncertainty but do not prove zero defects. Native Windows helper and AppImage transaction source received targeted review rather than an independent full line-by-line formal audit; report this depth honestly.
