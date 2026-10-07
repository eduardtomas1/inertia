# Visual replies

These are real Electron captures produced by `tests/e2e/html-render.spec.ts`,
taken on Linux x64 under `xvfb-run` with Node 22.22.0 and Electron 44.5.1 in a
1280 × 960 window. The project, conversation, turn and both pages are synthetic
fixtures the test seeds through `RuntimeStore` before launch. No user profile
or installed app was opened, modified or photographed.

The fixture seeds one completed Codex turn. Two `html_renders` rows and their
turn-scoped system messages sit before the final answer: a three-card product
mock ("Treatment A: settled row", seeded height 320) and a short comparison
table. Both pages are styled only with the theme variables Inertia injects
(`--background`, `--foreground`, `--card`, `--border`, `--accent`,
`--muted-foreground`, `--radius`, `--font-sans`). Each page is served through
the privileged `inertia://render/<id>` route with its own sandboxing policy.
Provider execution stays disabled, so the agent's `inertia_render_html` call
itself is not part of these captures. The server tests cover that call.

## Captures

| Surface | Light | Dark |
| --- | --- | --- |
| Two visual replies stacked above the final answer of their turn | [Light](inline-light.png) | [Dark](inline-dark.png) |
| "Open full size" dialog with a second frame of the same page | — | [Dark](full-size-dialog-dark.png) |

The light capture comes from the live switch: Appearance is set to System, and
the emulated OS scheme flips from dark to light while the page stays mounted.

## What the scenario verifies

- Both renders appear in message order inside the turn's `html-renders` layer,
  above the final answer. Each frame reaches `data-html-render-state="ready"`
  through its size message.
- Each inline frame is exactly `sandbox="allow-scripts"` with
  `referrerpolicy="no-referrer"`. Its height fits the page's own content
  height, which differs from the seeded 320 px.
- The page's computed `html` background equals the app's resolved
  `--conversation-canvas-surface`, and `color-scheme` matches the app in dark
  and light.
- A live theme change reaches the mounted page by message: a marker set inside
  the frame survives the switch and the frame URL is unchanged. Opening
  Settings replaces the chat view, so the page remounts there and is themed by
  its URL fragment instead.
- Clicking the page's `https://example.com/docs` link calls the main process's
  `shell.openExternal`, which the test stubs, exactly once. The frame does not
  navigate.
- The full-size dialog is a modal named by the title. Focus lands on its Close
  button, Escape closes it, and focus returns to the "Open … full size" button.
- After a window reload, the stored render comes back and is themed again.
- Probes inside the page:
  - `window.parent.document` is unreachable and `window.inertia` is undefined.
  - Fetching `inertia://bundle/index.html` rejects, and an
    `inertia://bundle/attachment-preview/…` image fails (a `data:` image still
    loads as a control).
  - `window.open` returns `null` and `document.referrer` is empty.
  - `self.origin` is `"null"` and `localStorage` is blocked. `location.origin`
    still reports the URL's `inertia://render`, as the URL spec requires.
  - In the parent, a message posted by the frame arrives with
    `event.origin === "null"` and is applied.

## Not exercised here

- macOS and Windows. A packaged or signed build.
- A real provider calling `inertia_render_html`.
- Detached chat windows: the route's conversation-scope check is covered only
  by `tests/main/app-protocol.test.ts` ("serves a detached window only pages
  from its own conversation").
- Custom color palettes beyond the default light and dark tokens.
- Pages near the 256 KiB or 2000 px limits.
