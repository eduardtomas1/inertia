# Nightly certification issue 272

This ledger distinguishes the failures tracked by
[issue 272](https://github.com/eduardtomas1/inertia/issues/272). Passing a later
run does not explain an earlier failure. None of the changes described here
relax native cleanup proof, timeout budgets, or the requirement that every
scheduled lifecycle repetition succeed.

## Original occurrence

[Run 34020541173](https://github.com/eduardtomas1/inertia/actions/runs/34020541173)
tested `889970d8fd09d25159b9b36b070394fb910b3f79`.

- Windows x64 and ARM64 failed all three lifecycle attempts with `spawn EINVAL`
  in `bounded-command-trampoline.mjs`, before the selected suites started.
  The runner selected `npm.cmd`, which the shell-free Windows trampoline cannot
  execute. [PR 270](https://github.com/eduardtomas1/inertia/pull/270) replaced
  that launch with the current Node executable and the locked local Vitest
  entrypoint. `tests/scripts/repeated-lifecycle.test.ts` exercises the actual
  bounded invocation with npm absent from PATH. The scheduled repetition count,
  retained outcomes, native ownership wrapper and failure gate remain intact.
- Windows unit shard 4 failed the managed-project-action integration case with
  unconfirmed terminal cleanup and a PID-scoped, forced `taskkill` exit 128.
  The following provider-activity test also reported `EBUSY` deleting the prior
  fixture database. PR 270 independently reproduced and fixed premature success
  from concurrent/later runtime close calls and retained failed teardown owners
  instead of allowing subsequent tests to retarget them. Those changes do not
  establish why the original `taskkill` returned 128. That first cause remains
  unproven; PID absence and a later passing test are not process-tree proof.

## Newer occurrence

[Run 34203043910](https://github.com/eduardtomas1/inertia/actions/runs/34203043910)
tested `3121f2098b0f93d8c8c16efd3df967f6cc9c4549`. Windows x64 reached the
provider Settings panel but its Models tab had no count; the synthetic catalog
was empty. The `Models 2` assertion failed before Advanced or a dropdown was
opened. The dependent merge-ready gate then correctly failed.

The retained snapshot showed Connected, an unverified capability contract and
available Refresh controls. It did not distinguish a pending metadata read from
a failed read. Same-source passes in other runs establish non-determinism, not
runner slowness, successful in-place recovery, or a root cause. PR 320 changed
Windows test environment/native path expectations; it did not change this
metadata publication path.

The Configuration badge's “Waiting for exact installation verification” wording
does not distinguish pending work from unavailable verification. Models already
instructs the user to refresh. This change does not reinterpret that badge as a
metadata progress signal or change its wording.

## Independently reproduced publication defect

At baseline `a5760208fbcfbfe0fb328370c794f668175f4d56`, broad provider refresh
published detection first, then waited for **all** metadata promises before
publishing **any** enriched provider. A completed Codex catalog therefore stayed
empty in snapshots while an unrelated provider read remained pending.

The controlled-promise regression in `tests/server/provider-info-refresh.test.ts`
holds Claude's read open while Codex returns a valid model. It fails on the
baseline with actual models `[]`; no native process, elapsed-time injection or
retry is required to create the dependency. The candidate publishes each runnable
provider's completed metadata under its existing refresh owner. It still joins
all reads before releasing refresh activity, preserves current maintenance
state, and rejects stale publication after a newer targeted refresh claims the
provider. Snapshot broadcast requests retain their existing runtime coalescing.

This proves a product defect capable of delaying a catalog; it does **not** prove
that this interleaving caused the newer nightly failure. No provider protocol,
process cleanup authority, admission policy or cache freshness rule changes.

## Recovery and verification

- Focused coverage checks publication before a sibling finishes, continued
  activity ownership, stale broad completion after targeted refresh, and an
  initial ordinary read rejection followed by a forced successful read using
  the same cache. Existing unconfirmed-cleanup rejection tests remain required.
- `tests/e2e/provider-metadata-recovery.spec.ts` supplies a malformed initial
  catalog, waits for a completed unavailable metadata attempt, then enables the
  synthetic catalog and clicks the actual Settings Refresh button. It requires
  the model to appear with the same runtime PID/generation and exactly two
  catalog reads. This tests the ordinary confirmed-cleanup recovery path;
  quarantined installations do not become retryable by inference.
- Native Settings screenshots, full local verification, portable contracts and
  exact-head hosted CI are recorded in the PR after execution. Until then the
  new native scenario is authored coverage, not a claimed pass.

The separate early-close Browser teardown failure observed by PR 312 has a
stopped utility runtime but a pending privileged-cleanup receipt. Its retained
evidence does not identify the held privileged owner. It is not attributed to
this metadata defect or declared repaired by it.
