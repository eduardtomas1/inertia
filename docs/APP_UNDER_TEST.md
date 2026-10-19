# App under test

The App under test lets the user and the coding agent run the desktop
application a chat is building, read its output, see its windows, drive them,
keep local evidence, and stop it. It is not general desktop automation: the
only processes the App tools act on are the ones Inertia launched for that
chat, and the only windows are the windows of those processes: the page
windows of an Electron launch, or the native windows of a project action's
process tree (see [Native windows](#native-windows-accessibility-transport)). The user's
desktop, the foreground application, other copies of the app, and Inertia
itself are never targets of an App tool. The launched app is not sandboxed by
Inertia: it runs the project's own code with the user's permissions, like any
program the user starts.

Two parts are off or gated by default. A project can let the agent see
reduced, masked screenshots of its app (see
[Screenshots sent to the agent](#screenshots-sent-to-the-agent)), and a
native window can receive synthesized keys and wheel scrolling only after the
user approves bringing it to the front (see
[Synthesized input](#synthesized-input)).

![The App surface with a running Electron app, its log and its window](screenshots/inertia-app-under-test-dark.png)

## Product contract

- Every chat has one App session, owned by the supervised local runtime like
  the chat's terminals. A chat runs at most two live launches and the runtime
  at most eight across all chats. A launch that exits stays listed with its
  exit status and the newest lines of its log; a chat keeps at most eight
  launches and drops only the oldest launches proved stopped. A launch
  whose process tree was not proved gone is never dropped: when all eight
  are running or unconfirmed, a new launch is refused (`too-large`) until
  one is stopped or confirmed.
- The runtime keeps at most 16 App sessions whose chats have no live launch,
  and at most 16 MiB of screenshot thumbnails across all chats. Beyond either
  bound it forgets the least recently used of those idle sessions, with its
  logs and evidence, and the App surface hears `session.cleared`. A session
  with a live launch, or with a launch whose cleanup is unconfirmed, is never
  forgotten this way; the thumbnails of those unconfirmed sessions are not
  bounded by the eight live launches, so they can push the total past 16 MiB
  until their cleanup is confirmed.
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
    directory. Its windows are served over the debugging pipe
    (`transport: "cdp"`).
  - **Project action** (`action`) runs one of the project's reviewed actions
    (**Settings → Projects → Actions**) with its own executable and arguments,
    from the chat's workspace. Status, logs and stop always work; its native
    windows are served through the operating system's accessibility API
    (`transport: "accessibility"`) when the desktop allows it.
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
  Archiving or deleting a chat or removing a project waits until every launch
  is proved stopped before it archives the chat or removes a worktree or the
  chat; when that cannot be confirmed, it is refused like a delete with an
  active run, and the chat and its checkout stay. The session then also
  stays, with its launches, logs and evidence, so the launch can still be
  inspected and stopped; it is cleared once a later stop or clear proves
  every launch gone. Switching chats, closing the App surface or closing the
  panel does not stop anything.
- App tools are injected into the existing exact-turn host bridge for Codex,
  Claude, Cursor, Kimi Code and OpenCode on their native routes, as the
  Browser tools are. Antigravity, custom backends and imported Codex CLI
  sessions do not receive Inertia host tools. No skill install is required.

## Agent tools

The pack `inertia.app-under-test` (revision 2) exposes one tool per action.
Each schema is a flat strict object whose required arguments are exact, so
every provider transport advertises the arguments the runtime validates.

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `inertia_app_launch` | `kind` (`electron` or `action`), `actionId` exactly when `kind` is `action` | Start the app and return its `launchId`, `pid`, `state`, `cdp`, `transport` (`cdp`, `accessibility` or null), its windows once the first one opens (up to 60 seconds for either transport), the last 20 log lines and a `nextStep`. |
| `inertia_app_status` | optional `launchId` | List the chat's launches with kind, label, who started each, state, exit code or signal, `uptimeMs`, `cdp`, `transport`, window count and whether cleanup was confirmed. |
| `inertia_app_logs` | `launchId`, optional `cursor`, `limit` (1 to 200, default 100), `grep` | Read the launch's log. Without `cursor` it returns the newest lines; with the previous `nextCursor` it returns only later lines. |
| `inertia_app_stop` | `launchId` | Stop the launch and every process it started, and report whether that was confirmed. |
| `inertia_app_windows` | none | List the windows of the chat's running launches, at most eight per chat, and how many apps in their process trees are protected (`protectedApps`). |
| `inertia_app_snapshot` | `windowId` | Read one window and get element refs. |
| `inertia_app_click` | `windowId`, `ref`, optional `dialog` | Click one element from the latest snapshot of that window. |
| `inertia_app_type` | `windowId`, `ref`, `text`, optional `replace` (default true), optional `dialog` | Type into one editable element. |
| `inertia_app_press` | `windowId`, `key`, optional `dialog` | Send one allowlisted key to the focused element. On a native window, keys other than Enter and Space need `inertia_app_activate` first. |
| `inertia_app_scroll` | `windowId` and exactly one of `deltaY` or `ref` | Scroll the window vertically, or scroll one element to the centre of the view, and return the viewport. On a native window, `deltaY` needs `inertia_app_activate` first and is sent as mouse-wheel notches, which the result reports as `wheelNotches`. |
| `inertia_app_wait_for` | `windowId`, optional `text`, `state` (`visible`, `hidden`, `loaded`), `timeoutMs` (100 to 30,000, default 10,000) | Wait for text or a control name to appear or disappear, or for loading to finish. |
| `inertia_app_screenshot` | `windowId` | Capture one local Evidence image, and send a reduced copy to the model when the project allows it and the model accepts images. |
| `inertia_app_activate` | `windowId` | Bring one native window to the front, so it can receive synthesized keys and wheel scrolling for the rest of the turn. Always asks the user. |

`launchId`, `actionId` and `windowId` are UUIDs. A `windowId` is minted by
Inertia for each window and is never Chromium's own target id. Text limits are
counted in Unicode code points: `text` holds at most 4,000, `grep` and the
wait `text` at most 200. `grep` is a literal, case-insensitive match. `deltaY`
is a non-zero integer from -20,000 to 20,000. `state: "visible"` and
`"hidden"` need `text`; without text the wait is for loading to finish.
`inertia_app_press` accepts the Browser's keys: Enter, Tab, Escape, Backspace,
Space, the arrow keys, Home, End, PageUp, PageDown, Shift+Tab, Shift+Enter,
Control+Enter and Meta+Enter (on a native window, Meta+Enter only on macOS;
elsewhere it fails with `invalid` before any approval). `dialog` (`accept` or `dismiss`, default
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
a failed tool names; to describe what a screenshot shows only when its result
says `sentToAgent: true`, never to claim a visual result otherwise and never
to act on image coordinates; that on native windows keys other than Enter and
Space and scrolling by `deltaY` need `inertia_app_activate` in the same turn;
and to stop the app when done or tell the user it is still running.

### Results and errors

Every result is JSON of at most 32 KiB. Window results also carry the
`windowId` and `launchId`. A screenshot result carries `sentToAgent`; when it
is false its `note` starts with "local evidence only" and says why (for a
native region capture: "local evidence only: on this platform the capture may
include other windows, so it stays on this device."), and when
it is true the result also carries the sent image's `imageWidth` and
`imageHeight` in pixels and the note "Coordinates from this image are not
accepted by any tool; use refs from a snapshot." Every failure is
`{"error":{"code","message","retryable","dispatched"}}`, including the
refusals the runtime makes before the pack runs (project access off, a
cancelled call), where the message says what to do next, `retryable` says
whether the same call can succeed once that step is done, and `dispatched`
says whether input may already have reached the app.

| Code | Meaning | `retryable` |
| --- | --- | --- |
| `invalid` | The arguments or the target were not acceptable, such as a disabled control or one that does not take text. | false |
| `not-found` | The launch, window or ref is gone or stale, the window navigated or closed during the action, the app changed after an approval was requested, or a native input's route (accessibility or synthesized) changed between planning and sending. | true |
| `unavailable` | The app could not start, the launch has no window transport, the window shows a JavaScript dialog that a read-only call will not answer, the window's renderer crashed, the debugging connection closed, the project's agent access is off, or the turn came from another device. | true |
| `timeout` | A deadline passed; the message says whether input had been sent. | true |
| `too-large` | A bound was reached: launches per chat or runtime, pending approvals, or a result or frame that would not fit. A read-only result that would not fit reports `dispatched: false`. | true |
| `cancelled` | The turn cancelled the call. A cancelled launch is stopped. | false |
| `approval_expired` | A Supervised approval was not answered within five minutes. Nothing was sent. | true |
| `sensitive` | Window content is withheld for privacy (see below). | false |
| `screenshot_limit_reached` | The turn already sent eight screenshots to the model. | false |
| `repeated_failure` | The same call failed three times in a row this turn, or three clicks, types, presses or scrolls in a row changed nothing visible (see [Progress guard](#progress-guard)). | false |
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
  and height and an `evidenceId`. Pixels reach the model only as described in
  [Screenshots sent to the agent](#screenshots-sent-to-the-agent).
- There is no user-takeover detection. Clicking or typing in the real app
  window does not interrupt an agent action or set `controller: "user"`.
  Clicking or typing in the App surface's log or window list does nothing to
  the app.
- There is no navigation tool. The app navigates itself; the agent observes
  the result.

## Native windows (accessibility transport)

A project action launch has no debugging pipe, so its windows (a GTK, Qt,
WinUI, AppKit or Electron app started by the action) are read and driven
through the operating system's accessibility API with the `@crowecawcaw/xa11y`
binding Inertia already ships for Snapshots. The same tools, schemas,
annotations, results, error codes and approvals apply; the launch and
status results say `transport: "accessibility"`, and `inertia_app_launch`
waits up to 60 seconds for the first native window as it does for an Electron
page. Electron launches always keep the debugging-pipe transport.

### Where the native work runs

The runtime never loads the native binding. It sends one strictly parsed
request per tool step to the Electron main process over the same supervised
channel the Browser uses (`runtime.app-control-request`, `-cancel`,
`-result`): exact keys, UUID request ids, opaque window and control tokens
minted by the worker, and every request carries the chat, run, turn, launch,
the launch's process id and the time the runtime recorded just before it
spawned the launch. Payloads are bounded at 24 KiB (a screenshot thumbnail of
at most 256 KiB travels beside it), at most 16 requests are pending per
runtime, and each has a 90-second backstop; a cancelled or timed-out call is
cancelled in main too. Main remembers the last 512 request ids of each
runtime process and refuses a reused one, cancels only when the runtime and
every identity field match, drops results meant for a runtime that was
replaced, and aborts everything of a runtime that stops.

Main's App control service runs the native calls in its own utility process,
"Inertia App Control", with the same allowlisted environment as the Snapshots
helper. It runs one command at a time under a watchdog of 10 seconds for
reads and 20 seconds for actions and screenshots. A worker that times out,
crashes, answers with a malformed message or reports a native failure is
killed and a fresh one starts with the next command; if its exit is not
confirmed within three seconds it is killed by force (`SIGKILL`), and if that
exit is not confirmed within two more seconds, App control stays off until
Inertia restarts and quitting reports the cleanup as unconfirmed. A worker
that fails to become ready three times in a row latches App control off
(`native-failure`, "App control could not start; restart Inertia or check
Settings → Devices & integrations → App control") until the App control card
probes it again or Inertia restarts; meanwhile the launch shows the
`start-failed` gate and polls at the gated ten-second interval. An idle
worker exits after a minute. Each command waits on one exit promise per
worker and removes its own listeners when it completes. A hang or crash in
the native binding therefore never reaches the runtime or Inertia's
windows. Failures cross the boundary as fixed categories only
(`permission-denied`, `helper-permission-denied`, `accessibility-unavailable`,
`not-found`, `denied`, `native-failure`, `timeout` and the protocol's own
`invalid`, `unavailable`, `unsupported`, `elevated`, `cancelled`, `sensitive`,
`busy`); no native message text, window title or control name reaches a log.
The runtime turns each category into the pack's error codes with fixed
wording and a next step.

### Scope: the launch's own process tree

Every command first resolves the live process tree under the launch's
process, and every member carries its own start time: on Linux from `/proc`
(each process's `stat` start time in clock ticks plus the boot time) without
starting a process, on macOS in the worker from libproc
(`proc_listchildpids` from the root down, then `proc_pidinfo` for each
process's parent and start time, to microseconds, and `proc_pidpath` for its
executable, without starting a process or reading any other part of the
process table), and on Windows from a Toolhelp32 snapshot in the worker with
`GetProcessTimes` for every process under the root. The root must still be
the process the runtime spawned: its start time has to lie between two
seconds before and fifteen seconds after the time the runtime recorded just
before the spawn, and a root whose start time cannot be read counts as gone.
The root must also be a direct child of the runtime process that sent the
request (main checks the root's parent against the runtime's process record).
Otherwise the command fails with `not-found` and "That launch is no longer
running". Each descendant is compared with its direct parent: one that
started before its parent is a reused process id, and one whose start time
cannot be read is not trusted, so either is dropped with its whole subtree.
A tree of more than 1,024 processes is not read in part: the command fails
with `unavailable` and "the app's process tree is too large to check". A
resolved tree is reused for one second. The worker then looks up the
accessibility application of each process in the tree (`App.byPid`, or one
filtered `App.list()` for a tree of more than 16 processes), and then their
windows; a window of any other process is never listed and is `not-found` if
a token names it.

Inside the tree, App control never reads or acts on an application whose
name, bundle id or executable base name is a password manager or a system
credential, consent or settings surface: 1Password (and its `op` CLI),
Bitwarden, Dashlane, LastPass, KeePass and its variants, Keychain Access,
Passwords, System Settings and System Preferences, SecurityAgent,
UserNotificationCenter, loginwindow, Windows Credential Manager
(`CredentialUIBroker.exe`), `consent.exe`, `LogonUI.exe`, Git Credential
Manager and its `GitHub.UI` and `Atlassian.Bitbucket.UI` helpers, every
`ssh-askpass` and `SUDO_ASKPASS`-style helper (`ssh-askpass`, `ksshaskpass`,
`x11-ssh-askpass`, `lxqt-openssh-askpass`, `gnome-ssh-askpass` and any other
name containing "askpass"), `pinentry` and its variants, `gnome-keyring`,
`kwalletmanager`, `kwalletd`, `ksecretd`, `secret-tool`, Seahorse and polkit
authentication agents, and Inertia's own processes. A process of the tree
whose executable cannot be read is treated the same way. Such an application
is counted once in `protectedApps` in `inertia_app_windows`, without a window
id, and its windows are not read. There is no setting to override the list
(`src/shared/app-control-denylist.ts`).

### Windows, snapshots and refs

Native windows are polled every two seconds (every ten while a permission
gate blocks the launch), but only while the chat has a live subscriber (a
renderer showing it) or a turn that can use the App tools is running, and
again whenever the agent lists windows. When the last subscriber leaves and
no turn runs, the next poll does not read or reschedule; a new subscriber or
turn reads at once and resumes the polling. A launch never polled meanwhile
still answers every App tool, which reads what it needs itself. Background
polls carry no turn; the agent's `inertia_app_windows` and the launch's wait
for its first window carry the asking turn. The worker cuts each title to 480
characters and leaves the newest windows out of a list that would not fit
the 24 KiB payload, with an `omitted` count. A launch shows at most eight;
each gets an Inertia window id and a stable number ("App window N") that is
not reused, a sanitized and redacted title of at most 120 characters,
`origin: null` and `loading: false`.

A snapshot walks the window's accessibility tree depth first with at most
4,096 node visits, sixteen levels and three seconds. Interactive controls
(buttons, check boxes, fields, links, list and tree items, menu items, tabs,
sliders and anything that advertises a press, toggle, select or expand
action) become elements with refs `e1`, `e2`..., at most 200, each with its
`role` (xa11y's normalized role name), `name`, `value`, `enabled`, `focused`,
`checked` and `expanded` when known, `editable`, its `rect` relative to the
window and `offscreen` when it lies outside the window or is hidden. The
names and values of other nodes become the visible text, at most 12,000
characters. The worker keeps its answer within 24 KiB by shortening the text
first and then dropping off-screen and later controls, and the result says
what it left out (`omitted`, `nextStep`), as does a walk that hit a bound.
`notInspected: ["unlabelled-regions"]` means the window has content without
any accessible name or value, such as images or custom-drawn areas, that
cannot be read. The viewport is the window's size and there is no `url`. On
Linux a window whose accessibility root has no children is not an empty
snapshot: it fails with `unavailable` and "start the app with
ACCESSIBILITY_ENABLED=1 or --force-renderer-accessibility" (the
`accessibility-tree` gate).

A ref is bound to the control's xa11y `stableId` (or, where the platform
offers none, its position in the tree, its role and its cleaned name, so a
renamed control at the same position is a different control), its process
and its window, and to the window's document sequence. The sequence
increments when the identity of the window's direct children changes, which
is how a replaced content root (a new page, a rebuilt view) shows up; refs of
the older document fail with `not-found` and "take a new snapshot". Ref
numbers keep increasing for the window's lifetime, across documents, and only
`inertia_app_snapshot` hands them out (a wait's reads never do), so a ref
never names a control of another document. A ref whose control disappeared
or was renamed fails the same way.

### Actions

Clicks, text and scrolling a control into view are accessibility actions.
Keys other than Enter and Space, and scrolling by pixels, are synthesized
operating-system input to a window the agent brought to the front (see
[Synthesized input](#synthesized-input)). No pointer click, drag or text is
ever synthesized.

| Tool | Accessibility action |
| --- | --- |
| `inertia_app_click` | `toggle` for a check box, switch or other control with a checked state; `select` for list, tree and table items, tabs and options; `expand` for a disclosure that offers no press; otherwise `press`. |
| `inertia_app_type` | `focus` (best effort), then `setValue` to replace or `typeText` to append. A control that is not editable or is disabled is refused before anything is sent. |
| `inertia_app_press` | Until the window is brought to the front in this turn, Enter and Space press the focused control (with no focused control the press fails with `invalid`), and every other key fails with `unavailable` and "The app is not in front; call inertia_app_activate". After `inertia_app_activate`, every allowlisted key, Enter and Space included, is a synthesized key press. |
| `inertia_app_scroll` | With `ref`, `scrollIntoView` (a no-op on macOS, whose API has none). `deltaY` is synthesized mouse-wheel input at the window's centre after `inertia_app_activate`, and `unavailable` before it. |
| `inertia_app_activate` | The window's accessibility `activate` action; the worker then checks that the window's process came to the front (see below). |
| `inertia_app_wait_for` | Reads a snapshot every 500 milliseconds, without handing out refs, until the text or control name appears or disappears; `loaded` is reached once the window can be read. |
| `inertia_app_screenshot` | See below. |

A Supervised approval works as for Electron windows: before the card is
shown the control is inspected without changing the app, the card names the
fixed title, "App window N" and the control's sanitized role and name (never
the window title), and after approval the control is inspected again. The
action is refused with `not-found` and nothing sent when the document
sequence or the control changed; main then checks the window's root
identity, the control's role and its name once more immediately before it
acts. A press names the focused control. There are no JavaScript dialogs in
native windows, so `dialog` has no effect. An action whose window closed
reports `windowClosed: true`; one after which the window's root changed
reports `navigated: true` with a next step to take a new snapshot. A
`timeout` or a native failure after the action was handed to the platform
reports `dispatched: true`.

### Privacy

Password roles (and macOS secure text fields, AT-SPI password text) and
editable controls whose name words name a credential, by the Browser's word
rules, are sensitive: their value is reported as `[redacted]`, their name as
"Sensitive field" when they have none, and their descendants are not read.
The worker never sends a sensitive control's value to main or the runtime.
Text the agent types into a sensitive control is remembered before it is
sent, per window (at most 256 values) and for the launch's log, and replaced
with `[redacted]` in later snapshot text, control names and values, window
titles and log lines, with the Browser's matching (values of four or more
characters anywhere, shorter ones as whole words). Approval cards hide typed
text for sensitive controls. On Windows a password box is recognized by UI
Automation's `IsPassword` when xa11y reports it (`raw.uia_is_password`) and
otherwise by its name.

Screenshots are withheld (`sensitive`) while any window of the launch holds a
remembered value (a secret typed into one window withholds every window's
screenshots), while a sensitive control holds any value, and when the walk
could not check the whole window or found an editable control without a
position.
Otherwise every editable and sensitive control is masked in the image with
Snapshots' geometry rules before the pixels leave the worker.

### Screenshots

- **macOS** captures exactly that window with `screencapture -l` through the
  Snapshots helper (window-server match by process and bounds, empty
  environment, three-second limit, private capture folder removed with the
  worker) and needs Screen Recording permission.
- **Windows and Linux X11** capture the pixels under the window's bounds, so
  the image can include windows overlapping it; the result says
  `mayIncludeOverlappingWindows: true`. Such a capture is never sent to the
  model (see [Screenshots sent to the agent](#screenshots-sent-to-the-agent)).
- **Wayland** has no capture path and answers `unavailable`.

The worker reduces the masked image to at most 1,024 by 640 pixels (1,536
pixels on its long edge when the model may see a macOS capture; if that larger
copy would exceed the 8 MiB worker bound, the local size is used instead, so it
never costs the thumbnail), and main reduces it with Electron's image codec to
a thumbnail of at most 512 by 320 pixels and 256 KiB before it reaches the
runtime's evidence ledger. The result reports the window's size and an
`evidenceId`. Pixels reach the model only as described in
[Screenshots sent to the agent](#screenshots-sent-to-the-agent).

### Synthesized input

`inertia_app_activate { windowId }` brings one native window to the front
through its accessibility `activate` action. Where the desktop has no
synthesized input (Wayland, a Linux session without an X11 display, macOS
without Accessibility) it fails with `unavailable` before any approval card.
Otherwise it always asks the user, in every access mode ("Bring the app
window to the front", with the fixed detail "App window N / Bring this window
to the front and give it keyboard focus. For the rest of this turn the agent
may send it keys and mouse-wheel scrolling, each asked for separately unless
the chat has Full Access."). After the action the worker reads the foreground
process (as below) for up to 600 milliseconds; when the window's process did
not come to the front (focus-stealing prevention, another window on top), the
result is `activated: false` with a next step saying the operating system kept
the app behind, and nothing is granted. Once the window came forward, it holds
a foreground grant for the rest of that turn only; the grant is forgotten when
the turn settles, an activation that finishes after its turn settled grants
nothing, and another turn has none. Electron windows never need it:
`inertia_app_activate` on one fails with `invalid`.

With the grant, `inertia_app_press` sends every key of the Browser allowlist
(Enter, Tab, Escape, Backspace, Space, the arrow keys, Home, End, PageUp,
PageDown, Shift+Tab, Shift+Enter, Control+Enter, and Meta+Enter on macOS only)
as a key press with xa11y `InputSim`, and `inertia_app_scroll` sends `deltaY`
as mouse-wheel steps at the window's centre: one notch per 100 pixels,
rounded, at least one and at most fifty (the app decides how far a notch
scrolls). The result reports `scrolled` (the pixels asked for) and
`wheelNotches` (signed), and the approval card says "Scroll down: 300 pixels
as 3 wheel notches". The input runs in the App control worker as one command
under the 20-second action watchdog. Within that command the worker first
raises the granted window again with its accessibility `activate` action (an
approval card may have brought Inertia to the front; the grant covers it),
waits up to 600 milliseconds for the window's process to come to the front,
checks an approval's expected focused control, reads the foreground once more
and only then posts. The input is refused with nothing sent, as `unavailable`,
when:

- the window holds no grant from this turn ("The app is not in front; call
  inertia_app_activate"), checked by the runtime before any approval card;
- the desktop has no synthesized input: Wayland ("Synthesized input is not
  available on Wayland") or a Linux session without an X11 display, checked
  by main before the card and again before the worker runs; on macOS, when
  Inertia lacks the Accessibility permission;
- after the re-raise, and again immediately before posting, the process in
  front is not the window's process. On X11 the worker reads the window
  manager's `_NET_ACTIVE_WINDOW` and its `_NET_WM_PID` through libX11
  (Chromium reports no accessibility active state). A successful X11 read is
  final, including "nothing is active" and an active window without a pid;
  only when libX11, the display or an EWMH window manager (`_NET_ACTIVE_WINDOW`
  on the root window) is missing, and on macOS and Windows, does it ask xa11y
  for the foreground application. The answer names `inertia_app_activate`.

The X11 reader opens and closes the display for each read and runs only on
x64 and arm64, where Xlib's `unsigned long` and pointer out-parameters are
eight bytes. While the display is open it installs a no-op Xlib error handler
(`XSetErrorHandler` with an ffi-rs callback created once and kept for the
reader's lifetime), so a window that closes between the two property reads
(`BadWindow`) makes that read fail instead of ending the worker; it syncs the
display and restores the previous handler before closing it. If the callback
cannot be created, X11 counts as unavailable. A lost connection to the X
server (Xlib's I/O error handler) still ends the worker, which main recycles.

An approved input also requires the window's root and, for a key, the focused
control to be the ones the card named. The foreground check is by process, not
by window: a key goes to whatever has keyboard focus in the app in front,
which can be another window of the same process, and a wheel step to whatever
lies under the window's centre, so another window of the same process, or an
always-on-top window of another app, covering the centre receives it. The
check and the post are two system calls a moment apart: an app that takes
the foreground in between receives the input. A failed post reports
`dispatched: true`. A typed denial maps to the same
permission categories as reads (`permission-denied`, or
`helper-permission-denied` on macOS while Inertia is listed); xa11y reports no
separate Input Monitoring state, so none is shown.

### Permissions and platform gates

- **macOS** requires Accessibility for Inertia. Main checks it before any
  native call; when it is missing every window tool fails with `unavailable`
  and the next step to allow Inertia in System Settings → Privacy & Security
  → Accessibility. A typed denial from the helper while macOS lists Inertia as
  allowed is reported as the helper's own denial
  (`helper-permission-denied`), as for Snapshots, because the utility process
  may not share the grant. Screenshots also need Screen Recording.
- **Windows** refuses a window whose process runs at a higher integrity level
  than Inertia (an elevated app), because UI Automation blocks it (UIPI):
  `unavailable`, with the next step to start the app without elevation. An
  integrity level that cannot be read does not block.
- **Linux** reads and acts over AT-SPI on X11 and Wayland. A Chromium or
  Electron app that exposes an empty tree fails with `unavailable` and "start
  the app with ACCESSIBILITY_ENABLED=1 or --force-renderer-accessibility";
  action launches already receive `ACCESSIBILITY_ENABLED=1`. A desktop
  session whose accessibility bus is turned off fails with `unavailable` and
  its own next step (turn on accessibility support, the AT-SPI bus, and
  restart Inertia).

While a gate blocks a launch, `inertia_app_launch` and `inertia_app_windows`
return its next step instead of "No window opened yet". A Screen Recording
denial blocks only screenshots and is not a gate for the launch.

The App surface sees the same state as fixed categories on the launch
record, never as native text: `protectedApps` (the denied apps of the tree)
and `windowAccess` (`permission`, `helper-permission`, `accessibility-tree`,
`accessibility-bus`, `elevated`, `unsupported` or `start-failed`, or null),
present only on
accessibility launches and republished as a sequenced launch update when
they change.

**Settings → Devices & integrations → App control** reads its state from
main's App control service over one validated IPC channel
(`inertia:app-control`, accepted only from the main window, exact keys):
on macOS the Accessibility grant, a helper denial and Screen Recording; on
Windows availability; on Linux whether the AT-SPI bus answered and whether
the session is Wayland (`XDG_SESSION_TYPE=wayland`, or `WAYLAND_DISPLAY` set
unless `XDG_SESSION_TYPE=x11`, so an X11 display beside Wayland is only
XWayland; screenshots and input use the same classification). A **Keyboard and mouse input** line says whether
synthesized input is available: on macOS it needs Accessibility, on Windows
and X11 it is available, and on Wayland it is not. macOS and Linux find this out by sending the worker a
`windows` command with an empty scope, which lists accessibility
applications and reads none of their windows; on macOS it is not sent until
Inertia is trusted, so reading the state never prompts. The card's buttons
act only when clicked: **Accessibility settings** asks macOS to show its
Accessibility prompt (`isTrustedAccessibilityClient(true)`, which also lists
Inertia in the pane) and opens the Accessibility pane, and the Screen
Recording button opens that pane. Opening the card also clears a
`start-failed` latch: its probe starts a fresh worker. There
is no global switch: **Agent app access** remains the per-project control.

### Per-platform matrix

| | macOS | Windows | Linux X11 | Linux Wayland |
| --- | --- | --- | --- | --- |
| Read windows and controls | Accessibility permission | Yes, unless the app is elevated | AT-SPI | AT-SPI |
| Click, type, Enter/Space, scroll into view | Yes (scroll into view is a no-op) | Yes | Yes | Yes |
| Bring a window to the front (`inertia_app_activate`) | Yes, verified by the foreground application | Yes, verified by the foreground application | Yes (EWMH window manager), verified by `_NET_ACTIVE_WINDOW` | Refused before the card: input is unavailable |
| Other keys and pixel scrolling (synthesized, after activation) | CGEvent, Accessibility permission | SendInput | XTest | Unavailable |
| Foreground check before synthesized input | Re-raise, then xa11y foreground application | Re-raise, then xa11y foreground application | Re-raise, then `_NET_ACTIVE_WINDOW` pid (final); xa11y only without libX11 or an EWMH window manager | Not applicable |
| Pointer clicks, drag, typed text as key events | No | No | No | No |
| Screenshot sent to the agent (project opt-in) | Exact window, masked | Never: may include other windows, kept local | Never: may include other windows, kept local | Unavailable |
| Screenshot | Exact window, Screen Recording permission | Window bounds, may show overlapping windows | Window bounds, may show overlapping windows | Unavailable |
| Password field detection | Role and secure subrole, credential names | UI Automation `IsPassword` when reported, credential names | Password text role, credential names | Password text role, credential names |
| Process tree | libproc (worker) | Toolhelp32 (worker) | `/proc` | `/proc` |

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
Access run them without asking. Two exceptions apply to native windows:
`inertia_app_activate` asks in every access mode, and a synthesized key press
or wheel scroll (see [Synthesized input](#synthesized-input)) asks in
Supervised and Auto-edit chats, because it reaches whatever has the focus;
only Full Access sends it without asking. Its card adds "This sends keyboard
input to the app window." or "This scrolls the app window with the mouse wheel
at its centre.", and the approval covers only the synthesized route: if the
window lost or gained its grant meanwhile, nothing is sent and the call fails
with `not-found`. Without an approval the route is pinned the same way: the
host tool passes the route it planned (accessibility or synthesized) to the
transport, which refuses with `not-found` and sends nothing when the route at
perform time differs, for example an Enter planned as an accessibility press
that would run as a synthesized key because an activation completed first. The card title comes from a fixed table
("Launch the app", "Stop the app", "Click", "Type", "Press", "Scroll",
"Bring the app window to the front"). The
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

**Settings → Projects → Send app screenshots to the agent** (off by default,
under Agent app access) lets the model see screenshots; see
[Screenshots sent to the agent](#screenshots-sent-to-the-agent).

A turn whose source message was sent from a Private Connect device receives
`unavailable` with "App tools are unavailable for turns sent from another
device." on every App tool, because the desktop may be unattended.

Each tool states whether it only reads or whether it changes something:
status, logs, windows, snapshot, wait and screenshot carry `readOnlyHint`
and `idempotentHint`; launch, stop, click, type, press, scroll and activate
carry `destructiveHint` on Claude and OpenCode, and `destructiveHint: false` on
Cursor and Kimi Code, for the reasons given in `docs/AGENT_BROWSER.md`. Every
App tool carries `openWorldHint: false`. Codex receives dynamic tools, which
carry no annotations.

## Screenshots sent to the agent

**Settings → Projects → Send app screenshots to the agent** is off by default.
A saved value that is missing or malformed reads as off. When it is on,
`inertia_app_screenshot` also returns the image in the host-tool result's
`images`, but only on a route whose model accepts images: a native Claude or
Codex profile whose selected model lists image input, the same rule
`inertia_request_context` uses for image attachments. On every other route,
and while the setting is off, the result stays metadata only, with
`sentToAgent: false` and a `note` that says why.

- **Which captures.** Electron windows and macOS native windows, which are
  captured exactly. A Windows or Linux X11 native capture covers the window's
  area of the screen and may include other windows
  (`mayIncludeOverlappingWindows: true`), so it never reaches the model: the
  worker does not make the larger copy, main does not reduce one, and the host
  tool attaches nothing and returns `sentToAgent: false` with the note "local
  evidence only: on this platform the capture may include other windows, so
  it stays on this device." The local thumbnail is kept and the turn's
  allowance is not used.
- **Size.** The image is a PNG of at most 1,536 pixels on its long edge,
  720,000 pixels and 3.75 MB (5 MB in base64). Electron windows render it
  reduced in Chromium (a second capture after the thumbnail, sized from the
  device scale the thumbnail showed; the pixel bound also keeps even an
  incompressible image within one debugging-pipe frame). macOS native windows
  reduce the masked worker capture in main with Electron's image codec, within
  the same edge, pixel and byte bounds. The runtime/main protocol and the host
  tool check the PNG signature, edge, pixels and bytes again before anything
  is sent. When the model-visible copy cannot be captured or reduced, the
  screenshot falls back to the local thumbnail with `sentToAgent: false`; it
  never fails because of that copy.
- **Privacy.** The same gate as the local capture applies before and after
  the pixels are taken: the screenshot is withheld (`sensitive`) while the
  window holds a remembered secret or a password field holds a value, and
  native captures are masked with Snapshots' protected-field rules before
  either image leaves the worker. For an Electron launch the model-visible
  request is also withheld (`sensitive`) while the launch's own memory holds a
  secret any of its windows or documents revealed, or a value it could not
  remember, so with the opt-in on that launch takes no screenshots until it is
  restarted (with the opt-in off, local thumbnails follow the window's own
  gate).
- **Allowance.** At most eight screenshots reach the model per turn; the
  ninth fails with `screenshot_limit_reached` (`retryable: false`). A
  screenshot that was withheld, failed or could not be reduced does not count.
- **Result.** `sentToAgent: true`, the image's `imageWidth` and `imageHeight`,
  and the fixed note "Coordinates from this image are not accepted by any
  tool; use refs from a snapshot." No App tool takes coordinates.
- **Evidence.** For a model-visible request the transport hands the thumbnail
  back instead of recording it, and the host tool records it once it has
  validated the image and attached it to a result that fits: only then is the
  entry labelled "Screenshot sent to the agent"; otherwise it is an ordinary
  "Screenshot". A screenshot whose evidence cannot be kept fails with
  `unavailable` and sends nothing.

Private Connect turns refuse every App tool, so their screenshots never reach
a model.

## Progress guard

Within one turn, the App pack refuses to repeat what keeps failing:

- **Repeated failures.** It covers every App tool. After three failures in a
  row of the same tool with the same arguments (key order and surrounding
  whitespace do not matter, and arguments name the window or launch), the
  next identical call in that turn fails with `repeated_failure`
  (`retryable: false`, `dispatched: false`) and "The same action failed three
  times. Take a new snapshot, change the approach, or ask the user." A success
  of that call starts the count again, and so does a successful
  `inertia_app_activate` of the window the call names, or a snapshot of that
  window that differs from its previous snapshot this turn. Refusals and
  cancellations (`user_denied`, `approval_expired`, `cancelled`,
  `call_cancelled`, `invalid_owner`, `unknown_tool`, the screenshot
  allowance, `repeated_failure` itself), an `inertia_app_wait_for` that ran
  out of time (`timeout`) and the "The app is not in front; call
  inertia_app_activate" refusal do not count.
- **No visible change.** It covers `inertia_app_click`, `inertia_app_type`,
  `inertia_app_press` and `inertia_app_scroll` only. After three of them in a
  row on one window that reported success but whose following snapshot showed
  the same document sequence, visible text, viewport and element list, the
  next of them on that window fails with `repeated_failure` and "no visible
  change" wording, once; the count then starts again, and a snapshot that
  differs resets it. `inertia_app_activate`, `inertia_app_stop`,
  `inertia_app_status`, `inertia_app_logs`, `inertia_app_windows`, waits and
  screenshots neither count toward it nor trip it.

The state is bounded (32 turns, least recently used first, and 64 calls and
16 windows per turn) and is forgotten when the turn settles, with the turn's
screenshot allowance and foreground grants; a call that finishes after its
turn settled leaves no state behind.

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
  window transport (**Debugging pipe**, **Accessibility** or **None yet**),
  its process id, uptime or run time, and exit code or signal. **Stop** ends the
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
  launch's windows, when it opens or reconnects. Under the list, an
  accessibility launch with protected apps shows a muted line ("2
  protected apps are not inspectable"), and one whose windows a gate
  blocks shows a notice in the surface's own wording with, for a permission,
  helper, accessibility-tree, accessibility-bus or start-failed gate, an
  **Open App control settings** button
  that opens that card.
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
archive waits for that proof before it archives the chat, and chat delete and
project removal wait for it before they touch a worktree.
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
attach host tools on every turn and see them from their next turn. The same
holds for `inertia_app_activate`, added in revision 2: a Codex thread that
started before it sees the tool only from its next new thread, and until then
a native press or scroll that needs it fails with "call inertia_app_activate".

## Verification boundaries

Unit and integration tests cover the tool schemas and their agreement across
the raw, Claude and HTTP bridge transports, annotations, the approval count
per access mode, approval binding (including the focused control of a press
and dialog-only approvals), one-use tokens and expiry, Private Connect
refusal, the project setting and cancelled calls with the full failure shape,
launch limits, contained Electron resolution, process-tree stop and
unconfirmed cleanup, chat archive, delete and project removal waiting for
confirmed cleanup, the session kept after an unconfirmed clear, session
eviction and the runtime thumbnail bound, profile sweep, the log ring and its
line redaction, the console rate limit, live coalesced
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
thumbnail, takes a screenshot with the project's opt-in on a stand-in
image-accepting route and checks that exactly one PNG within 1,536 pixels,
720,000 pixels and 3.75 MB comes back with `sentToAgent: true` and the "Screenshot sent to the
agent" evidence label, types into the password field and checks that the typed
value never appears and that the next model-visible screenshot is refused as
`sensitive`, reads console lines from the log, and stops the app with confirmed
cleanup. It passes the fixture `--no-sandbox` on Linux (the CI runner
restricts unprivileged user namespaces and npm's `chrome-sandbox` is not
setuid; production never adds the switch), and it supplies the Electron
binary directly instead of resolving the fixture's own `node_modules/electron`;
that resolution is covered by unit tests only.

The accessibility transport is covered by unit tests at each layer: the
strict runtime/main protocol parser (exact keys, UUIDs, identity, turnless
writes, payload and thumbnail bounds), the runtime broker client (fresh ids,
16 pending, the 90-second backstop, cancel on abort, late and wrong-kind
results), the main coordinator (identity-exact cancel, the 512-id replay
set, late results after clear and after runtime replacement, registration
with the secure-file coordinator, and the runtime record's own pid as the
only allowed parent), the denylist, process-tree scoping and start-time
identity (every child against its direct parent, unknown start times
dropped, unreadable executables denied, trees over 1,024 processes refused)
on fake `/proc` tables and a fake libproc behind a fake
ffi-rs (child lists that report counts or bytes, cycles, processes that
exit mid-walk, `proc_bsdinfo`, path and command fallbacks), the Windows record,
FILETIME and integrity-label parsers, per-pid Windows start times and the
UIPI rule, the App control service with a fake worker (scope and denied
pids, the runtime-parent check, macOS permission and helper-denial
categories, Screen Recording and Wayland gates, thumbnail bounds, both
watchdogs including screenshots, the forced kill before an unconfirmed exit,
recycling after native failure, crash and malformed answers, cancellation
while a native call runs, the queue bound, the one-second tree cache,
listener counts across 100 commands, the Windows table read in the worker, a
worker that never loads and the start-failure latch), the worker logic with a
fake accessibility module (scoping, `byPid` lookups, denied apps, elevated
windows, Browser-shaped snapshots with source-side redaction, root identity,
renamed controls, the empty Linux tree, walk bounds, actions, expectation
checks, error categories, closed windows, screenshot planning and payload
fitting for snapshots and window lists), the capture masking
on X11, Windows and macOS paths with real image encoding, and the runtime
transport with a fake broker (window ids and titles, protected apps,
permission gates while waiting, refs and document sequence with numbering
that never repeats across documents and waits that mint no refs, the asking
turn on window reads, launch-wide screenshot withholding, action and key
mapping, typed-secret redaction in snapshots, titles and logs, withheld
screenshots, approval expectation, failure wording, one native command at a
time and waits, gate categories, and window polling that runs only while
the chat is watched and resumes when it is again), the launch manager
(protected-app and gate fields on accessibility launches only, their
republication, and watch changes per chat), the runtime wiring (subscriber
or active turn), the sync hub's subscriber tracking, the App control card's
state per platform and its probe, and the validated IPC channel. Tool
contract tests cover the `transport` field and the action launch waiting for
its first native window. Happy DOM tests cover the App control card (every
platform state, settings opened only on click, focus refresh, malformed
state) and the App surface's transport label, protected-app line and
gate notice with its settings link.

Model-visible screenshots, synthesized input and the progress guard are
covered by unit tests too: the preference's default and tolerant parse and
the Settings → Projects switch (Happy DOM); the route capability handed to
the App tools (opt-in and image-accepting route, from the real thread
manager); the host tools with a fake transport (no image while off or on a
text-only route, one image with `sentToAgent`, sizes and the fixed note when
both hold, oversized (edge, pixels, bytes), wrongly sized and non-PNG images
kept local, a region capture never sent and its note, the evidence labelled as
sent only after validation and attachment, evidence that cannot be kept,
`sensitive` passed through without using the allowance, eight per turn then
`screenshot_limit_reached`, a new turn and a settled turn starting again, the
image surviving the host-tool runtime's own image bounds); the CDP transport
against a fake peer (a second, reduced capture sized from the thumbnail's
device scale within 1,536 pixels and 720,000 pixels, the thumbnail kept when
that capture fails, no capture while a secret is held in the window or in the
launch's memory after a navigation, `inertia_app_activate` refused); main's
reduction of the model-visible copy only when asked and only of an
exact-window capture, its edge, pixel and byte bounds, and the shared Linux
session classifier (XWayland counts as Wayland unless the session says X11);
the protocol's `agentImage` bounds, `input`, `permissions.input` and failure
reasons; the worker's larger masked capture on macOS only and its fallback to
the local size; and the approval matrix (activation asks in every mode,
synthesized keys and wheel input in Supervised and Auto-edit, accessibility
input in Supervised only, card wording with wheel notches, an approval bound
to the synthesized route, the planned route passed to the transport). The
accessibility transport with a fake broker covers the foreground grant
(refused before activation and before any card, granted per turn, gone in
another turn and after the turn settles, Enter becoming a key press after
activation, nothing granted when main reports the app kept behind or when the
activation finished after its turn settled), activation refused before the
card without input and the non-Linux wording, Meta+Enter per platform, route
pinning including an Enter racing an activation, the root and focused-control
expectation, the `not-foreground` and Wayland wording without a launch gate,
wheel notches in the scroll result, and the model-visible image left to the
host tool's evidence. The worker logic with a fake `InputSim` covers the key
and chord mapping of the whole allowlist, wheel notches at the window's
centre, the re-raise inside the input command (Inertia in front before it, the
app after it), the foreground check immediately before posting (another
process, nothing in front, a typed denial), an activation verified or reported
as kept behind, Meta+Enter refused off macOS, expectations, dispatched
failures and a platform without input. The X11 foreground read is covered by
its parser and a fake libX11 behind a fake ffi-rs (the error handler installed
and restored around each display, a vanished window read as final, no EWMH
window manager, a 32-bit architecture and a missing callback read as
unavailable, the accessibility fallback only then), and was run once against
a real Xvfb with a root `_NET_ACTIVE_WINDOW` naming a window that does not
exist, which returned nothing in front instead of ending the process. The App
control service covers the input gate on Wayland, XWayland and a missing
display, the macOS permission, the action watchdog for input and the
helper-denial category, and the card's input state per platform. The progress
guard covers three identical failures, key order and trimmed arguments, other
arguments and turns, refusals, wait timeouts and the not-in-front refusal not
counting, a success, a successful activation or a differing snapshot
resetting the count, the no-visible-change rule (text and viewport count as a
change; activation, stop and the read-only tools neither count nor trip it)
and its reset, least-recently-used eviction, a call after its turn settled
leaving no state, and its bounds.

One Linux scenario (`tests/e2e/app-under-test-native.spec.ts`) runs the
accessibility transport against a real desktop: inside its own Xvfb, D-Bus
session and AT-SPI bus with Openbox (the Snapshots native session helper), an
Electron harness process plays Inertia's main and runtime. It runs the real
App control service, which forks the real "Inertia App Control" utility
process with `@crowecawcaw/xa11y` loaded through the shipped binding; the
runtime's broker client reaches main's coordinator through the strict
protocol parsers (every message structurally cloned); and the real launch
manager and App host tools, in a Supervised chat with approvals answered by
the test, launch the phase 1 fixture as a project action whose executable
is the repository's Electron binary with `--force-renderer-accessibility`, a
private `--user-data-dir` and `--no-sandbox` (the CI runner restricts
unprivileged user namespaces and npm's `chrome-sandbox` is not setuid). It checks that
`inertia_app_launch` reports `transport: "accessibility"` with the native
window, waits for text, lists the window without protected apps, takes a
snapshot with the heading text and refs for the buttons, both text fields
and the link (the password field reads `[redacted]`), presses **Change
text** through AT-SPI and waits for "Button clicked", captures an X11
screenshot whose thumbnail stays within 512 by 320 pixels, takes a
screenshot with the project's opt-in on an image-accepting route and checks
that the X11 region capture is not sent (`sentToAgent: false`, the
overlapping-windows note, no image, evidence labelled "Screenshot"), checks
that Escape is refused with
"call inertia_app_activate" until the window is brought to the front, brings
it to the front (the worker verified it came forward through
`_NET_ACTIVE_WINDOW`), presses Escape through XTest (after the worker raised
the window again) and waits for the fixture's keydown handler to show "Escape
pressed", scrolls by `deltaY`, checks that three wheel notches were reported
and waits for its wheel handler to show "Wheel scrolled down", checks that the grant is gone once the
turn settles, types into the password field and checks that the value appears
nowhere and that the next screenshot is withheld as `sensitive`, stops the app
with confirmed cleanup and disposes the worker. It skips on other platforms.
On Linux it skips locally when `xvfb-run`, `dbus-run-session`, Openbox,
`xdotool`, the repository's Electron binary or the AT-SPI bus is missing, but
fails instead when `CI` is set, so CI cannot pass without exercising the real
desktop. It takes about eight seconds. A probe of the same session showed why
the X11 foreground read is needed: Openbox reports the fixture as the active
window, but Chromium's AT-SPI tree reports no active state, so xa11y's own
foreground query finds no focused application.

Setting a value is the one step the fixture cannot pass on Linux. A probe of
the same session found that Chromium's AT-SPI bridge in this Electron
version implements no `EditableText` interface: `SetTextContents` and
`InsertText` fail (`ATK_IS_EDITABLE_TEXT` assertions, `UnknownMethod` over
D-Bus), so xa11y's `setValue` raises `ActionNotSupportedError` and
`typeText` a platform error. The scenario therefore asserts what Inertia
does with that: replacing text fails with `invalid`, "does not support this
action" and `dispatched: false`; appending text is a native failure after
which main recycles the worker, and the next snapshot from a fresh worker
still lists the field, unchanged. GTK and Qt text fields implement
the interface; no such app is available to the CI image.

Not exercised:

- the accessibility transport on macOS and Windows: `screencapture`, the
  Windows region capture, the Toolhelp32, `GetProcessTimes` and token
  integrity calls and the libproc calls through ffi-rs ran only as fakes
  (ffi-rs writing into caller buffers was checked on Linux with libc);
- setting or appending a field value through accessibility in a real app
  (Chromium on Linux refuses it, see above), toggle, select, expand and
  scroll into view against a real tree, Enter and Space on a focused
  control, a denied application in a real tree, and Wayland;
- the App control card and the App surface's gate notice in the full
  desktop app against a real denial (the card was captured on Linux with
  AT-SPI available; the gate states ran in Happy DOM only);
- background polling stopping and resuming with a real renderer
  subscription and provider turn (unit tests drive the sync hub, the wiring
  and the transport separately);
- whether macOS grants the Accessibility permission to the "Inertia App
  Control" helper of a signed build (see the Snapshots owner verification
  steps);
- macOS and Windows launches, including Windows job-object cleanup of an
  Electron tree and `.cmd` actions;
- Electron running as a non-root user with its sandbox on;
- key presses and scrolling over the debugging pipe in a real app (unit
  tests use a fake peer);
- synthesized input on macOS (CGEvent, and whether the helper process needs
  its own Accessibility grant to post events) and Windows (SendInput,
  `GetForegroundWindow` through xa11y), the not-foreground refusal with a real
  second app in front, and a wheel step landing on a window that covers the
  centre;
- the re-raise inside an input command after a real approval card took the
  focus (the e2e scenario answers approvals in the test, so Inertia never
  comes forward), an activation a real window manager refuses
  (`activated: false`), and a `BadWindow` from a window that closes between
  the two X11 property reads in a real session (exercised only with a
  fabricated root property under Xvfb);
- a model-visible macOS native screenshot through `screencapture` and
  Electron's real image codec in main (the pixel-bounded reduction is unit
  tested through its scale only);
- model-visible screenshots through a real provider turn: the e2e scenarios
  pass the opt-in and an image-accepting route to the App tools directly, and
  the provider transports carry `images` as unit tests already cover for
  `inertia_request_context`;
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
  surface; the README-style screenshots, including the App control card
  (`docs/screenshots/inertia-app-control-settings.png`), are produced by
  `scripts/capture-app-under-test-screenshots.mjs`, which uses the App
  surface and Settings directly.

## Not in this release

- Synthesized pointer clicks, drag and typed text as key events on native
  windows, and detection of the user taking over a native window.
- Coordinates taken from a screenshot: no App tool accepts them.
- Attaching to an app that is already running, or to a window the user picks.
- Launching package scripts. They need a shell or a package manager; add a
  project action instead.
