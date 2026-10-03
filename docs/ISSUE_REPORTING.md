# Issue reporting

Open **Settings → Report an issue**. The form has four fields:

- **What happened** (required, at least 10 characters).
- **Steps to reproduce** (optional).
- **Provider**: one of the app's providers, or **Not sure** (the default).
- **Attach diagnostics** (on by default).

**Preview issue** builds the exact public title and body in the local runtime and shows them in an editable editor. Nothing is sent anywhere until you choose **Create on GitHub**. **Back** returns to the form and keeps any edits you made to the preview; previewing again without changing the form reopens that edited preview instead of rebuilding it. **Copy** copies the title and body. **Open GitHub manually** opens `/issues/new` in your browser with the title and body filled in; when the issue is too long for a link (4,096 characters), Inertia copies it and opens the page with only the title.

## What the issue contains

The body is generated from code, never from text supplied by the renderer:

```markdown
## What happened

After cancelling a running chat, sending the next message leaves it waiting.

## Steps to reproduce

1. Start a turn
2. Cancel it
3. Send another message

## Environment

- Inertia: 0.0.65 (stable)
- OS: macOS 15.1.0 (arm64)
- Electron: 38.2.0
- Provider: claude (claude-agent-sdk 2.0.14)
- Lifecycle: safe-and-ready · blockers none · quarantine none · cleanup current-generation-lease · owned resources none · unresolved turns 0, interactions 0

## Diagnostics

Recent diagnostics from the last 24 hours, pseudonymised by Inertia:
(the bounded diagnostics export in a text block)
```

- The release channel and OS version come from the main process. The app version, architecture, Electron version and the validated lifecycle codes come from the runtime. The provider line uses the active provider's harness and version when the lifecycle snapshot has it, otherwise the installed CLI version when it is a plain version string, otherwise "version unknown".
- With **Attach diagnostics** on, the runtime asks the main process for the pseudonymised diagnostics export of the last 24 hours, bounded to 6,000 bytes. The renderer sends only the on/off choice; it cannot supply evidence text. The request travels over the runtime-to-main broker (`runtime.issue-evidence-request` / `runtime.issue-evidence-result`), is validated on both sides and has a 10-second deadline. When nothing was recorded, the section says so; when the export cannot be collected, it says that instead. With the box off, the section reads "Not attached."
- No project names, paths, conversation content, prompts, provider output or credentials are collected.

The description, steps, title and body are scrubbed before they are stored and again before publication. The scrubber removes private keys, known token formats, JWTs, authorization headers, the values of secret-looking assignments (for example `GITHUB_TOKEN=…`, `password: …`, `"api_key": "…"`), URLs, absolute paths and email addresses. Ordinary labelled lines such as `ENOENT: …`, `ERROR: …` or `HTTP: 500` are kept, as are relative paths. Review your own text before publishing it.

## Publication

**Create on GitHub** first saves any edits, then publishes. If the final scrub changes the text, nothing is published and the updated preview is shown for review. Publication uses the user's existing GitHub CLI login through the restricted CLI runner: `gh auth status`, then `gh issue create --repo eduardtomas1/inertia --body-file -` with the body on stdin and a hidden report marker. No auth environment variables are forwarded. The deadline is 30 seconds with a 16 KiB output ceiling, and only a URL in the fixed repository is accepted.

When the page opens, a read-only `gh auth status` check (10-second deadline) reports problems before you write anything. Failures are classified from the CLI's error output, which never leaves the runtime:

| State | Message |
| --- | --- |
| GitHub CLI missing | GitHub CLI is not installed. Install gh and run gh auth login, or open GitHub manually. |
| Not signed in | GitHub CLI is not signed in. Run gh auth login in a terminal, or open GitHub manually. |
| Offline | GitHub could not be reached. Check your connection and try again. |
| Rate limited | GitHub is limiting requests right now. Wait a few minutes and try again. |
| Repository unreachable | The eduardtomas1/inertia repository could not be reached or does not accept issues. Open GitHub manually instead. |
| Timed out | GitHub did not respond in time. Try again, or open GitHub manually. |

A failure before the issue is sent, or a rejection GitHub states explicitly afterwards (not signed in, rate limited, repository unreachable), leaves the report retryable. Any other failure after the request was sent marks the report **uncertain**: it cannot be submitted again, and **Check submission** performs a bounded read-only search for the report marker. An interrupted publication becomes uncertain after a restart. **Retire this report → Confirm retirement** ends tracking of an uncertain report after a warning that the issue may already exist; a retired report cannot be edited, checked or submitted again, and its preview stays readable until you start another report.

## Storage

The latest report is stored in the application database. Schema 69 added the table; schema 88 converts reports saved by earlier versions to the current shape (drafts and reports from the removed validation step become editable previews). Revision checks reject stale writes. Only the latest report is kept, and **Start another report** replaces it when the new one is previewed.

Tests use synthetic input and a stubbed GitHub CLI; they never create public issues.
