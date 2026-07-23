<p align="center">
  <img src="resources/icon.png" width="92" alt="Inertia logo" />
</p>

<h1 align="center">Inertia</h1>

<p align="center">
  Unstoppable execution.<br />
  A calm desktop workspace for building with coding agents.
</p>

![Inertia in dark mode](docs/screenshots/inertia-dark.png)

Inertia keeps the coding loop in one clear place: agent conversations, project files, live changes, plans, previews, Git actions, and a real terminal. It stays spacious and quiet when you need focus, then puts the right controls close by when it is time to move.

![Start a new project in Inertia](docs/screenshots/inertia-new-project.png)

### The whole coding loop, without the noise

- Connect locally installed Codex, Claude, Cursor, or OpenCode accounts without leaving the app.
- Choose from the models and reasoning levels your provider actually offers.
- See provider-supplied thinking summaries, remaining context, and account usage as work progresses.
- Work with streaming conversations, resumable sessions, native plans, agent questions, image inputs, cancellation, and supervised approvals whenever the selected provider supports them.
- Keep terminal tabs alive while moving through Changes, Files, Plan, and Preview.
- Search commands, projects, and threads from one keyboard-friendly palette.
- Resize or collapse either side of the workspace whenever the conversation needs more room.
- Choose System, Light, or Dark with a restrained glass finish and clear contrast.

### Review changes without losing context

- Read every file and hunk in a focused diff view, then mark progress as you review.
- Select a line range to ask a read-only question, request a focused revision, save a note, or carry the exact context into the next prompt.
- Generate a concise agent summary for every current file and hunk, including evidence-backed hints for areas worth extra attention.
- Revert only selected changed lines across staged, unstaged, and mixed files with current-state validation, a recovery backup, and Undo.
- Commit only the paths you choose while leaving unrelated staged work alone and seeing which selected hunks remain unreviewed.

### Conversations that explain the work

- Responses render polished Markdown with safe project links, highlighted code, copy and wrap controls, and tables that can be copied as Markdown or CSV.
- Reasoning summaries, tool activity, approvals, questions, warnings, final answers, and turn checkpoints stay together in one chronological response.
- Completed work logs can collapse quietly; failures and important warnings never disappear inside a successful summary.
- The transcript follows live work only while you are near the bottom, so reading earlier context is not interrupted.

### Keep the workspace moving

- The Activity Center brings agents, checks, services, and source-control work together with the actions each run can actually support.
- Activity-first navigation surfaces work that is running, waiting for approval or input, completed in the background, unread, failed, or settled.
- Related checkouts and worktrees can group by their real Git identity, while repository folders remain clearly labeled and independently controllable.
- Move between branches, use isolated worktrees for parallel threads, open detected service previews, and return to the exact terminal or folder behind a run.

![Inertia in light mode](docs/screenshots/inertia-light.png)

### Find anything without leaving the flow

![Search commands, projects, and threads in Inertia](docs/screenshots/inertia-search.png)

### Settings that stay understandable

![Inertia settings in dark mode](docs/screenshots/inertia-settings.png)

### Provider-native, local by default

Inertia uses the coding tools and accounts already installed on your computer. Codex, Claude, Cursor, and OpenCode keep their own sessions, authentication, models, approvals, plans, reasoning, usage, and cancellation behavior; when a provider does not expose something, Inertia says so instead of imitating it.

Provider credentials remain in each provider's own storage. Inertia stores workspace history and preferences locally, and its optional runtime diagnostics exclude prompts, source, token values, credentials, and connection capabilities.

### Version 0.0.5

This release turns Changes into a real review workflow: line-range questions and revisions, persistent notes and review progress, isolated agent summaries, selective commits, and guarded reversible edits that preserve staged and unstaged work. Conversations now have safe Markdown, readable work logs, stable streaming, changed-file summaries, and response preferences that survive a restart.

It also adds an Activity Center, activity-first project navigation, canonical repository grouping, stronger provider interactions, accurate usage freshness, broad Windows Codex discovery, private runtime diagnostics, responsive interface scaling, rebuilt application icons, and stricter native package validation.

Download [Inertia v0.0.5](https://github.com/eduardtomas1/inertia/releases/tag/v0.0.5):

| Platform | Download |
| --- | --- |
| macOS · Apple silicon | DMG or ZIP |
| Windows · x64 | Installer |
| Linux · x64 | AppImage |

Every release also includes `SHA256SUMS.txt`. See the [changelog](CHANGELOG.md) for the complete release story.

To run from source:

```bash
npm ci
npm run dev
```

The project uses Node.js 22 in continuous integration and release builds.

Inertia is available under the [Apache 2.0 License](LICENSE).
