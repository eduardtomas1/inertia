# Calm model selector — PR #332

These are actual Electron captures of the changed chooser, taken on Linux x64
with Node 22.23.2 and Electron 44.2.0 in an isolated X11 display. All projects,
models, conversations and history are synthetic. The user's running app was
not closed, modified or photographed.

The fixture disables provider execution. It supplies Codex and Claude readiness
to the renderer through the test WebSocket route; runtime commands, persisted
conversation identity and continuation checks still use the real runtime.
These captures are UI evidence, not authenticated provider or signed-package
certification. Windows and macOS were not exercised locally.

Before the captures, the five custom gateways used by the 600-model stress
scenario are disabled through the real Model backends settings. Their icons
then disappear from the chooser; usable custom gateways remain accessible.

## Captures

| Surface | Light | Dark |
| --- | --- | --- |
| Codex source, native rows and selected-model logo | [Light](model-chooser-codex-light.png) | [Dark](model-chooser-codex-dark.png) |
| Claude source and distinct Kimi backend identity | [Light](model-chooser-claude-light.png) | [Dark](model-chooser-claude-dark.png) |
| Content-sized frame after filtering to one model | [Light](model-chooser-filtered-light.png) | [Dark](model-chooser-filtered-dark.png) |
| Narrow new-chat layout with tools open | [Light](model-chooser-narrow-light.png) | [Dark](model-chooser-narrow-dark.png) |
| Closed selector with the provider logo | [Light](selected-model-chip-light.png) | [Dark](selected-model-chip-dark.png) |

The desktop captures use 1440 × 920 content bounds. Narrow captures request
720 × 640; Electron's minimum width produces 760 × 640 on this platform.
The selector captures are direct Playwright captures of the composer element.
No screenshot was retouched or generated.

## Reproduction and assertions

Run `npm run check`, then (without another build running concurrently):

```sh
INERTIA_E2E_WORKERS=1 npx playwright test tests/e2e/model-chooser.spec.ts --project=display-sensitive
```

Use an isolated display on a machine where a user is working. The two scenarios
verify established-chat and new-chat placement, visible/clickable search,
viewport containment, content-sized height (including one-result and empty
searches), loaded provider images, source selection, keyboard focus
and dismissal, favorites and reasoning identities, bounded 600-model
virtualization, runtime recycling, and persisted route boundaries. A provider
that is not ready, and any source with no selectable models, remain absent
from the source rail without erasing the current selection. They produce these images
as test attachments in `test-results`.
