# Pi

Inertia uses an existing **Pi 1.x** installation through its native RPC interface.
Install and sign in using [Pi's documentation](https://pi.dev/docs/latest/).
Select Pi in the model chooser. Its model list comes from Pi's native
configuration; thinking levels follow the selected model. Pi verifies account
access when a request starts. Inertia does not store a second copy of Pi's
credentials.

The privileged application environment accepts these optional settings:

| Variable | Purpose |
| --- | --- |
| `INERTIA_PI_EXECUTABLE` | Absolute executable path or executable name; defaults to `pi`. |
| `INERTIA_PI_ARGS` | JSON array of literal launch arguments. No shell expansion. |
| `PI_CODING_AGENT_DIR` | Existing native Pi configuration directory; defaults to `~/.pi/agent`. |

For example, `INERTIA_PI_ARGS` can contain
`["--provider","anthropic","--model","claude-sonnet-4-6","--thinking","medium"]`.
Use Pi's native authentication or supported provider environment variables for
credentials. Credential flags, protocol/session overrides, and tool-selection
overrides are rejected. Restart Inertia after changing its launch environment.

Inertia keeps native transcripts in `inertia-sessions` inside Pi's configuration
directory. Resume resolves the exact native session ID there and verifies its
workspace. A missing or ambiguous session fails explicitly. Fork and rollback
preserve the original native transcript; rollback adopts a replacement session.
Terminal resume is currently unavailable for these scoped sessions.

Native tools, streaming text/thinking, image input, queued steering, compaction,
context usage, skills, extension dialogs, and Inertia host tools are supported.
Skills are discovered from `.pi/skills` in the project and `skills` inside Pi's
configuration directory. Selection checks their canonical paths before launch.

Automatic extension discovery and project context-file loading are disabled.
Explicit `--extension`, `--skill`, and `--prompt-template` arguments require
absolute canonical paths. Explicit extensions are trusted code inside Pi's
process. Extension confirmation, selection, input, and editor requests appear
as Inertia approval/input dialogs; notifications and text widgets appear as
activity. Terminal-only custom UI and programmatic composer replacement are not
available. Plan and watcher runs restrict native tools to reads; supervised and
auto-edit modes use the managed approval bridge. Pi shell tools receive a
credential-free environment, including PowerShell on Windows.
