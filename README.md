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
- Find models quickly through a searchable provider-aware palette, then save complete harness, backend, model, and reasoning routes as Favorites.
- See provider-supplied thinking summaries, remaining context, and account usage through one compact context control.
- Work with streaming conversations, resumable sessions, native plans, agent questions, image and document inputs, cancellation, and supervised approvals whenever the selected provider supports them.
- Keep terminal tabs alive while moving through Changes, Files, Plan, and Preview.
- Search commands, projects, and threads from one keyboard-friendly palette.
- Resize or collapse either side of the workspace whenever the conversation needs more room.
- Choose System, Light, or Dark with a restrained glass finish and clear contrast.

### Review changes without losing context

- Read every file and hunk in a focused diff view, then mark progress as you review.
- Review modified files across a project-root repository and nested module repositories without flattening their Git identity.
- Select a line range to ask a read-only question beside the matching hunk, request a focused revision, save a note, or carry the exact context into the next prompt.
- Generate a concise agent summary for every current file and hunk, including evidence-backed hints for areas worth extra attention.
- Revert only selected changed lines across staged, unstaged, and mixed files with current-state validation, a recovery backup, and Undo.
- Commit only the paths you choose while leaving unrelated staged work alone and seeing which selected hunks remain unreviewed.

Nested module repositories keep their own review marks, notes, questions, and selective reverts. Agent revision requests and generated whole-repository summaries remain limited to the project-root repository because their recovery checkpoint must cover the same Git worktree; Inertia explains that boundary instead of presenting nested repositories as temporarily unavailable.

### Conversations that explain the work

- The transcript reads like one calm engineering document: a light request, an understandable workstream, a clean final answer, and a quiet supporting ledger.
- Responses render polished Markdown with safe project links, highlighted code, copy and wrap controls, and tables that can be copied as Markdown or CSV.
- Provider updates and compact tool activity appear in the order they happened. Only adjacent calls fold together, so a new update naturally starts the next stretch of work.
- Reasoning summaries, approvals, questions, warnings, final answers, and turn checkpoints stay together in the same chronological turn.
- Each completed request keeps its original agent, model backend, and model attribution together with a turn-specific before-and-after Git record, when available, that remains useful after the workspace moves on.
- Completed work logs can collapse quietly; failures and important warnings never disappear inside a successful summary.
- Long transcripts keep stable rows and load their heavier detail separately, while incremental runtime updates resume safely after a restart.
- The transcript follows live work only while you are near the bottom, so reading earlier context is not interrupted.
- Delegated agent work remains attached to its parent turn, with compact progress that can be followed without losing the main conversation.

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

- Create, test, enable, and choose model backend profiles without mixing them into the agent harness that runs the conversation.
- See when a supported provider CLI has an update and run the official update flow without leaving Inertia.
- Use the built-in Kimi coding profile through the Claude harness, or define a compatible custom endpoint with explicit models and routing.
- Existing conversations keep their original execution route. Supported same-backend model changes can continue in place; changing the harness or backend opens a clearly separated new chat.

### Provider-native, local by default

Inertia uses the coding tools and accounts already installed on your computer. Codex, Claude, Cursor, and OpenCode keep their own sessions, authentication, models, approvals, plans, reasoning, usage, and cancellation behavior; when a provider does not expose something, Inertia says so instead of imitating it.

Provider account credentials remain in each provider's own storage. Credentials added for custom model backends are encrypted through the operating system's secure credential storage; only non-secret profile settings live in Inertia's local database. Inertia stores workspace history and preferences locally, and its optional runtime diagnostics exclude prompts, source, token values, credentials, and connection capabilities.

Access mode is a real safety boundary. Supervised keeps the selected provider's approval flow active. Auto-edit pre-approves supported file edits while leaving other provider permissions in place. Full Access is an explicit opt-in that asks the provider for its unrestricted mode—for example, Codex uses its danger-full-access sandbox/approval configuration and Claude uses its `--dangerously-skip-permissions` mode. Use it only in a workspace where you trust the request, repository, and commands the agent may run.

### Get started

Download the build for your platform, add a project, then open **Settings → Providers**. Inertia checks Codex, Claude, Cursor, and OpenCode locally and shows the exact Install, Connect, or Refresh action each route needs. Authentication stays in the provider's own official flow.

You only need one ready provider to begin. If none is available yet, projects, files, Git review, and terminals still work; agent runs remain disabled with a route-specific explanation instead of failing after you send a message.

To run Inertia from source, use Node.js 22:

```bash
npm ci
npm run dev
```

Contributors can run the complete local gate with `npm run check`. It covers architecture, lint, type safety, unit and integration tests, and the production bundle.

### Troubleshooting

If something goes wrong, first refresh the affected provider in **Settings → Providers**. For a reproducible app or runtime problem, open **Settings → Runtime diagnostics**, choose **Copy diagnostic report**, review the report once more, and attach it to the [public bug form](https://github.com/eduardtomas1/inertia/issues/new?template=bug_report.yml). The built-in report excludes prompts, source content, token values, credentials, and provider capabilities; do not substitute raw logs, databases, or unredacted diagnostic archives.

Report suspected vulnerabilities privately through the [security policy](SECURITY.md), never through a public issue.

### Version 0.0.12

This release makes evidence about a change arrive much faster. Real renderer interaction tests now cover focus, keyboard, disclosure, and terminal ownership; the 35-scenario Electron suite is split into focused feature gates; all-source coverage is measured; and structural import, cycle, facade, and size rules protect the architecture.

Node.js onboarding, private security reporting, privacy-aware bug reports, deterministic third-party notices, dependency updates, and a weekly latest-provider canary make maintenance more predictable. The release also prevents delayed terminal startup from stealing command-palette focus on Windows.

Download [Inertia v0.0.12](https://github.com/eduardtomas1/inertia/releases/tag/v0.0.12):

| Platform | Download |
| --- | --- |
| macOS · Apple silicon | DMG or ZIP |
| Windows · x64 | Installer |
| Linux · x64 | AppImage |

Every release also includes `SHA256SUMS.txt`. See the [changelog](CHANGELOG.md) for the complete release story.

Inertia is available under the [Apache 2.0 License](LICENSE). Packaged builds also include the generated notices and original license texts supplied by their production dependencies and Electron.
