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

### Set up new worktrees automatically

In **Settings → Projects**, choose a project and add a saved **Action**, such as executable `npm` with argument `ci`. Under **Worktree setup**, select that action in **Run when creating a worktree**. Setup is off by default; saving these settings does not run a command.

Inertia runs the action in each newly created isolated checkout, including both new Duo worktrees, before allowing its first prompt. Local and reused checkouts do not run setup again. Commands use literal arguments, without implicit shell expansion; use a project script for multiple steps.

The chat shows setup status and its bounded output. If setup fails, choose **Retry setup**, or **Continue without setup**, then send your retained prompt again. Retrying uses the command saved for that checkout. **Stop setup** cancels the running command and its child processes. Setup has a ten-minute limit. After a runtime interruption, Inertia asks you to retry or continue explicitly and keeps the checkout.

Setup prepares files and dependencies. Browser snapshots add visual context to prompts, and Git checkpoints support recovery; both remain separate from worktree setup.

## Pull requests

Open a pull request from the Git menu, and check its readiness before merging.

For every detail and guarantee, see [Git workflows](../GIT_WORKFLOWS.md).
