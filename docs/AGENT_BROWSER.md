# Inertia Agent Browser

The Inertia Agent Browser is an exact-chat, native multi-page browser that the
user and coding agent inspect and control through one authoritative surface.
It is not a Playwright process, a provider-specific browser skill, or a remote
browser service. Electron's privileged main process owns every page and the
local runtime receives only a narrow command broker.

## Product contract

- Select a chat in the main workspace. Its Browser button opens a blank page
  directly; if an authorized agent calls a Browser tool first, Inertia lazily
  creates that same visible page without requiring a manual open. A Browser
  remains unavailable to background chats, detached windows, and stale turns.
- A chat may hold at most eight ephemeral pages. Pages share that chat's one
  non-persistent browser session and disappear when ownership closes.
- Only loopback development origins accepted by the existing preview URL
  policy may be embedded or agent-controlled. Remote HTTPS addresses continue
  to open in the system browser; remote plaintext HTTP is rejected.
- The Browser chrome shows pages and the active page. Its **Evidence** view
  keeps a bounded local timeline of navigation, page failures, screenshots,
  and fixed agent-action labels. Click and type actions also render a pointer
  with a fixed bounded label inside the visible page.
- Browser tools are injected automatically into the existing exact-turn host
  bridge for Codex, Claude, Cursor, Gemini CLI, Kimi Code, and OpenCode. No skill
  install is required. Claude, Cursor, Kimi Code, and OpenCode advertise the
  bridge again on native resumed turns. Gemini starts a fresh ACP session for
  every turn and advertises the bridge there; bounded application-visible
  transcript reconstruction carries conversational context without calling
  Gemini's currently unsafe asynchronous `session/load`. Codex App Server cannot
  inject dynamic tools into an already-live native thread, so the database
  capability epoch clears only its opaque native continuation once and starts
  the next turn with current tools; the Inertia conversation and visible
  transcript are preserved.

## Agent tools

The provider-neutral bridge exposes five tools:

- `inertia_browser_snapshot` returns a semantic snapshot of the active page.
- `inertia_browser_screenshot` captures one bounded local Evidence image and
  returns only capture metadata to the provider model.
- `inertia_browser_navigate` opens a validated local development URL.
- `inertia_browser_interact` clicks or types through a current semantic
  element reference, sends one allowlisted key, or performs a bounded scroll.
- `inertia_browser_tabs` lists, opens, activates, or closes browser pages.

Semantic snapshots include at most 200 visible interactive elements, 12,000
characters of normalized visible text, current viewport data, and a total 32
KiB UTF-8 process-boundary limit. Oversized snapshots are structurally reduced
and remain valid JSON. Element references are generated in an isolated
JavaScript world and become invalid when their DOM node disappears or is no
longer visible.

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
bytes. A document-level privacy guard still starts before the first inspection.
Once it observes a non-empty password value, semantic evidence and local
capture remain unavailable until that document navigates away, so reveal
controls, replacement inputs, and page-made copies remain covered by the
defense-in-depth guard.

## Local evidence

The Evidence view is an inspectable main-process ledger for the exact live
Browser slot. It is not provider context and is never written to SQLite, the
project, attachments, diagnostics, or renderer storage. Closing or replacing
the chat-owned Browser clears its entries, retained thumbnails, request
correlation, browser storage, and session listeners.

The ledger holds at most 100 descriptors in 128 KiB, eight PNG thumbnails of
at most 256 KiB each, and 2 MiB of thumbnails in total. It also limits page
events and in-flight request correlation before they reach the ledger. Older
or repeated evidence is coalesced or marked omitted instead of growing without
bound. Opening Evidence removes the native page from the visible geometry;
closing it restores the exact page and keyboard focus.

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

An aborted or settled call loses browser authority immediately. The utility
runtime allows at most 16 pending browser requests and applies a 20-second
deadline. Every request carries a fresh UUID plus the server-owned conversation,
run, and turn UUIDs. Cancellation must match all three identities. The main
process rejects reused request identities, aborts duplicate in-flight work, and
suppresses late results after cancellation, runtime replacement, or shutdown.

Gemini's separate ACP permission channel covers only tool actions the CLI
reports through `session/request_permission`; provider-side policy and allowlists
may authorize other Gemini tools without that notification. This limitation
does not bypass the Browser bridge's own exact-turn validation or its Inertia
approval for navigation and interaction.

## Security boundary

Each chat-owned Browser session is created without a `persist:` partition and
with context isolation, sandboxing, web security, and no Node integration.
The main process denies permission checks and requests, downloads, new windows,
remote navigation, and URLs containing credentials. Browser storage is cleared
when the owning slot closes.

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
  -> exact chat-owned WebContentsView
```

The agent cannot use this surface to read arbitrary files, upload a file,
grant a browser permission, start a download, retain cookies across ownership,
or control a page belonging to another conversation. File inputs never receive
semantic refs, focused activation is rejected, and a privileged chooser
boundary cancels direct or delayed selection while the exact agent-created
transient activation remains live. Native human selection is restored once
that causal capability expires.
