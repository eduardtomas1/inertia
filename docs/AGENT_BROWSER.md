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
| `inertia_browser_click` | `ref`, optional `dialog` | Click one element from the latest snapshot. |
| `inertia_browser_type` | `ref`, `text`, optional `replace` | Type into one editable element. |
| `inertia_browser_press` | `key`, optional `dialog` | Send one allowlisted key to the focused element. |
| `inertia_browser_scroll` | exactly one of `deltaY` or `ref` | Scroll the page vertically, or scroll one element to the centre of the view and return the viewport. |
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

Pages cannot open native dialogs. The Browser preload replaces `alert`,
`confirm` and `prompt` in the page's main world before page scripts run,
using only built-ins captured at that moment: `alert` returns at once,
`confirm` returns false unless Inertia armed an accept for the current agent
action, and `prompt` returns null. Each call is sent to the isolated Browser
world as a DOM event with a primitive detail; the isolated world decides the
reported answer itself from what Inertia armed, never from the event, so a
page that forges a record cannot claim an accepted confirmation. The next
snapshot, click, type or press result reports the dialogs once as
`dialogs: [{"kind","message","answer"}]`: at most 20 per report with
`dialogsOmitted` counting the rest, messages of at most 1,024 characters
passed through the same redaction as page text, and the report bounded to 8
KiB. When the document's evidence is withheld for privacy, or the privacy
guard is missing, every message is reported empty and the report carries
`dialogsWithheld: true`. Dialog messages are untrusted page data.

`inertia_browser_click` and `inertia_browser_press` accept
`dialog: "accept" | "dismiss"` (default `dismiss`). `accept` is armed inside
the action, after the pointer has moved onto the target and immediately
before the mouse or key press, and it is one-shot: the first `confirm` takes
it, and anything left is cleared when the action settles. A confirmation
raised while hovering, a second chained confirmation, or a timer that fires
later is dismissed. In a Supervised chat the approval says "and accept the
page's confirmation dialog". The `disableDialogs` web preference stays on,
so a dialog the override cannot reach, for example one opened from an
embedded frame, is still answered silently and never shown. A dialog raised
by a page that then navigates away is lost with its document.

A page that asks to stay when it is left (`beforeunload`) is handled by who
is leaving it. While an agent action is running on that tab, the page is
allowed to leave and the next navigation, history, click, type or press
result reports a `beforeunload` dialog answered `accept`. Otherwise the user
is leaving it, and Inertia asks with its own native confirmation, "Leave this
page?", whose default is Stay and which shows no page text; the page leaves
only if the user chooses Leave.

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
| `interrupted` | The user clicked or typed in the page while the call was running. | true | true when the action had been sent |
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

Semantic snapshots include at most 200 rendered interactive elements, 12,000
characters of normalized visible text, current viewport data, and a total 32
KiB UTF-8 process-boundary limit. Controls inside the viewport come first;
the remaining places go to the controls nearest the viewport, which carry
`offscreen: true` and a ref like any other, so the agent can scroll to them
or click and type into them directly. Oversized snapshots are structurally
reduced, dropping the controls farthest from the viewport first, and remain
valid JSON. Element references are generated in an isolated JavaScript world
and become invalid when their DOM node disappears or stops being rendered.

A click or type on a ref whose element lies outside the viewport first
scrolls that element to the centre of the view from the isolated Browser
world, then locates and hit-tests it exactly as for any other ref; the
approval binding to the inspected document and ref is unchanged. In a
Supervised chat the approval for such a click or type is not prepared,
because preparing it would scroll the page before the user approves anything:
the agent is told to scroll the control into view with `inertia_browser_scroll`
and its ref, which is itself an approved action, and to try again.

When a snapshot leaves anything out, it says so in a form the agent can act
on instead of a bare flag: `omitted: {"textChars": n, "elements": n}` counts
the characters of visible text and the controls that were left out, and
`nextStep` says to scroll with `inertia_browser_scroll`, by ref or by pixels,
and take a new snapshot, or to look for specific content with
`inertia_browser_wait_for` and text. When the page is larger than one snapshot
reads (more than 4,000 elements, 4,000 text nodes or 24,000 characters of
source text), the counts are lower bounds and `nextStep` says that more of the
page exists than is listed. A snapshot that left nothing out has neither
field.

Inertia reads only the top-level document's own DOM. Content inside embedded
frames (`iframe`, `frame`, `object`, `embed`) and shadow roots is never read,
and a click whose target is one of those frame elements is refused. When a page has them, the snapshot says
so in `notInspected` (`frames`, `shadow-roots`), and each visible frame is
listed as a `frame` element with no ref. A document with more than 4,000
elements is read up to that bound and reported in `omitted`. None of these stop
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
Disabled and off-screen controls are excluded. The result covers only the
current visible viewport and semantic element set; it cannot judge color, typography, imagery,
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

A document-level privacy guard starts before the first inspection and keeps
sensitive values out of everything a model receives.

A field is sensitive when it is a password field, or when it is a text-like
control (a text, search, email, URL, telephone, number or hidden input, or a
text area) whose id, name, autocomplete token, placeholder, `aria-label`,
label or `aria-labelledby` text names a credential: password, passcode,
passphrase, secret, credential, API key, private key, authorization, one-time
code, an authentication, authenticator, verification, security, MFA, 2FA,
recovery or backup code, OTP, TOTP, CVV, CVC, card number or PIN. "Token"
counts only as an API, auth, access, secret, bearer, session or CSRF token, or
as the whole name. Names are compared as words split at spaces, `_`, `-`, `.`,
`:`, `/` and camelCase boundaries. Longer words also match inside a joined
name, so `api_key`, `authToken`, `password2`, `x-api-key`, `newpassword`,
`clientsecret` and `otpcode` are sensitive, while the short words OTP, TOTP,
CVV, CVC, PIN and token must stand alone, so `spinner`, `max_tokens`,
`token_type`, "secretary" and "Search design tokens" are not. Checkboxes,
radio buttons, buttons and selects are never sensitive by name. Labels in
other languages are not recognized; password fields and the standard
autocomplete tokens still are.

The guard remembers the value and default value of every sensitive field,
values that page scripts assign to one, and treats any other field holding a
remembered value of four or more characters as sensitive too. It keeps up to
256 values of up to 4,096 characters for the life of the document, and never
forgets one to make room.

### Snapshots

A snapshot is not withheld because a sensitive value exists. A sensitive
field keeps its own label as its name, or "Sensitive field" when it has none,
and always reports the value `[redacted]`. Every remembered value is replaced
with `[redacted]` wherever else it appears: page text, the title, control
names and values, and the labels of approval requests. Matching ignores case,
compatibility forms such as fullwidth letters, whitespace and every
default-ignorable character (soft hyphens, zero-width and directional marks,
joiners, invisible operators and variation selectors), so a value split across
markup or restyled in capitals is still found. For values of up to 1,024
characters, URL-encoded, form-encoded, hexadecimal UTF-8 and JSON-escaped
copies are found the same way. Overlapping matches are merged into one
`[redacted]`. Page text is redacted over its whole bounded source before it is
clipped to its output limit, and when a source itself had to be cut, only the
end that could begin a remembered value is dropped.

Values of four or more characters are hidden wherever they occur, even inside
words, so a trivial password such as "test" also hides that word in ordinary
text. Values of one or two characters are hidden only as whole words. A
three-character value is hidden only as a whole word too, unless a snapshot or
an interaction already saw it in a field, in which case it is hidden
everywhere, such as a card security code next to its label.

Typing one key at a time produces every prefix of a value. Each prefix stays
remembered until the next snapshot, interaction lookup or `change` event. At
that point a prefix is forgotten only if trusted typing extended it in the same
field, that field is still in the document and its current value still extends
the prefix, and nothing earlier had already seen the prefix in a field.
Deleting characters, clearing the field or removing it keeps every value. A
signed-in page that shows the username is therefore not mangled by the
prefixes of a password that starts with it.

A snapshot is withheld, with the `sensitive` code until the document is
replaced by a navigation, only when the guard cannot enumerate or redact
safely:

- `hidden-input`: text was typed into a control the guard cannot inspect
  because it is inside a closed shadow root;
- `document-too-large`: the page has more than 4,000 inputs and text areas;
- `redaction-limit`: the document holds more sensitive values, or a longer
  one, than the guard can remember; or
- `credential-signal`: a script changed a sensitive field in a way the guard
  cannot inspect, such as replacing its value with a property the guard cannot
  monitor, swapping its prototype, or parsing password markup outside the
  document.

React and similar frameworks install their own value accessor on every input.
The guard watches that accessor instead of refusing the page. On a sensitive
field it remembers every value assigned through the accessor, and a value the
accessor reads back only when it differs from the field's real value.

Approval requests name the target control by its label. When the scan was cut
short or the document's evidence is withheld for any reason, the label is
"page element". The text inside a text area or select is never used as its
label; an ordinary input without a label may be named by its own value, with
remembered values redacted. Typed text is hidden from an approval request when
the target is a sensitive field, an editable region or textbox whose name
words name a credential, or any control while the document holds a remembered
value or could not be scanned completely.

### Screenshots and local capture

Screenshots and local capture are withheld while the document holds any
remembered sensitive value, and for every reason that withholds a snapshot.
The refusal message names the reason and that navigating to the page again
starts a new document.

### Accepted limits

- A page that records the intermediate keystrokes of a value typed by hand can
  show the forgotten prefixes.
- A hostile page can extend a typed value with one more trusted character of
  its own (for example through `document.execCommand("insertText")`) and leave
  it there, so the next snapshot forgets the shorter value it extended.
- When a field is removed before any snapshot, its typed one- to
  three-character prefixes stay remembered but are hidden only as whole words.
- Values that reach the guard only through page scripts assigning them are
  never collapsed, so an input that rewrites its own value on every key keeps
  every intermediate form hidden.
- Reversed, base64-encoded or otherwise transformed copies of a value are not
  recognized.
- Values that exist only inside frames or parser-created shadow roots are
  covered only as described below.

### Frames, shadow roots and large pages

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

Sensitive fields are found by enumerating the document's inputs and text
areas rather than by walking its elements, so one is seen wherever it sits in
a large document. A document with more than 4,000 inputs and text areas is
treated as unverifiable and its evidence is withheld with its own reason: the
page has too many fields to check safely, so the agent is told to open a
smaller page or a more specific route rather than to navigate to the same page
again.

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

The user can take over the page at any time. When the user clicks or types
in the Browser pane while an agent command is running, the command stops and
fails with `interrupted` and the message "The user is using this page; take a
new snapshot before continuing." After any click or keystroke by the user,
`inertia_browser_tabs`, snapshots and every other result report
`controller: "user"` until the next successful agent action other than
listing tabs. Inertia tells its own input apart from the user's by recording
each mouse press and key press it sends, at most 64 at a time and for two
seconds each, and consuming the matching event when Chromium reports it;
pointer movement, wheel scrolling and key releases never count as the user.

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
