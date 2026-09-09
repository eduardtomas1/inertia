# Guided issue reporting

Open **Settings → Report an issue**. Describe the observed and expected behavior and reproduction steps, choose the agent/model/reasoning, and optionally select a project for counts. **Create private report chat** saves a scrubbed local draft and shows exactly which safe evidence was collected.

Automatic validation currently supports **Claude Agent SDK** with existing native or configured backend authentication. **Validate with selected model** runs one isolated assessment of the user's observations against the collected metadata. It cannot reproduce arbitrary application behavior. The result separates evidence from unconfirmed observations and suggests reproduction questions to address in the issue preview. Other provider routes retain the same manual preview, editing and submission flow. Provider setup is linked when authentication is missing. Configured backends use their own readiness and vault authentication; a separate native Claude login is not required.

The provider receives the scrubbed description and only these diagnostics:

- Inertia version, OS family and architecture.
- Validated lifecycle state, blocker/quarantine/cleanup codes, resource and unresolved-interaction counts, active maintenance states and bounded Windows cleanup codes.
- Optional counts of chats and pending interactions for the explicitly selected project. Project identifiers and names are excluded.

The collector does not read logs, source, files, paths, environment values or conversation content. It uses the existing validated lifecycle projection, discarding malformed metadata. Description/preview scrubbing removes recognized secrets, configuration assignments, authorization strings, URLs, emails and portable private paths; the user must still review their own prose before sharing it.

The dedicated report run uses the existing isolated-run controller, temporary app-owned working directory, supervised access and fail-closed interaction handling. The Claude SDK receives a native empty tools list, an empty strict MCP configuration, no filesystem settings, and a deny-all native tool callback. Unsupported harnesses are rejected before launch; a prompt prohibition alone is insufficient. The assessment stops at 90 seconds or 8,000 output characters, accepts only a small structured response and inherits owned-process cleanup. No resumable provider session is retained. No new dependencies or embedded credentials are introduced.

**Edit issue preview → Save and review preview** updates the exact public title and body. **Submit issue to GitHub** is the sole in-app publication action. Publication uses the existing restricted CLI runner and the user's GitHub CLI authentication, pins `eduardtomas1/inertia`, sends the bounded body through stdin and verifies the exact result URL. The aggregate discovery/publication deadline is 30 seconds with a 16 KiB output ceiling. No auth environment variables are forwarded.

The latest report is stored in the application database through append-only schema 69. Revision checks reject stale writes; cancellation, provider failures and auth failures preserve the report. Interrupted validation becomes retryable. An attempted publication with no confirmed result becomes **uncertain** and cannot automatically submit again; **Check submission** performs a bounded read-only search for the exact report marker. Interrupted publication retains that protection across restart. Missing GitHub CLI/auth has `gh auth login` instructions and copy/browser continuation.

**Retire this report → Confirm retirement** ends tracking of an uncertain publication after an explicit warning that the original issue may already exist. Pending publication or GitHub checks must finish first. A retired report cannot be edited, validated, checked or submitted again. Its preview remains readable and copyable across restart until you deliberately create another draft. **Start another draft** opens a blank description for an unrelated issue; creating it replaces the saved report with a fresh identity. Older report commands cannot affect the new draft. Only the latest report is retained.

Tests use synthetic input and mocked publication; they never create public test issues. Related incident context is [#298](https://github.com/eduardtomas1/inertia/issues/298), which remains independently scoped.

The current [visual evidence gallery](pr-evidence/offline-diagnostics/README.md) includes dark/light report forms, the saved private chat, reviewed publication controls and a narrow-window layout. Primary actions align with the form; copy/manual continuation and saved-progress/new-draft actions have separate groups. No issue was published during capture.
