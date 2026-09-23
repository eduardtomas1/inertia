# Linux terminal readiness in recovery fixtures

Linux ARM64 [job 107075162159](https://github.com/eduardtomas1/inertia/actions/runs/35828295240/job/107075162159)
failed the retiring-record case in `runtime-owned-process-update-recovery.test.ts`
at head `017301e68b8bcfcdd2cf0d28454ac97608ab5bc2`. Recovery returned `false`.
The case took 113ms, and all three cases took 452ms; this was not evidence of
exhausting the two-second recovery deadline. The job log confirms no test
artifact was uploaded, so its process/authority state cannot be reconstructed.

## Fixture precondition

Both `completedGuardian` in the update test and `completedLinuxGuardian` in the
general recovery test waited only for `/proc/<pid>/comm` to become
`inertia-exdone`. The native `terminal_state` function publishes that name before
installing its terminal seccomp filter and stopping itself. Observing the name
therefore does not prove the guardian has reached its hardened terminal state.

Retiring-record recovery requires that proof immediately; owned-record recovery
waits for it. The production monitor normally marks a live guardian retiring
only after full terminal authority is established. Weak fixture readiness can
therefore fail the retiring test while its neighboring owned cases pass.

The two fixtures now wait on the existing `linuxGuardianTerminalAuthority`
predicate with the exact durable claimed identity and `inertia-exdone` name.
This checks the stopped state, birth identity, process group, sandbox flags,
single untraced thread, empty children, and recorded helper identity fields.
The existing helper still independently verifies its executable and the target
when recovery actually signals it.

Production TypeScript and native C are unchanged. The default `vi.waitFor`
bound, two-second recovery deadline, replacement-inode assertion, recovery
result, claim/lease cleanup, and unauthorized-recovery assertions are unchanged.

## Native control and validation

Used an isolated, task-owned Linux ARM64 container with Node 22.23.2, kernel
6.8.0-117-generic, exact source, and a fresh `npm ci` dependency tree.

- Unchanged baseline: all three update-recovery cases passed (779ms total).
- A temporary container-only native control widened the interval after the real
  terminal-name publication and before final filtering/self-stop to 500ms.
  With the original fixture, the marker was visible while the guardian was
  sleeping (`State: S`) and terminal authority was false. Owned recovery waited
  and succeeded; retiring recovery returned false without invoking the recovery
  helper: **one failure, two passes**, matching the hosted case selection.
- With the corrected fixture and the same controlled interval, every fixture
  returned only at `State: T` with terminal authority true. **All three passed**
  in 2.40s. The control establishes this readiness race; it does not establish
  the unrecorded process state in the hosted failure.
- Removed all control instrumentation, restored native C byte-for-byte, and
  rebuilt the real helper. SHA-256:
  `bd71e49af9b426cef50b1080aba7e96f6741f31894420d32d43eac8fd8daa18d`.
- Clean Linux ARM64 cohort: **107 passed / 11 platform skips**, four files,
  26.34s: update recovery, general recovery, Linux ownership, and Linux helpers.
  Includes nonterminal refusal, post-exec preauth rejection, wrong-parent
  rejection, replacement-helper identity, and durable cleanup failure cases.
- Final macOS ARM64 Node 22.23.2 `npm run check`: **9,759 passed / 146 platform
  skips**, 905 files passed / 16 skipped, plus **7 separate-process tests**
  (test phase: 113.50s). All lint, type, architecture, migration, build, and
  renderer bundle gates pass. The existing 2,500-line test-file ceiling is
  preserved by compacting only the added import and predicate formatting.

Local logs: `/tmp/inertia-pr448-linux-npm-ci.log`,
`/tmp/inertia-pr448-linux-recovery-baseline.log`,
`/tmp/inertia-pr448-linux-readiness-before.log`,
`/tmp/inertia-pr448-linux-readiness-after.log`,
`/tmp/inertia-pr448-linux-recovery-focused.log`, and
`/tmp/inertia-pr448-linux-fixture-final-check.log`.

No guardian/test processes remained before removing the task-owned container.
The existing Docker context, Colima profiles, and other owners' containers were
unchanged. Native Windows, Intel Mac, packaged updates, and live providers were
not exercised in this follow-up. No provider protocol, production recovery,
packaging behavior, or bundle budget changed; hosted CI and merging remain with
the coordinator task.
