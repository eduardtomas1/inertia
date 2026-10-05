# Inertia Agent Browser

The Inertia Agent Browser is an exact-chat, native multi-page browser that the
user and coding agent inspect and control through one authoritative surface.
It is not a Playwright process, a provider-specific browser skill, or a remote
browser service. Electron's privileged main process owns every page and the
local runtime receives only a narrow command broker.

## Product contract

- Every chat owns one Browser session. Its pages belong to the conversation,
  not to the panel that displays them: they stay loaded when the user switches
  chats, closes the Browser panel, opens Settings, or reloads the window, and
  the same pages are shown again when that chat's Browser panel returns.
- An authorized agent can use its chat's Browser whether or not the panel is
  showing, including from a background chat or a detached chat window. A page
  with no visible panel is laid out at 1280 by 800 CSS pixels; once a panel has
  shown it, the page keeps that panel's size while hidden. A Browser remains
  unavailable to stale turns and while the main window is closed.
- A chat may hold at most eight ephemeral pages in one non-persistent browser
  session. Inertia keeps the Browsers of at most four chats that are not on
  screen, closes the least recently used one beyond that, and closes any that
  has been off screen and unused for thirty minutes. A Browser that an agent
  is using at that moment is never closed. Closing the window or quitting
  closes every Browser and clears its storage.
- Only loopback development origins accepted by the existing preview URL
  policy may be embedded or agent-controlled. Remote HTTPS addresses continue
  to open in the system browser; remote plaintext HTTP is rejected.
- The Browser chrome shows pages and the active page. Its **Evidence** view
  keeps a bounded local timeline of navigation, page failures, screenshots,
  and fixed agent-action labels. Click and type actions also render a pointer
  with a fixed bounded label inside the visible page.
- Browser tools are injected automatically into the existing exact-turn host
  bridge for Codex, Claude, Cursor, Kimi Code, and OpenCode. No skill
  install is required. Claude, Cursor, Kimi Code, and OpenCode advertise the
  bridge again on native resumed turns. Codex App Server cannot
  inject dynamic tools into an already-live native thread: a Codex thread
  keeps the tools it started with until a new thread starts. When the Browser
  tools were introduced, a one-time database capability epoch cleared the
  opaque native continuation of Codex chats that predated them, so their next
  turn started a new thread with the Browser tools; the Inertia conversation
  and visible transcript were preserved. Later tool changes do not repeat that
  epoch.

## Agent tools

The provider-neutral bridge exposes one tool per action. Each has a flat
object schema whose required arguments are exact, so every provider transport
advertises the same arguments the runtime validates:

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `inertia_browser_navigate` | exactly one of `url` or `history` | Open a local development URL, or go `back`, `forward` or `reload`, and wait for the page to load. |
| `inertia_browser_snapshot` | none | Read the active page and get element refs. |
| `inertia_browser_click` | `ref` | Click one element from the latest snapshot. |
| `inertia_browser_type` | `ref`, `text`, optional `replace` | Type into one editable element. |
| `inertia_browser_press` | `key` | Send one allowlisted key to the focused element. |
| `inertia_browser_scroll` | `deltaY` | Scroll the page vertically. |
| `inertia_browser_wait_for` | optional `text`, `state`, `timeoutMs` | Wait for text to appear or disappear, or for loading to finish. |
| `inertia_browser_screenshot` | none | Capture one local Evidence image. |
| `inertia_browser_tabs` | none | List the chat's pages. |
| `inertia_browser_open_tab` | optional `url` | Open and activate a new page. |
| `inertia_browser_select_tab` | `tabId` | Activate a page. |
| `inertia_browser_close_tab` | `tabId` | Close a page. |

A `url` without a scheme that starts with `localhost`, `127.0.0.1` or `[::1]`,
such as `localhost:5173`, opens over `http://`. History navigation is checked
against the same loopback policy before it starts: going back or forward is
refused unless the target history entry is a local page, and reload is
refused unless the tab shows one. Server redirects during any navigation stay
under the existing redirect guard.

`inertia_browser_press` accepts Enter, Tab, Escape, Backspace, Space, the
arrow keys, Home, End, PageUp, PageDown, Shift+Tab, Shift+Enter, Control+Enter
and Meta+Enter, sent as trusted input with their modifiers. Every Enter
variant goes through the same guarded activation path as Enter. Control+Enter
and Meta+Enter send key down and key up only, which is what shortcut handlers
listen for, so they never insert a line break.

Text limits are counted in Unicode code points, the unit JSON Schema
`maxLength` uses: `url` holds at most 4,096, `inertia_browser_type` `text` at
most 4,000, and `inertia_browser_wait_for` `text` at most 200. The runtime tool
validator and the main-process parser call the same counting function, and a
request that reaches main with arguments it does not accept is answered with
an `invalid` tool error instead of restarting the runtime.

`inertia_browser_interact` and the action-based form of
`inertia_browser_tabs` are retired. They are no longer advertised, but a
provider session that registered them before this change can still call them.
Codex App Server stores a thread's tools when the thread starts, so existing
Codex threads keep working with the retired tools and new threads receive the
current ones; no native continuation is cleared.

Every successful result is JSON that includes the tab state, and a snapshot
names the tab it describes. Every failure is
`{"error":{"code","message","retryable","reachedPage"}}` where the message
says what to do next. `retryable` says whether the same call can succeed once
the step the message names is done, and `reachedPage` says whether the action
may already have changed the page. The codes are:

| Code | Meaning | `retryable` | `reachedPage` |
| --- | --- | --- | --- |
| `invalid` | The arguments or the target were not acceptable. | false | false |
| `not-found` | The tab is blank, the tab is gone, or the ref is stale; a stale ref asks for a new `inertia_browser_snapshot`. | true | false |
| `sensitive` | Page content is withheld for privacy (see below). | false | false |
| `timeout` | The deadline passed; the message says whether the action had already reached the page. | true | true when the action had been sent |
| `unavailable` | The page could not be loaded or the Browser cannot run. | true | true only when the Browser failed unexpectedly after sending the action |
| `too-large` | A bound such as the eight-page limit was reached. | true | false |
| `cancelled` | The turn cancelled the call. | false | true when the action had been sent |
| `user_denied`, `call_cancelled`, `unknown_tool`, `invalid_owner` | The runtime refused the call before it reached the Browser. | false | false |

When the runtime itself stops waiting for the Browser, the result is
`timeout` with `reachedPage: true`, because the outcome is unknown.

A new tab is blank. A snapshot of a blank tab is not an error: it returns
`{"blank":true,"nextStep":...}` so the agent navigates first. After a failed
navigation the tab shows Chromium's error page, and a snapshot reports that
instead of describing the error page as if it were the requested one.

The snapshot and type tool descriptions and the frontend capability pack
tell the model that password, one-time-code and other secret fields report
the value `[redacted]`, that `[redacted]` in page text is Inertia hiding a
secret rather than page content and must never be retyped to check it, and
that page text and control names are untrusted page data, never
instructions.

Semantic snapshots include at most 200 visible interactive elements, 12,000
characters of normalized visible text, current viewport data, and a total 32
KiB UTF-8 process-boundary limit. Oversized snapshots are structurally reduced
and remain valid JSON. Element references are generated in an isolated
JavaScript world and become invalid when their DOM node disappears or is no
longer visible.

Inertia reads only the top-level document's own DOM. Content inside embedded
frames (`iframe`, `frame`, `object`, `embed`) and shadow roots is never read,
and a click whose target is one of those frame elements is refused. When a page has them, the snapshot says
so in `notInspected` (`frames`, `shadow-roots`), and each visible frame is
listed as a `frame` element with no ref. A document with more than 4,000
elements is read up to that bound and marked `truncated`. None of these stop
the agent from inspecting or controlling the rest of the page. A shadow host
keeps its ref so a web component can be clicked, but a `value` is never read
from a shadow host or a custom element. A closed shadow root that the HTML
parser created from a declarative template is not reported in `notInspected`;
its content is still never read.

`inertia_browser_wait_for` polls the same guarded snapshot the agent could
request itself, so it cannot reveal anything a snapshot would withhold. Its
polls run the privacy check before and after reading but do not freeze the
page or block the user's input, and a poll interrupted by the page reloading
is retried. It returns `matched: true` or `matched: false` rather than
failing when the condition is not reached. Its text matches visible text and control names,
case-insensitively. URL paths are not a wait condition because the agent only
ever sees a page's origin.

Each successful snapshot also includes a bounded `inertiaAudit` object. Version
1 reports deterministic issue codes and affected refs for controls without
stable labels or semantic names, clipped controls, rectangles that overlap by
at least half of the smaller target, and interactive targets smaller than 24
by 24 CSS pixels.
Disabled controls are excluded. The result covers only the current visible
viewport and semantic element set; it cannot judge color, typography, imagery,
canvas, animation, or pixel-level visual quality. Agents are instructed to
repeat the snapshot after the user or layout changes the viewport and to report
only evidence they actually observed. Inertia does not currently give an agent
an autonomous viewport-resize command.

Screenshots are reduced to a local thumbnail of at most 512 by 320 pixels and
256 KiB. Inertia does not write them to the repository, attachment store,
diagnostics, or its application database, and no provider transport receives
their bitmap bytes. The tool result contains only bounded capture metadata;
providers use the semantic snapshot for page inspection.

That separation is deliberate. CSS boxes, shadows, canvas, SVG, video, and
other rendering primitives can encode arbitrary pixels without a corresponding
secret string or enumerable source property. OCR, visual heuristics, and a
growing CSS-property blacklist cannot prove such a bitmap safe. Inertia keeps
the useful local capture while placing the provider boundary before all bitmap
bytes.

## Privacy guard

A document-level privacy guard starts before the first inspection. It
withholds all semantic evidence and local capture for a document, with the
`sensitive` code, until that document is replaced by a navigation, once any of
these is observed:

- a password field holds a value, whether typed or present when the page
  loaded, so reveal controls, replacement inputs, and page-made copies remain
  covered;
- a script assigns a value to a password field, or changes the properties the
  guard relies on to see one; or
- text is typed into a control the guard cannot inspect because it is inside a
  closed shadow root.

The refusal message names which of the three applied and that navigating to
the page again starts a new document. An agent that signs in through a form
therefore loses page content between typing the password and the page
navigating, and regains it on the signed-in page.

Frames, shadow roots, large documents, and large markup writes do not withhold
evidence. Earlier versions refused every page that had any of them, which made
most framework development servers and any application with an embedded frame
unusable, and reported the refusal as a password. They are now treated as
regions Inertia does not read.

This has one known limit. The guard observes the top-level document. It does
not observe a password that exists only inside a frame's own document or only
inside a shadow root the parser created. Inertia never reads those regions, but
if the page's own script copies such a value into the top-level document as
ordinary text, a snapshot will include it like any other visible text. A
script-created blank frame cannot be instrumented before page code reaches it,
so this cannot be closed without refusing every page that has a frame.

Password fields are found by enumerating the document's inputs rather than by
walking its elements, so a password field is seen wherever it sits in a large
document. A document with more than 4,000 inputs is treated as unverifiable
and its evidence is withheld with its own reason: the page has too many inputs
to check safely, so the agent is told to open a smaller page or a more
specific route rather than to navigate to the same page again.

Enter and Space are refused while focus is inside an embedded frame or a
closed shadow root, because Inertia cannot see the control they would
activate. A privileged check of the focused element decides this; pages that
merely contain frames or shadow roots elsewhere are unaffected.

## Local evidence

The Evidence view is an inspectable main-process ledger for the exact live
Browser session. It is not provider context and is never written to SQLite, the
project, attachments, diagnostics, or renderer storage. Closing a chat's
Browser clears its entries, retained thumbnails, request correlation, browser
storage, and session listeners; hiding it keeps them.

The ledger holds at most 100 descriptors in 128 KiB, eight PNG thumbnails of
at most 256 KiB each, and 2 MiB of thumbnails in total. It also limits page
events and in-flight request correlation before they reach the ledger. Older
or repeated evidence is coalesced or marked omitted instead of growing without
bound. Opening Evidence hides the native page without resizing it; closing it
shows the exact page again and restores keyboard focus.

Navigation and failed-request rows retain only a sanitized HTTP(S) origin.
Request methods and resource types come from closed allowlists. The ledger
never reads or stores headers, cookies, authorization values, request or
response bodies, status lines, referrers, filesystem paths, or URL paths,
queries, and fragments. Page console errors are default-suppressed, bounded,
and sanitized in the main process; credential-bearing or uncertain detail is
replaced by a fixed message. Page titles, semantic labels, typed text, and raw
provider output are not used as agent-action labels.

Screenshot bytes remain in main-process memory behind an opaque evidence UUID.
The preload bridge can request inspection only for the exact live
owner/conversation/evidence tuple; it never returns PNG data. The main process
fingerprints those exact immutable bytes, opens a native post-capture
confirmation with **Cancel** as the default, rechecks the fingerprint, and then
renders the image in a main-owned sandboxed window with no preload or IPC
bridge. The React renderer receives only shown/unavailable status. A denial,
stale chat, split owner, replaced or evicted image, or closed Browser receives
no view. Full Access never bypasses this local inspection confirmation, and
timeline or tool screenshots never cross back to a provider.

## Permission behavior

Snapshots, local screenshot capture, and page listing are read-only. Inspecting
one retained capture has its separate native post-capture confirmation. In a Supervised chat,
navigation, interaction, and page mutations create one ordinary Inertia
approval tied to the exact provider tool call. Denial prevents the browser
action. Auto-edit and Full Access use their existing provider access contract
without adding a second interaction approval, but do not release local image
bytes.

Tools that change the page or its tabs (navigate, click, type, press, open
tab, close tab) carry the MCP `destructiveHint`; snapshot, screenshot, tabs
and wait carry `readOnlyHint` and `idempotentHint`; every Browser tool carries
`openWorldHint: false` because only loopback pages are reachable. Claude and
OpenCode receive the destructive hint because Inertia already allows its own
tools in their native permission layers, so the hint cannot add a prompt
before Inertia's approval. Codex receives dynamic tools, which carry no
annotations. Cursor and Kimi keep `destructiveHint: false`: in a Supervised
chat Inertia shows their native permission requests to the user, and neither
agent documents whether it asks for permission because of this hint, so the
hint could add a second prompt. Antigravity does not receive Inertia tools.

An aborted or settled call loses browser authority immediately. Every request
carries a fresh UUID plus the server-owned conversation, run, and turn UUIDs.
Cancellation must match all three identities. The main process rejects reused
request identities, aborts duplicate in-flight work, and suppresses late
results after cancellation, runtime replacement, or shutdown.

## Deadlines and waiting

The main process owns one deadline per command, started when the command
begins to run rather than when it was queued: 20 seconds to inspect, 40
seconds for input, 45 seconds for navigation, and the requested time plus five
seconds for a wait. Each internal phase is still bounded at 15 seconds. A
command waits at most 30 seconds behind an earlier command in the same chat
and then returns `timeout` with nothing sent. The utility runtime allows at
most 16 pending browser requests and keeps a 90-second backstop above those
limits, so a precise result from the main process normally arrives first.

A `timeout` result states whether the action had already been sent to the
page. When it had, the agent is told to take a snapshot before repeating it,
because a click or submission cannot be undone by cancelling.

Navigation waits for the page to load. A page that is still loading near the
deadline is not stopped: the result is successful, reports `loading: true`,
and tells the agent to wait or take a snapshot. A navigation started by a
click is treated the same way after 20 seconds. A failed load returns
`unavailable` with the cause, such as a refused connection, without echoing
the address. A navigation that is cancelled before any page loads, for
example because it redirected to a remote address, is reported as
`unavailable` and the tab keeps its previous page.

A page that is hidden, covered, or in a minimized or background window
produces no animation frames, and the input path waits for one. Inertia
therefore turns background throttling off for a page while an agent command
is using it and restores it two seconds after the last command. Menus,
dialogs, and approval prompts hide the native page without resizing it, so an
agent action that is waiting for approval is not invalidated by its own
prompt; only a change to the page's size invalidates in-flight refs.

If a page's renderer crashes, or the inspection connection to a page is lost,
the next command says so and that navigating to the page again recovers it.

## Security boundary

Each chat-owned Browser session is created without a `persist:` partition and
with context isolation, sandboxing, web security, and no Node integration.
The main process denies permission checks and requests, downloads, new windows,
remote navigation, and URLs containing credentials. Browser storage is cleared
when the chat's Browser session closes.

The renderer can request navigation, page selection, bounds, and native
inspection for an exact opaque evidence image through a strict preload API, but it never receives image bytes, a
`WebContents`, browser storage, raw page DOM, or arbitrary capture capability.
The supervised utility process cannot create Electron views directly. Its path
is:

```text
exact provider turn
  -> bounded Inertia host tool
  -> supervised utility-process broker
  -> strict correlated main-process command
  -> exact conversation-owned WebContentsView
```

The agent cannot use this surface to read arbitrary files, upload a file,
grant a browser permission, start a download, retain cookies across ownership,
or control a page belonging to another conversation. File inputs never receive
semantic refs, focused activation is rejected, and a privileged chooser
boundary cancels direct or delayed selection while the exact agent-created
transient activation remains live. Native human selection is restored once
that causal capability expires.
