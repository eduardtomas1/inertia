Project Tools desktop evidence

- The feature-owned Electron scenario is `tests/e2e/project-tools.spec.ts`.
  Its first test exercises the real renderer, IPC, database, credential broker and
  run lifecycle with a deterministic Codex app-server fixture, and attaches
  configuration, available/authentication and restart-state screenshots to the CI
  artifacts. `configure.png` comes from that test.
- Its second test captures every state of the Tools panel in light and dark, at
  1440 × 920, 1000 × 800 and 760 × 600, and asserts the layout in the same run: no
  viewport or panel overflow, one scroll container, no nested buttons, no
  truncated connection titles, and the composer still ends at its dock.
- Live protocol smoke checks also connected a loopback HTTP MCP fixture to Claude
  Code 2.1.286 (Agent SDK 0.3.283) and Codex 0.159.3. Both reported `search_docs`
  through their native status APIs. These checks do not require a model turn.
- A real Claude bearer-authentication probe also passed: five authenticated HTTP
  requests, `search_docs` reported connected, and no token value in subprocess
  arguments. Claude expands the environment reference inside its process.
- Real Claude probes confirmed expansion in URLs and nested token values too.
  The connection validator and privileged token resolver reject these templates
  before launch; percent-encoded literal URL characters remain supported.

The cloud environment used for the original local run lacks
`/proc/<pid>/task/<pid>/children`, so Inertia's existing process guardian correctly
refuses native agent admission there. Native CI supplies the run-state evidence.

## Panel captures

Real screenshots of the built Electron app on macOS 27.0.1 (arm64) at device
scale 2, captured by `tests/e2e/project-tools.spec.ts` with
`animations: "disabled"`. All data is synthetic: three connections added through
the panel, a Codex app-server protocol fixture and one synthetic token variable.
No real provider, profile or credential is used.

The panel follows the other right-panel surfaces: the tab is the title, then one
row with a muted "Connections" label, the count and a compact "Add connection"
button, one sentence on scope, and one quiet card per connection. A card shows
the name, its status as an icon and a word, the providers and the URL on one line
(the URL truncates with the full value in its tooltip), the token variable, the
provider's reason, the confirmed tool names, and quiet "Edit" and "Remove" links.
Status colour is limited to the status word and icon. New connections open above
the list; an edit opens in place of its card. Errors appear where they happened:
validation and save errors in the form, a refused removal in its card.

| Before | After |
| --- | --- |
| ![Before: empty](before-tools-empty-dark-wide.png) | ![After: empty](tools-empty-dark-wide.png) |
| Hero header, intro line, bordered status box, dashed empty box, full-width add slab | One label row with the add button, one scope sentence, one muted empty sentence |
| ![Before: editor](before-tools-editor-light-wide.png) | ![After: editor](tools-editor-light-wide.png) |
| "(optional)" on its own line, nested bordered boxes, add slab disabled at 0.45 below the form | Labels on one line, styled fields with linked help, Cancel then Save on one baseline |
| ![Before: live](before-tools-live-dark-wide.png) | ![After: live](tools-live-dark-wide.png) |
| Tinted status pills, bordered provider and HTTP chips, focus returned to the bottom add slab, scrolling the first card away | Icon plus word status, plain provider text, tool names in monospace, focus returns to the add button at the top |
| ![Before: removal refused](before-tools-remove-blocked-light-wide.png) | ![After: removal refused](tools-remove-blocked-dark-wide.png) |
| The error rendered above the list, out of view; Remove was disabled while focused, so focus was lost | The error appears in the card; Remove keeps focus |
| ![Before: narrow](before-tools-live-light-narrow.png) | ![After: narrow](tools-live-light-narrow.png) |
| 1000 × 800 light | 1000 × 800 light |
| ![Before: 760 × 600](before-tools-live-dark-760x600.png) | ![After: 760 × 600](tools-live-dark-760x600.png) |
| 760 × 600 dark | 760 × 600 dark |

More states after the change:

| State | Capture |
| --- | --- |
| Empty, light | ![Empty light](tools-empty-light-wide.png) |
| New connection, dark | ![Editor dark](tools-editor-dark-wide.png) |
| New connection, 760 × 600 light | ![Editor 760 × 600](tools-editor-light-760x600.png) |
| Failed save (non-loopback HTTP) | ![Invalid](tools-editor-invalid-dark-wide.png) |
| Editing in place while a run holds the old configuration | ![Edit](tools-edit-dark-wide.png) |
| Live, light | ![Live light](tools-live-light-wide.png) |
| Live, 1000 × 800 dark | ![Narrow dark](tools-live-dark-narrow.png) |
| Needs restart after the edit | ![Restart](tools-restart-dark-wide.png) |

The loading line ("Loading connections…"), the disconnected notice and the passive
refresh failure are covered by `tests/renderer/project-tools.dom.test.tsx`; the
fixture runtime cannot be disconnected mid-scenario.

## Not exercised

- Linux and Windows rendering; forced colours and reduced motion in a real window.
- A real provider; every state above comes from the deterministic fixture.
