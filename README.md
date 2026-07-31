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
- Launch a saved Duo from one shared prompt into two independently named chats, each with its own project, model route, reasoning, and access mode.
- Open any second chat beside the current one—even from another project—with its own transcript, draft, files, Git changes, terminal sessions, plan, and preview.
- Keep up to 12 unfinished text prompts in a local stash with their exact harness, backend, model, and reasoning route, then restore one into either side of a split workspace without moving attachments or credentials.
- Start from a compact Environment summary of the current branch, changes, active work, delegated agents, and attached context, while keeping the full workspace tools one click away.
- Keep terminal tabs alive while moving through Changes, Files, Plan, and Preview.
- Receive quiet provider-scoped warnings when an authoritative five-hour or weekly quota reaches 25%, 15%, or 5% remaining.
- Search commands, projects, and threads from one keyboard-friendly palette.
- Resize or collapse either side of the workspace whenever the conversation needs more room.
- Choose System, Light, or Dark with a restrained glass finish and clear contrast.

![Two independent projects sharing a split Inertia workspace](docs/screenshots/inertia-split-workspace.png)

### Two perspectives, one prompt

The lightning action beside **New chat** opens a focused Duo setup. Give both chats a name, choose their projects and complete provider routes, then send one shared prompt to both. Inertia creates the conversations safely, starts the acknowledged pair together, and opens the results in the split workspace without pretending that their sessions, permissions, tools, or working directories are shared.

Save one bounded default Duo for the combinations you use often. The preset stores only safe route identity and chat names—not prompts, projects, credentials, or provider-specific secrets—and Inertia warns when both agents will edit the same checkout.

![Configure two agent perspectives from one shared prompt](docs/screenshots/inertia-duo.png)

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
- The Activity Center keeps the latest meaningful operations close to the active agent, folds older successful calls behind one disclosure, and keeps manual Git work or failures independently visible.
- Open project-file references from prose or fenced-code labels directly in Files, then edit supported text files in a focused dialog that refuses to overwrite content changed since it was opened.
- Reasoning summaries, approvals, questions, warnings, final answers, and turn checkpoints stay together in the same chronological turn.
- Codex-native goals and Inertia-local objectives keep their source visible, while next-turn skills stay route-bound and never expose provider paths or contents.
- Each completed request keeps its original agent, model backend, and model attribution together with a turn-specific before-and-after Git record, when available, that remains useful after the workspace moves on.
- Completed work logs can collapse quietly; failures and important warnings never disappear inside a successful summary.
- Long transcripts keep stable rows, preview distant requests from the conversation minimap, and load heavier detail only when opened, while bounded runtime updates resume safely after a restart.
- The transcript follows live work only while you are near the bottom, so reading earlier context is not interrupted.
- Provider-reported delegated work remains attached to its parent turn. The Goal panel preserves the real hierarchy; **Guide parent** prepares an ordinary parent follow-up, while direct Stop appears only for supported live Claude tasks.

![An active Inertia workstream with interleaved commentary and compact tool activity](docs/screenshots/inertia-workstream.png)

### Truthful goals, skills, and delegated work

- Codex-native goals and Inertia-local objectives are labeled separately, persisted across reconnects, and never substituted for one another.
- Skills are discovered from the selected Codex or Claude route and attached only to the next turn after privileged revalidation; the renderer never receives their filesystem path or content.
- Delegated agent trees preserve provider-reported parentage, status, and ownership. Guide parent prepares an ordinary supported follow-up; direct Stop appears only for supported live Claude tasks.

![Goals and delegated agent work in Inertia](docs/screenshots/inertia-agent-workflows.png)

### Keep the workspace moving

- The Activity Center brings agents, checks, services, and source-control work together with the actions each run can actually support.
- Native previews, terminals, files, and Git reviews stay scoped to their owning chat when two different projects share the split workspace.
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
- Choose whether Inertia opens on the compact Environment summary or the full workspace tools; fresh installs use the calmer summary.

### Remote Companion, without surrendering the desktop

Remote Companion is an experimental, self-hosted, opt-in way to follow safe conversation projections and send text prompts to an existing supervised chat while the Inertia desktop remains online. The desktop stays authoritative and opens only an outbound WebSocket; Inertia does not ship a hosted relay or open an inbound listener on your machine.

Pairing requires an explicit comparison and a device-specific project grant. Grants are scoped, expiring, revocable, paused on screen lock or suspend, and recorded in a local audit history. Application payloads are end-to-end encrypted, while the reference relay sees only unavoidable routing, timing, and size metadata.

The remote boundary is deliberately small. It can show sanitized user and assistant text and can submit text to an existing supervised conversation. It cannot approve commands, answer secret questions, browse or transfer files, use attachments or terminals, change provider settings, mutate Git, create projects or chats, stop runs, expose diagnostics, or enable Full Access.

See the [Remote Companion protocol](docs/REMOTE_COMPANION_PROTOCOL.md), [threat model](docs/REMOTE_COMPANION_THREAT_MODEL.md), and [self-hosting guide](remote/README.md) before enabling it.

### Provider-native, local by default

Inertia uses the coding tools and accounts already installed on your computer. Codex, Claude, Cursor, and OpenCode keep their own sessions, authentication, models, approvals, plans, reasoning, usage, and cancellation behavior; when a provider does not expose something, Inertia says so instead of imitating it.

Provider account credentials remain in each provider's own storage. Credentials added for custom model backends are encrypted through the operating system's secure credential storage; only non-secret profile settings live in Inertia's local database. Inertia stores workspace history and preferences locally, and its optional runtime diagnostics exclude prompts, source, token values, credentials, and connection capabilities.

Access mode is a real safety boundary. Supervised keeps the selected provider's approval flow active. Auto-edit pre-approves supported file edits while leaving other provider permissions in place. Full Access is an explicit opt-in that asks the provider for its unrestricted mode—for example, Codex uses its danger-full-access sandbox/approval configuration and Claude uses its `--dangerously-skip-permissions` mode. Use it only in a workspace where you trust the request, repository, and commands the agent may run.

### Get started

Download the build for your platform, add a project, then open **Settings → Providers**. Inertia checks Codex, Claude, Cursor, and OpenCode locally and shows the exact Install, Connect, or Refresh action each route needs. Authentication stays in the provider's own official flow.

You only need one ready provider to begin. If none is available yet, projects, files, Git review, and terminals still work; agent runs remain disabled with a route-specific explanation instead of failing after you send a message.

To run Inertia from source, use Node.js 22.13 or newer in the Node 22 line:

```bash
npm ci
npm run dev
```

Contributors can run the complete local gate with `npm run check`. It covers architecture, lint, type safety, unit and integration tests, and the production bundle.

### Troubleshooting

If something goes wrong, first refresh the affected provider in **Settings → Providers**. For a reproducible app or runtime problem, open **Settings → Runtime diagnostics**, choose **Copy diagnostic report**, review the report once more, and attach it to the [public bug form](https://github.com/eduardtomas1/inertia/issues/new?template=bug_report.yml). The built-in report excludes prompts, source content, token values, credentials, and provider capabilities; do not substitute raw logs, databases, or unredacted diagnostic archives.

Report suspected vulnerabilities privately through the [security policy](SECURITY.md), never through a public issue.

### Version 0.0.18

This release introduces the experimental **Remote Companion**: a narrowly scoped, end-to-end encrypted browser companion for safe live conversation viewing and separately authorized text prompts to existing supervised chats. It is self-hosted, off by default, outbound-only from the desktop, project-scoped, expiring, revocable, and intentionally excludes approvals, secrets, files, terminals, Git mutation, settings, diagnostics, new chats, and Full Access.

Codex and Claude delegated-agent state is now persisted and presented with truthful hierarchy and terminal outcomes. Long-conversation minimap previews, attachment import containment, process-tree shutdown, terminal cleanup, prompt drafts, reasoning summaries, and Windows encrypted-vault validation are also more reliable across platforms.

Download [Inertia v0.0.18](https://github.com/eduardtomas1/inertia/releases/tag/v0.0.18):

| Platform | Download |
| --- | --- |
| macOS · Apple silicon | DMG or ZIP |
| Windows · x64 | Installer |
| Linux · x64 | AppImage |

Every release also includes `SHA256SUMS.txt`. See the [changelog](CHANGELOG.md) for the complete release story.

Inertia is available under the [Apache 2.0 License](LICENSE). Packaged builds also include the generated notices and original license texts supplied by their production dependencies and Electron.
