# Inertia Agent Browser

The Inertia Agent Browser is the existing native Preview surface extended into
an exact-chat, multi-page browser that coding agents can inspect and control.
It is not a Playwright process, a provider-specific browser skill, or a remote
browser service. Electron's privileged main process owns every page and the
local runtime receives only a narrow command broker.

## Product contract

- Open Preview for the chat that should own the browser. The browser remains
  unavailable to other chats, split panes, detached windows, and stale turns.
- A chat may hold at most eight ephemeral pages. Pages share that chat's one
  non-persistent browser session and disappear when ownership closes.
- Only loopback development origins accepted by the existing preview URL
  policy may be embedded or agent-controlled. Remote HTTPS addresses continue
  to open in the system browser; remote plaintext HTTP is rejected.
- The Browser chrome shows pages, the active page, and the latest agent action.
  Click and type actions also render a pointer and bounded label inside the
  visible page.
- Browser tools are injected automatically into the existing exact-turn host
  bridge for Codex, Claude, Cursor, Kimi Code, and OpenCode. No skill install is
  required.

## Agent tools

The provider-neutral bridge exposes five tools:

- `inertia_browser_snapshot` returns a semantic snapshot of the active page.
- `inertia_browser_screenshot` returns bounded PNG visual evidence directly to
  the provider model.
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

Screenshots are resized to at most 1600 by 1000 pixels and rejected above 4
MiB of decoded PNG data. Inertia does not write them to the repository,
attachment store, diagnostics, or its application database. They cross the
same bounded host-tool result path as the semantic text; each provider receives
the format its audited native tool or MCP transport supports. A document-level
privacy guard starts before the first inspection. Once it observes a non-empty
password value, semantic and visual evidence remain unavailable until that
document navigates away, so reveal controls, replacement inputs, and page-made
copies cannot turn a screenshot or snapshot into a credential channel.

## Permission behavior

Snapshots, screenshots, and page listing are read-only. In a Supervised chat,
navigation, interaction, and page mutations create one ordinary Inertia
approval tied to the exact provider tool call. Denial prevents the browser
action. Auto-edit and Full Access use their existing provider access contract
without adding a second Inertia approval.

An aborted or settled call loses browser authority immediately. The utility
runtime allows at most 16 pending browser requests and applies a 20-second
deadline. Every request carries a fresh UUID plus the owning conversation UUID;
the main process rejects reused identities, aborts duplicate in-flight work,
and suppresses late results after cancellation, runtime replacement, or
shutdown.

## Security boundary

Each chat-owned Browser session is created without a `persist:` partition and
with context isolation, sandboxing, web security, and no Node integration.
The main process denies permission checks and requests, downloads, new windows,
remote navigation, and URLs containing credentials. Browser storage is cleared
when the owning slot closes.

The renderer can request navigation, page selection, and bounds through a
strict preload API, but it never receives a `WebContents`, browser storage,
raw page DOM, or screenshot capability. The supervised utility process cannot
create Electron views directly. Its path is:

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
semantic refs, focused activation is rejected, and a document-start capture
guard cancels file-input clicks triggered indirectly during agent input while
leaving deliberate human interaction outside an agent action unchanged.
