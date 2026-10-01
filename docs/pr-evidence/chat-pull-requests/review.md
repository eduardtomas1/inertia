# Multiple linked pull requests and native GitHub stacks

A chat can retain multiple PRs from different GitHub repositories. The existing right-panel launcher gains a lazy Pull requests surface, available in main, split and detached chats. Its collection and detail views use Inertia's theme tokens and keyboard navigation. It is opened explicitly and adds no empty sidebar section. PRs created through the existing verified creation flow link automatically; a local persistence failure preserves the successful creation URL and explains how to save it without submitting creation again.

Manual links, created links and discovered native stack members persist independently of the local checkout. Unlinked members retain a dismissal record so refresh does not recreate them. Host/repository/number identities prevent equal PR numbers in different repositories from colliding. Refresh preserves the last successful snapshot if GitHub is unavailable. The existing GitHub integration's `github.com` host scope is preserved; GitHub Enterprise and inferred branch-based stacks are not introduced.

## Source reference and behavior

Inspected [T3 at c57a04b7](https://github.com/pingdotgg/t3code/tree/c57a04b722f2172e3be2c8f73c936d10b4582431), especially `packages/contracts/src/orchestration.ts`, `apps/server/src/pullRequest/GitHubPullRequestCli.ts`, `gitHubPullRequestJson.ts` and `githubStackActions.ts`. This is an independent integration with Inertia's SQLite persistence, strict IPC, existing right-panel surface loader and owned CLI execution.

- Native stack membership comes from `GET repos/{owner}/{repo}/stacks?pull_request={number}`, followed by `GET stacks/{stackNumber}` for layer details, matching T3. Listing responses may omit heads, draft or state. Detail reads verify the same membership, order and base; mutations require exact heads from fresh evidence. Only a stack endpoint 404 means unavailable; authentication and malformed-response errors preserve cached evidence.
- Merge reviews the unmerged prefix through the selected PR. A second explicit confirmation rechecks stack identity/order, all affected head and base revisions, draft/state, complete check and review-conversation evidence, and merge readiness. It calls GitHub's `PUT pulls/{number}/merge-async` with the reviewed head and normal merge-commit method; branch rules are never bypassed. Repositories that disallow this method receive GitHub's refusal.
- Rebase is available from the top layer and updates the whole stack bottom-to-top using `updatePullRequestBranch`, `expectedHeadOid` and `updateMethod: REBASE`. It verifies branch-write or eligible fork-maintainer access, stack topology, base revisions and already-processed heads before later updates. It skips current branches, records partial progress and never rewrites the local checkout.
- Durable reviews expire after five minutes. Execution claims serialize the same stack across chats. Native merge UUIDs survive restart and are polled without reissuing the mutation. An unknown outcome stays blocked. Read-only reconciliation can confirm merged layers or a fully current rebase; partial unresolved outcomes require checking/completing the remaining work on GitHub. Chat/project deletion cannot discard active operation ownership.
- The CLI runs shell-free from the runtime's owned data directory with a fixed GitHub host, structured JSON stdin, sanitized environment, one MiB output cap, cancellation and bounded deadlines. Existing native process containment stays intact. Credentials are neither saved in the new tables nor returned to the renderer.
- Pending and unknown actions take priority over completed history in the bounded action list, so newer actions cannot hide their recovery receipts. A chat can own at most 20 outstanding stack actions; another action requires resolving one first.

## Validation and screenshots

Focused persistence, strict command scope, native protocol, ordered mutation, cache, restart, lost-response, UI confirmation and keyboard tests pass. Migration 88 is append-only; older-fixture upgrades and lineage are covered. The PR surface remains deferred from initial main and detached routes; measured bundle deltas preserve the prior budgets' headroom.

Two production Electron appearance scenarios passed, with theme assertions, native stack menu bounds, Escape focus restoration and narrow-window overflow checks. Screenshots use real persisted cache fixtures with fictional `acme` repositories; they show the interface, not live GitHub execution:

- `pull-requests-light.png`, `pull-requests-dark.png`: several PRs and repositories in one chat.
- `native-stack-light.png`, `native-stack-dark.png`: ordered stack layers and actions.
- `pull-request-detail-light-narrow.png`, `pull-request-detail-dark-narrow.png`: narrow layout.

The complete guarded CLI/IPC/confirmation/restart Electron scenario stops before the first remote PR sync on this cloud host. Its attached runtime-state receipt reads: `owned process containment could not be confirmed (stage=linux-readiness, probe=git)`, phase `stopped`, generation 4, restart attempt 3. This is the same unchanged native guardian limitation seen on the other two feature branches. No live GitHub merge or branch rewrite was performed. The secret-free CLI scenario remains available for normal supported-platform E2E execution.

Final complete-suite, portable and build results are recorded in the PR after the running checks finish. macOS/Windows and live native GitHub Stack endpoints have not been exercised locally.
