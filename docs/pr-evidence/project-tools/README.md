Project Tools desktop evidence

- `configure.png`, `live.png` and `restart.png`: full native Electron captures
  from the successful Linux ARM64 CI job, at 1440 × 1000.
  Source: `ca4861b2a3198d4e6d0639057c77fecdb9536489`.
  Workflow run: https://github.com/eduardtomas1/inertia/actions/runs/36853147739
  Job: https://github.com/eduardtomas1/inertia/actions/runs/36853147739/job/110345655373
  Artifact: `project-tools-screenshots-linux-arm64` (ID `11159731034`).
  Archive SHA-256: `cee89c658fa9d78bc8890517f8d4da05f332f97267b9eedd7e3bc80f1f64eea5`.
  The provider is a deterministic Codex app-server protocol fixture; the app,
  IPC, persistence, credential lookup and run lifecycle are real.
- The older `live-preview.png` and `restart-preview.png` are renderer-only
  previews retained for provenance; the PR now uses the full native captures.
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
- Real Claude probes confirmed expansion in URLs and nested token values too.
  The connection validator and privileged token resolver reject these templates
  before launch; percent-encoded literal URL characters remain supported.

The local cloud kernel lacks
`/proc/<pid>/task/<pid>/children`, so Inertia's existing process guardian correctly
refuses native agent admission there. The successful native Linux ARM64 CI job supplies the run-state evidence above.
