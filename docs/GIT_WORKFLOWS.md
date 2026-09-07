# Git workflows

Git controls operate on the active chat's checkout. The Changes panel can also
target one discovered nested repository; each action retains that repository's
runtime-issued authority. Opening the menus does not start a network scan.

## Everyday actions

- **Branch menu:** search local and remote branches, see which branches are
  already checked out in another worktree, create a branch, or start another
  chat in an isolated worktree. Choosing a remote branch creates a local branch
  of the same name with explicit tracking. A local name collision is reported
  rather than replaced. Switching requires a complete, clean status. Commit or
  stash local changes first; creating a new branch can carry existing work.
- **Git menu:** see the current branch, upstream, incoming/outgoing counts, and
  changed-file totals. The primary button follows the next available step:
  review a commit, pull incoming commits, or push/publish existing commits.
  The full menu keeps unavailable actions and their explanations readable.
- **Fetch:** refresh remote branches without changing local files or staged
  content. Fetch uses the tracked remote, then `origin`, then a sole remote.
  Ambiguous selection requires configuring tracking or using the terminal.
  Fork workflows fetch the upstream independently of the push remote. Fetch is
  also available for a dirty checkout and from a nested repository's Changes
  controls. Stop an active fetch from **Environment**; the activity stays live
  until owned process cleanup settles.
- **Pull:** requires an upstream and a complete, clean checkout. Only a
  fast-forward is permitted; Inertia does not auto-stash, rebase, resolve
  conflicts, or recurse into submodules. Fetch first to update the incoming
  count. A branch with no upstream is labeled as such, not as up to date.
- **Commit / Push / Pull request:** retain Inertia's complete-diff review
  receipts, selected-path commit transaction and separate authenticated PR
  flow. Existing commits can be pushed while unrelated uncommitted work remains.
  A behind/diverged branch must be reconciled first. No force push is offered.

Counts reflect locally available remote-tracking refs, not a live network
guarantee. A truncated status is shown as incomplete and cannot authorize
commit/pull through these controls. Git failures use bounded, credential-free
guidance for authentication, connectivity, non-fast-forward rejection, index
locks, occupied branches, and missing author identity.

## Design reference and architecture

Reviewed current T3 Code upstream at
[`62fbbe08aa854fcbd8044cd971a45a54edafcb98`](https://github.com/pingdotgg/t3code/tree/62fbbe08aa854fcbd8044cd971a45a54edafcb98).
The implementation is adapted to Inertia's existing Electron/runtime split;
it does not import T3 Code dependencies or copy its service architecture.

| Upstream source studied | Decision in Inertia |
| --- | --- |
| [GitActionsControl](https://github.com/pingdotgg/t3code/blob/62fbbe08aa854fcbd8044cd971a45a54edafcb98/apps/web/src/components/GitActionsControl.tsx) and its logic module | Keep a compact split action, readable disabled reasons, explicit branch/upstream context and progressive workflow states. Retain Inertia's authenticated full-diff review before committing. |
| [BranchToolbarBranchSelector](https://github.com/pingdotgg/t3code/blob/62fbbe08aa854fcbd8044cd971a45a54edafcb98/apps/web/src/components/BranchToolbarBranchSelector.tsx) | Add searchable, grouped local/remote choices, loading/error/retry states and explicit remote tracking. Keep chat/checkout mismatch evidence instead of silently rewriting chat identity. |
| [GitVcsDriverCore](https://github.com/pingdotgg/t3code/blob/62fbbe08aa854fcbd8044cd971a45a54edafcb98/apps/server/src/vcs/GitVcsDriverCore.ts) | Add a separate scoped fetch; guard detached/missing-upstream pull; preserve fast-forward semantics. Avoid automatic network polling and destructive reset paths. |
| [GitManager](https://github.com/pingdotgg/t3code/blob/62fbbe08aa854fcbd8044cd971a45a54edafcb98/apps/server/src/git/GitManager.ts) and [GitWorkflowService](https://github.com/pingdotgg/t3code/blob/62fbbe08aa854fcbd8044cd971a45a54edafcb98/apps/server/src/git/GitWorkflowService.ts) | Reuse Inertia's canonical checkout serialization, scan invalidation, authority binding and durable activity rather than introducing another Git manager or cache. |

`src/server/git` owns Git execution and parsing. The runner uses argument arrays,
sanitized environments, bounded output/deadlines and runtime-owned process
trees. Inspections disable optional index locking, fsmonitor, external diff and
text conversion. Branch listing uses one inspection for local/remote refs and
occupancy, bounded to 1,000 branches and 1 MiB; larger lists fail with explicit
terminal guidance. Occupancy is projected as a boolean, not another worktree's
filesystem path. Remote names containing slashes are matched by longest prefix.

Fetch has a shared 180-second workflow deadline and a 120-second network limit;
the output limit is 64 KiB. Its explicit refspec updates only that remote's
tracking branches, with tags, pruning, `FETCH_HEAD`, submodule recursion and
automatic maintenance disabled. It uses the same scoped mutation serialization
and invalidation as other Git actions. Cancellation and disconnect retain
ownership until cleanup finishes. Branch validation no longer disguises
timeout, missing-executable or process-cleanup failures as invalid names.

Workspace discovery and worktree ownership/cleanup rules remain governed by
their existing bounded implementations. This work is held outside release54;
it does not change a version, release workflow, provider protocol or database
migration.

## Evidence

Focused tests cover real local bare remotes, dirty/index preservation, fork
routing, explicit tracking, branch collisions, occupied worktrees, missing
tracking, detached HEAD, cancellation/deadlines, safe error classification,
command authority contracts, and renderer search/focus/disabled states.
The feature-owned Electron scenario in `tests/e2e/git-workflows.spec.ts`
exercises actual IPC and Git operations and attaches desktop screenshots in
dark and light themes. CI provides the applicable Linux, macOS and Windows
evidence; live SSH/HTTPS accounts require separately configured credentials.
