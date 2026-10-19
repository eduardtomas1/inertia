# App under test

The App under test lets the user and the coding agent run the desktop
application a chat is building, read its output, see its windows, drive them,
keep local evidence, and stop it. It is not general desktop automation: the
only processes the App tools act on are the ones Inertia launched for that
chat, and the only windows are the page windows of those processes. The user's
desktop, the foreground application, other copies of the app, and Inertia
itself are never targets of an App tool. The launched app is not sandboxed by
Inertia: it runs the project's own code with the user's permissions, like any
program the user starts.

![The App surface with a running Electron app, its log and its window](screenshots/inertia-app-under-test-dark.png)

## Product contract

- Every chat has one App session, owned by the supervised local runtime like
  the chat's terminals. A chat runs at most two live launches and the runtime
  at most eight across all chats. A launch that exits stays listed with its
  exit status and the newest lines of its log; a chat keeps at most eight
  launches and drops the oldest exited ones first.
- The runtime keeps at most 16 App sessions whose chats have no live launch,
  and at most 16 MiB of screenshot thumbnails across all chats. Beyond either
  bound it forgets the least recently used of those idle sessions, with its
  logs and evidence, and the App surface hears `session.cleared`. A session
  with a live launch is never forgotten this way.
- There are two launch kinds, and neither takes a command line from the agent
  or the renderer:
  - **Electron app** (`electron`) starts the project's own Electron binary
    from the chat's workspace. Inertia reads `node_modules/electron/path.txt`
    and resolves `node_modules/electron/dist/<path.txt>` the way the
    `electron` package does, without loading or running any package code, and
    ignores `ELECTRON_OVERRIDE_DIST_PATH`. The package folder, the binary and
    the `package.json` `main` entry (with Electron's `.js`, `.cjs`, `.mjs` and
    `/index.js` fallbacks) must resolve inside the workspace after following
    symlinks. This containment is a sanity check that Inertia starts the
    project's own Electron, not a code-execution boundary: the entry, its
    dependencies and anything they load are the project's code, and they run
    with the user's permissions. The app is started as `electron
    --remote-debugging-pipe --user-data-dir=<profile> <workspace>`, which is
    what `electron .` would run, with the chat's workspace as its working
    directory. Only this kind has window tools.
  - **Project action** (`action`) runs one of the project's reviewed actions
    (**Settings → Projects → Actions**) with its own executable and arguments,
    from the chat's workspace. It has process tools only: status, logs and
    stop.
- Every Electron launch gets a new, empty, owner-only (0700) profile folder
  under Inertia's runtime data folder in `app-under-test/<launchId>`, passed
  as `--user-data-dir`. Electron's own profile data (cookies, local storage,
  caches, preferences) is therefore isolated from the user's real profile of
  the same app. Nothing else is isolated: `HOME` and the `XDG_*` folders are
  passed (see the security boundary), so the app's own code can read and
  write the user's files as it would outside Inertia. The profile folder is
  deleted once the launch's process tree is proved gone. There is no setting
  to use the real profile.
- The App session is runtime memory. Launches, logs, windows and evidence are
  never written to the application database, attachments, diagnostics or the
  repository. Archiving or deleting the chat, removing its project, and
  quitting Inertia stop every launch of the chat and clear its session.
  Deleting a chat or removing a project waits until every launch is proved
  stopped before it removes a worktree or the chat; when that cannot be
  confirmed, it is refused like a delete with an active run, and the chat and
  its checkout stay. Switching chats, closing the App surface or closing the
  panel does not stop anything.
- App tools are injected into the existing exact-turn host bridge for Codex,
  Claude, Cursor, Kimi Code and OpenCode on their native routes, as the
  Browser tools are. Antigravity, custom backends and imported Codex CLI
  sessions do not receive Inertia host tools. No skill install is required.

## Agent tools

The pack `inertia.app-under-test` (revision 1) exposes one tool per action.
Each schema is a flat strict object whose required arguments are exact, so
every provider transport advertises the arguments the runtime validates.

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `inertia_app_launch` | `kind` (`electron` or `action`), `actionId` exactly when `kind` is `action` | Start the app and return its `launchId`, `pid`, `state`, `cdp`, its windows once the first one opens (Electron, up to 60 seconds), the last 20 log lines and a `nextStep`. |
| `inertia_app_status` | optional `launchId` | List the chat's launches with kind, label, who started each, state, exit code or signal, `uptimeMs`, `cdp`, window count and whether cleanup was confirmed. |
| `inertia_app_logs` | `launchId`, optional `cursor`, `limit` (1 to 200, default 100), `grep` | Read the launch's log. Without `cursor` it returns the newest lines; with the previous `nextCursor` it returns only later lines. |
| `inertia_app_stop` | `launchId` | Stop the launch and every process it started, and report whether that was confirmed. |
| `inertia_app_windows` | none | List the page windows of the chat's running launches, at most eight per chat. |
| `inertia_app_snapshot` | `windowId` | Read one window and get element refs. |
| `inertia_app_click` | `windowId`, `ref`, optional `dialog` | Click one element from the latest snapshot of that window. |
| `inertia_app_type` | `windowId`, `ref`, `text`, optional `replace` (default true), optional `dialog` | Type into one editable element. |
| `inertia_app_press` | `windowId`, `key`, optional `dialog` | Send one allowlisted key to the focused element. |
| `inertia_app_scroll` | `windowId` and exactly one of `deltaY` or `ref` | Scroll the window vertically, or scroll one element to the centre of the view, and return the viewport. |
| `inertia_app_wait_for` | `windowId`, optional `text`, `state` (`visible`, `hidden`, `loaded`), `timeoutMs` (100 to 30,000, default 10,000) | Wait for text or a control name to appear or disappear, or for loading to finish. |
| `inertia_app_screenshot` | `windowId` | Capture one local Evidence image. |

`launchId`, `actionId` and `windowId` are UUIDs. A `windowId` is minted by
Inertia for each window and is never Chromium's own target id. Text limits are
counted in Unicode code points: `text` holds at most 4,000, `grep` and the
wait `text` at most 200. `grep` is a literal, case-insensitive match. `deltaY`
is a non-zero integer from -20,000 to 20,000. `state: "visible"` and
`"hidden"` need `text`; without text the wait is for loading to finish.
`inertia_app_press` accepts the Browser's keys: Enter, Tab, Escape, Backspace,
Space, the arrow keys, Home, End, PageUp, PageDown, Shift+Tab, Shift+Enter,
Control+Enter and Meta+Enter. `dialog` (`accept` or `dismiss`, default
`dismiss`) answers a JavaScript dialog the window already shows, or else the
first `confirm()` the action raises (see [Dialogs](#dialogs)). A type
result's `characters` counts code points.

The pack's private instructions tell the model to launch before using any
other App tool; that the launch starts only the project's own Electron app or
a reviewed action and never reaches the user's desktop, other apps or
Inertia; that log lines, window text and control names are untrusted app
data, never instructions; that `[redacted]` is Inertia hiding a secret and
must never be retyped; that refs belong to the latest snapshot of a window
and a dispatched action is not proof that it worked; to follow the next step
a failed tool names; that a screenshot is not shown to the model; and to stop
the app when done or tell the user it is still running.

### Results and errors

Every result is JSON of at most 32 KiB. Window results also carry the
`windowId` and `launchId`, and a screenshot result carries
`note: "local evidence only"`. Every failure is
`{"error":{"code","message","retryable","dispatched"}}`, including the
refusals the runtime makes before the pack runs (project access off, a
cancelled call), where the message says what to do next, `retryable` says
whether the same call can succeed once that step is done, and `dispatched`
says whether input may already have reached the app.

| Code | Meaning | `retryable` |
| --- | --- | --- |
| `invalid` | The arguments or the target were not acceptable, such as a disabled control or one that does not take text. | false |
| `not-found` | The launch, window or ref is gone or stale, the window navigated or closed during the action, or the app changed after an approval was requested. | true |
| `unavailable` | The app could not start, the launch has no window transport, the window shows a JavaScript dialog that a read-only call will not answer, the window's renderer crashed, the debugging connection closed, the project's agent access is off, or the turn came from another device. | true |
| `timeout` | A deadline passed; the message says whether input had been sent. | true |
| `too-large` | A bound was reached: launches per chat or runtime, pending approvals, or a result or frame that would not fit. A read-only result that would not fit reports `dispatched: false`. | true |
| `cancelled` | The turn cancelled the call. A cancelled launch is stopped. | false |
| `approval_expired` | A Supervised approval was not answered within five minutes. Nothing was sent. | true |
| `sensitive` | Window content is withheld for privacy (see below). | false |
| `user_denied`, `call_cancelled`, `unknown_tool`, `invalid_owner` | The runtime refused the call before it reached the app. | false |

`dispatched` is false for every refusal before input, for every read-only
call and for `approval_expired`. It is true when a click, key, text or scroll
had been sent, or an open dialog had been answered, for example a `timeout`
after the input, and in that case the agent is told to take a snapshot before
repeating the action. When an action's input reached
the app and the app answered by loading a new page or closing the window, the
result is a success with `navigated: true` or `windowClosed: true` and a
`nextStep`.

## Windows and snapshots

The window transport is a small client for the Chrome DevTools Protocol over
the Electron debugging pipe (file descriptors 3 and 4). It discovers targets,
attaches to `page` targets only, skips DevTools and other internal pages
(`devtools:`, `chrome:`, `chrome-extension:` and similar addresses), and
treats each page as one window. A window whose page later turns into such an
internal page is removed. At most eight windows are attached per launch; a
further page waits and is attached when one closes. `inertia_app_windows`
lists at most eight windows per chat. Each window gets a stable number when
it first appears ("App window 1", "App window 2"...), which is not reused
while the launch runs. Window titles are sanitized, redacted and cut to 120
characters, and a page that has not set a title is listed as "App window".
Only the origin of a window's address is reported (`file://` for local
files); paths, queries and fragments never leave the runtime. `active` marks
the window the agent used most recently, not the window the operating system
has focused.

Snapshots run the Browser's own semantic snapshot and ref scripts in a CDP
isolated world that Inertia creates for each main-frame document, so the
page's scripts can neither read nor forge Inertia's state. The shape and
bounds match `docs/AGENT_BROWSER.md`: at most 200 rendered interactive
elements with refs (`e1`, `e2`...), 12,000 characters of visible text, the
viewport, `omitted` and `nextStep` when something was left out, `notInspected`
for frames and shadow roots, and structural reduction to fit the result
bound. A blank window returns `{"blank":true,"nextStep":...}`. Refs belong to
one document: each main-frame navigation increments a document sequence and
drops the world, refs and remembered values.

Clicks move the pointer to the element's centre, wait a frame, locate it
again and only then press and release, so a moving target is refused rather
than missed. A click or type on an element outside the viewport first scrolls
it to the centre from the isolated world. If a call is cancelled or reaches
its deadline after the press, the release is still sent, so the app is never
left with its button held down. Typing focuses the element (and selects its
content when replacing) and inserts the text in one `Input.insertText`, which
fires input events but no per-character key events. Text for a password or
credential-named field is remembered before anything is focused, selected or
inserted, so an app that echoes it at once into its console or title is
already redacted. Enter and Space use the Browser's guarded activation path
and are refused while focus is inside a frame or a closed shadow root.

### Dialogs

A JavaScript dialog blocks its window's renderer, so nothing can be read from
the window while one is open. Dialogs are answered over the protocol, and the
answer is awaited (with one retry); the dialog counts as open until the app
acknowledges it.

- Read-only calls never answer a dialog. While a window shows one, snapshot,
  wait, screenshot, the window list and the inspection that prepares a
  Supervised approval fail at once with `unavailable`, `retryable: true` and
  `dispatched: false`. The message names the dialog's kind, never its text,
  and says to answer it with the next click, type or press using
  `dialog: "accept"` or `"dismiss"`. A dialog that opens while a read-only
  call runs is left open, and the call fails the same way if it had not
  finished.
- A click, type, press or scroll answers a dialog the window already shows
  before it sends anything, as its `dialog` argument says (scroll and an
  omitted argument dismiss). That spends the action's one accept.
- A `confirm` raised by the action itself is accepted only when the action
  passed `dialog: "accept"` and had not spent it; other confirmations and
  prompts it raises are dismissed, alerts are accepted, and `beforeunload` is
  accepted.
- A dialog the app raises on its own is left for the user or the agent's
  next input. Only a dialog with no app UI to answer it
  (`hasBrowserHandler: false`) is answered at once: an alert is accepted,
  anything else is dismissed.

The next result reports answered dialogs once as
`dialogs: [{"kind","message","answer"}]`, redacted and bounded as in the
Browser.

### What differs from the Browser

- Snapshots carry no `inertiaAudit` object.
- There is no main-world privacy guard. The Browser installs one before page
  scripts run and watches value accessors; an Electron app's pages run their
  own code first, so Inertia learns sensitive values only when it scans a
  document (snapshot, wait, screenshot) or types into a field. Password
  fields and credential-named fields still report `[redacted]`, using the
  Browser's field rules. A value found by a scan, or typed by the agent into
  such a field, is remembered for that document in the isolated world and
  handed to the runtime over an internal field that never appears in a tool
  result. The runtime keeps it for the window's document and, for the whole
  launch, for its log and titles: at most 256 values of at most 4,096
  characters each, never evicting one to make room. It is replaced with
  `[redacted]` in later snapshots, titles, control names, dialog messages and
  approval labels, and in every log line the launch appends afterwards
  (`stdout`, `stderr`, `console`, `exception`, `crash`). Matching is the
  Browser's: a value of four or more characters anywhere, ignoring case
  (including its JSON- and URL-encoded forms), and a shorter value only as a
  whole word. Lines logged before a value was learned are not rewritten, and
  a value a page script places in a field and removes again between two
  scans is never seen.
- Screenshots are withheld (`sensitive`) while the document holds any
  remembered secret, while a sensitive field shows a value, and whenever a
  snapshot would be withheld. Chromium renders the capture already reduced to
  a thumbnail of at most 512 by 320 pixels and 256 KiB, so the full-size
  bitmap never reaches the runtime. The result reports the window's CSS width
  and height and an `evidenceId`; no provider receives pixels.
- There is no user-takeover detection. Clicking or typing in the real app
  window does not interrupt an agent action or set `controller: "user"`.
  Clicking or typing in the App surface's log or window list does nothing to
  the app.
- There is no navigation tool. The app navigates itself; the agent observes
  the result.

## Permission behavior

Status, logs, windows, snapshots, waits and screenshots are read-only and never
ask.

`inertia_app_launch` asks in Supervised and Auto-edit chats, for both kinds,
because a launch runs the project's code with the user's permissions and
Auto-edit allows supported file edits only. Only Full Access launches without
asking. The Electron card says "Start this project's Electron app with an
isolated profile. It runs this project's code with your user permissions,
and the agent can read its output and use its windows."; an action card
names the action.

In a Supervised chat, stop, click, type, press and scroll also each create one
ordinary Inertia approval tied to the exact tool call; Auto-edit and Full
Access run them without asking. The card title comes from a fixed table
("Launch the app", "Stop the app", "Click", "Type", "Press", "Scroll"). The
detail names "App window N" by the number the window got when it first
appeared, never by its title, plus the sanitized role and label of the target
control: the ref's control for click, type and scroll, and the focused
control for press. A sensitive field is named "Sensitive field" and the text
typed into it is hidden. When the action passes `dialog: "accept"`, the
detail says so.

An approval is bound to the chat, the action, the launch and its process id,
the window, the document sequence, the ref, the inspected control (for a
press, the focused control) and whether a dialog was open. Before an input
approval is shown, the target is inspected without changing the app. After
approval the binding is checked again, and if the launch, window, document,
control or dialog changed, nothing is sent and the call fails with
`not-found`.

A window that shows a JavaScript dialog cannot be inspected. A Supervised
input on such a window therefore asks only to answer that dialog: "App window
N / Answer the app's open dialog (accept|dismiss) only. The click is not sent:
the control cannot be checked while the dialog is open." Once approved,
Inertia answers the dialog, sends nothing else, and returns `sent: false` with
a next step to take a new snapshot and ask again. An approval
not answered within five minutes fails with `approval_expired` and
`dispatched: false`. In a Supervised chat an off-screen click or type target
is not scrolled into view to prepare the card; the agent is told to scroll it
with `inertia_app_scroll` first.

Stopping a launch the user started from the App surface asks the user in
every access mode.

**Settings → Projects → Agent app access** turns the agent's App tools off
for one project; every App tool call then fails with `unavailable`. The
default is on. The setting does not affect launches the user starts from the
App surface.

A turn whose source message was sent from a Private Connect device receives
`unavailable` with "App tools are unavailable for turns sent from another
device." on every App tool, because the desktop may be unattended.

Each tool states whether it only reads or whether it changes something:
status, logs, windows, snapshot, wait and screenshot carry `readOnlyHint`
and `idempotentHint`; launch, stop, click, type, press and scroll carry
`destructiveHint` on Claude and OpenCode, and `destructiveHint: false` on
Cursor and Kimi Code, for the reasons given in `docs/AGENT_BROWSER.md`. Every
App tool carries `openWorldHint: false`. Codex receives dynamic tools, which
carry no annotations.

## The App surface

Open **App** from **Open a surface** (press L in the empty panel) or from the
panel's add-surface menu. It is available once the chat's first message has
created its workspace.

- **Launch Electron app** starts the project's Electron app. **Launch
  action…** lists the project's reviewed actions by name; scratch chats have
  none. Both are disabled while the runtime is reconnecting and while the
  chat already runs two launches. A launch that Inertia refuses, for example
  because the workspace has no `node_modules/electron`, shows the reason
  under the toolbar.
- **Launches** lists each launch with its state, kind, who started it, its
  process id, uptime or run time, and exit code or signal. **Stop** ends the
  launch and its whole process tree. Stopping a launch you started asks you
  to confirm first; stopping one the agent started does not. A launch whose
  cleanup could not be confirmed says so.
- **Logs** shows the selected launch's log with a stream tag on each line, a
  filter, **Copy lines** (or **Copy selection**) and **Jump to latest** when
  you scroll away from the end. Gaps left by skipped or evicted lines are
  marked. A screen reader hears a summary of new lines at most every two
  seconds.
- **Windows** lists the open windows of running launches with their title,
  origin, and whether each is active or loading. Titles and origins are shown
  as plain text. Window changes arrive live at most every 500 milliseconds,
  only while the chat is subscribed and only when the list changed; they are
  not replayed, so the surface rereads the launch list, which carries each
  launch's windows, when it opens or reconnects.
- **Evidence** lists launches, the first window opening, exits, agent actions
  and screenshot thumbnails, newest first, with fixed labels. It stays on the
  device and clears with the chat's App session.

## Logs

Each launch has one log of at most 64 KiB and 2,000 lines, keeping the newest
lines. A line longer than 4 KiB is cut at a code point boundary and ends with
` [line cut]`. Control characters other than tab are removed, ANSI escape
sequences are removed whole, and every line gets a cursor that increases by
one and is never reused. Each line carries a stream:

| Stream | Source |
| --- | --- |
| `stdout`, `stderr` | The process's own output. |
| `console` | Renderer console calls and Chromium log entries, read from the debugging pipe (Electron launches). |
| `exception` | Uncaught renderer exceptions (Electron launches). |
| `crash` | "App window N crashed." when a renderer crashes (Electron launches). |
| `inertia` | Inertia's own fixed notes: who launched it, how it stopped or exited. |

For Electron launches the renderer console comes from the debugging pipe; for
action launches it is whatever the process writes to stdout and stderr.
Console, exception and Chromium log events are limited per launch to 200 a
second with bursts of 400; the excess is counted and an `inertia` line
"N console events dropped." is added at most once a second. Every line is
redacted with the secrets the launch's windows revealed so far (see above)
before it is stored.
`inertia_app_logs` returns at most 4 KiB per call; `truncated: true` means
matching lines were left for the next call, and `dropped` counts lines evicted
before they were read. The App surface receives new lines in batches every
250 milliseconds, at most 64 lines and 8 KiB per batch, only while that chat
is subscribed, and rereads the log when it opens or reconnects. Log lines are
the app's output and are untrusted data.

## Process ownership and cleanup

Launches are spawned with `runtimeOwnedProcessInvocation` and
`spawnRuntimeOwnedProcess`, the same ownership terminals and restricted CLI
runs use: on Linux and macOS a process guardian and a process group, on
Windows a job object, all recorded in the ownership journal. Stop, chat
archive or delete, project removal, a cancelled launch call and runtime
shutdown terminate the whole tree and wait for proof that it is gone; chat
delete and project removal wait for that proof before they touch a worktree.
`cleanupConfirmed` reports that proof. When it is false, Inertia reports
unconfirmed cleanup the way it does for other owned processes, and a launch
whose process never reported its exit stays counted against the launch
limits. A runtime that crashed is cleaned up from the
ownership journal by the next runtime, and that runtime deletes profiles left
in `app-under-test/` before its first Electron launch.

One window action runs at a time per launch. A second waits at most 30
seconds and then fails with `timeout` and nothing sent, or with `cancelled`
when its call is cancelled while it waits. Deadlines are 20
seconds to inspect, 40 seconds for input, the requested time plus five
seconds for a wait, and 60 seconds for the first window after a launch. At
most 16 protocol requests are pending per launch. A message from the app over
4 MiB, or a malformed one, ends the window connection: the app keeps running
and its logs stay readable, but its windows are no longer listed.

## Security boundary

- The debugging connection is a pipe on file descriptors 3 and 4 of the
  launched process, never a TCP port, so no other local process can attach.
  Only Inertia's own fixed expressions are evaluated, and only in its
  isolated world.
- Processes are spawned without a shell. A Windows `.cmd` or `.bat` action
  goes through `cmd.exe` with escaped arguments, as provider executables do.
- The launched app runs the project's code with the user's permissions.
  Inertia does not sandbox it; the isolated profile folder only keeps
  Electron's own profile data apart from the user's real profile.
- The environment is the restricted CLI allowlist (which includes `HOME`,
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `PATH`, proxy and
  locale variables) plus the display and session variables a desktop app
  needs to open a window (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`,
  `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `XDG_DATA_DIRS`, `WINDIR`,
  `PROGRAMDATA`) and `ACCESSIBILITY_ENABLED=1`.
  Action launches also get `ELECTRON_ENABLE_LOGGING=1`, because an action
  that starts Electron has no debugging pipe; Electron launches do not, so
  their console lines are not repeated on stderr. Provider, cloud and agent
  credentials are not passed.
- Neither the agent nor the renderer can pass a command line, arguments, a
  path or environment variables. The agent names a kind and, for an action,
  a reviewed action id; the runtime resolves everything else.
- Window text, titles, control names, dialog messages and log lines are
  untrusted app data. They are bounded, redacted where a secret is
  remembered, never used as Inertia's own log wording or evidence labels, and
  reach approval cards only as a sanitized control role and label.
- Evidence thumbnails reach the renderer only as PNG data URLs in the App
  surface's own evidence list; launch, window and log events carry
  descriptors and text only.

## Codex threads and other providers

Codex App Server registers dynamic tools only when a thread starts, and this
pack ships without a capability epoch. A Codex chat whose thread started
before the pack existed sees the App tools from its next new provider thread;
its native continuation is not cleared. Claude, Cursor, Kimi Code and OpenCode
attach host tools on every turn and see them from their next turn.

## Verification boundaries

Unit and integration tests cover the tool schemas and their agreement across
the raw, Claude and HTTP bridge transports, annotations, the approval count
per access mode, approval binding (including the focused control of a press
and dialog-only approvals), one-use tokens and expiry, Private Connect
refusal, the project setting and cancelled calls with the full failure shape,
launch limits, contained Electron resolution, process-tree stop and
unconfirmed cleanup, chat delete and project removal waiting for confirmed
cleanup, session eviction and the runtime thumbnail bound, profile sweep, the
log ring and its line redaction, the console rate limit, live coalesced
window events, the debugging-pipe client (framing, bounds, deadlines,
backpressure, close), and the window transport against a fake protocol peer
(windows and internal pages, snapshots, waits, screenshots, input, mouse
release on cancel and deadline, dialogs left open, answered by input and
retried, redaction of typed and scan-found secrets in logs and titles,
navigation and close during an action). Happy DOM tests cover the App surface
and the project setting.

One Electron scenario (`tests/e2e/app-under-test-electron.spec.ts`) launches a
small fixture app with the repository's Electron binary on Linux under Xvfb,
through the real launch manager, debugging-pipe transport and App tools in a
Supervised chat with approvals answered by the test. It waits for the window,
lists it, takes snapshots (the password field reports `[redacted]`), clicks a
button, types into a text field, accepts a confirmation dialog, captures a
thumbnail, types into the password field and checks that the typed value never
appears, reads console lines from the log, and stops the app with confirmed
cleanup. It runs as root with `--no-sandbox`, and it supplies the Electron
binary directly instead of resolving the fixture's own `node_modules/electron`;
that resolution is covered by unit tests only.

Not exercised:

- macOS and Windows launches, including Windows job-object cleanup of an
  Electron tree and `.cmd` actions;
- Electron running as a non-root user with its sandbox on;
- key presses and scrolling in a real app (unit tests use a fake peer);
- a dialog the app raises on its own, read-only calls failing on it and the
  next input answering it, and dialog-only Supervised approvals (fake peer and
  unit tests only);
- secrets found by a scan being hidden from real log lines and titles, the
  console rate limit and session eviction (unit tests only);
- several windows of one launch, and more than eight;
- renderer crashes, an app that crashes on start, and a runtime crash with a
  live launch;
- Wayland sessions;
- the full Inertia desktop path from a provider turn through to the App
  surface; the README-style screenshots are produced by
  `scripts/capture-app-under-test-screenshots.mjs`, which uses the App
  surface directly.

## Not in this release

- Native (non-Electron) window inspection and control through accessibility
  APIs.
- Screenshots visible to the model.
- Synthesized operating-system input (mouse, keyboard or drag outside the
  debugging protocol).
- Attaching to an app that is already running, or to a window the user picks.
- Launching package scripts. They need a shell or a package manager; add a
  project action instead.
