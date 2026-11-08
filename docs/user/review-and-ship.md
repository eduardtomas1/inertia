# Review and ship

Inertia keeps review next to the chat, so you can check an agent's work before it leaves your computer.

## Review changes

- The **Changes** panel shows the changed files on the current branch. Mark hunks as reviewed as you go.
- Select code to ask the agent about it.
- The panel can also target a nested repository inside the project.

Diffs are syntax-highlighted by file type, and when a few lines are replaced one-for-one the changed words are emphasized. Use **Unified | Split** in the panel toolbar to read old and new code side by side; each chat remembers its choice. Split view needs a panel at least 720 pixels wide and shows unified below that. Selecting lines, review marks and **N** / **P** hunk navigation work the same in both views. Very large diffs (more than 4,000 lines, or lines over 2,000 characters) are shown as plain text to stay responsive.

## Commit and push

- The **Git** menu shows the branch, upstream, incoming and outgoing counts and changed-file totals. Its primary button follows the next available step: review a commit, pull incoming commits, or push.
- Commits include only the paths you choose.
- Write a multi-line commit message (subject, blank line, details; Cmd/Ctrl+Enter commits) or click **Draft message** to fill one from the chat's review summary or the selected files. In **Changes**, **Stage** / **Unstage** a file from its row or context menu, or use **Stage all** / **Unstage all**; your working-tree files are never changed.
- **Pull** only fast-forwards, and needs a clean checkout. Inertia never auto-stashes, rebases or force-pushes.
- **Fetch** refreshes remote branches without touching local files.
- **History…** in the Git menu lists the branch's commits (load more as you go) and shows each commit's files and diff; **Blame** in the Files preview shows who last changed each line. Both are read-only.

## Branches and worktrees

The **branch menu** searches local and remote branches, shows which are checked out in another worktree, creates branches and starts chats in an isolated worktree.

- **Worktrees:** Settings → Projects → Worktrees lists every worktree of the project's repository with its branch, chat and clean state. Remove deletes only a clean worktree Inertia created for a chat that is not running, and deletes its branch only when it is already merged; Prune clears records of worktrees whose folders are gone.

## Pull requests

Open a pull request from the Git menu, and check its readiness before merging.

For every detail and guarantee, see [Git workflows](../GIT_WORKFLOWS.md).
