# Review and ship

Inertia keeps review next to the chat, so you can check an agent's work before it leaves your computer.

## Review changes

- The **Changes** panel shows the changed files on the current branch. Mark hunks as reviewed as you go.
- Select code to ask the agent about it.
- The panel can also target a nested repository inside the project.

## Commit and push

- The **Git** menu shows the branch, upstream, incoming and outgoing counts and changed-file totals. Its primary button follows the next available step: review a commit, pull incoming commits, or push.
- Commits include only the paths you choose.
- **Pull** only fast-forwards, and needs a clean checkout. Inertia never auto-stashes, rebases or force-pushes.
- **Fetch** refreshes remote branches without touching local files.

## Branches and worktrees

The **branch menu** searches local and remote branches, shows which are checked out in another worktree, creates branches and starts chats in an isolated worktree.

## Pull requests

Open a pull request from the Git menu, and check its readiness before merging.

For every detail and guarantee, see [Git workflows](../GIT_WORKFLOWS.md).
