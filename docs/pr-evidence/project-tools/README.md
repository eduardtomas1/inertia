Project Tools desktop evidence

- `configure.png`: native Electron configuration panel.
- The feature-owned Electron scenario is `tests/e2e/project-tools.spec.ts`.
  It exercises the real renderer, IPC, database, credential broker and run lifecycle
  with a deterministic Codex app-server fixture, and attaches configuration,
  available/authentication and restart-state screenshots to the CI artifacts.
- Live protocol smoke checks also connected a loopback HTTP MCP fixture to Claude
  Code 2.1.286 (Agent SDK 0.3.283) and Codex 0.159.3. Both reported `search_docs`
  through their native status APIs. These checks do not require a model turn.
- A real Claude bearer-authentication probe also passed: five authenticated HTTP
  requests, `search_docs` reported connected, and no token value in subprocess
  arguments. Claude expands the environment reference inside its process.

The initial local screenshot comes from Linux. The cloud kernel lacks
`/proc/<pid>/task/<pid>/children`, so Inertia's existing process guardian correctly
refuses native agent admission there. Native CI supplies the run-state evidence.
