# Themed custom agent marks

The six standing characters replace the earlier running figures. Cursor heads
are scaled to 70% of the initial themed studies, keeping their floating gap.
All twelve runtime WebPs and the editable Blender scenes are updated together.

- [Family preview](../../../source-assets/custom-agent-marks/family-preview.png)
- [Outfit details](../../../source-assets/custom-agent-marks/family-details.png)
- [Runtime marks on dark and light tiles](../../../source-assets/custom-agent-marks/app-review/contact-sheet.png)
- [Settings list, dark](settings-dark.png) / [light](settings-light.png)
- [Mark picker, dark](editor-dark.png) / [light](editor-light.png)

## Capture scope

The UI captures use the production `CustomAgentsSettings`, `CustomAgentEditor`,
`CustomAgentAvatar`, `SettingsPage` and their real styles in a local Vite browser
fixture. Six synthetic agents supply the role names and descriptions. The
fixture handles create/update commands in memory; it does not connect to a
provider, persisted user data, or Electron IPC. Import/export are unavailable
in this fixture. These are component screenshots, not packaged-app evidence.

Captured through Inertia Browser at 1280×960. The editor captures isolate the
production editor component, while list captures use the settings component.
The real edit → choose mark → save interaction was exercised. Dark and light
palettes are selected using the application's `data-theme` attribute. No image
compositing or retouching is applied to the screenshots.

Snapshot audits found no unnamed, overlapping or clipped interactive controls
in the final capture viewports. They flag the existing focusable page heading
as under 24 pixels tall. The source renders and exported WebPs are also inspected
for transparency, framing and visual consistency.

## Validation

- `npm run check`: quality checks and the full Vitest suite passed (1,419 test
  files, 17,788 tests; 9 files and 107 tests skipped). The process was terminated
  during the subsequent bundle build; a fresh `npm run build:bundle` passed,
  including private-connect and the renderer bundle gates.
- The mark picker tests verify the renamed labels and unchanged serialized IDs.
- The six Blender studio/transparent pairs pass the family review script.
- The twelve bundled WebPs preserve transparent margins and 256×256 dimensions.

Packaged Electron, native provider calls, Windows and macOS were not exercised
for this asset-only update.

The final bundle measurements are 40,166 bytes for deferred custom agent settings,
2,478,799 bytes for core JavaScript, and 242,951 bytes for entry CSS. Their exact
measured deltas (+5 / +24 / +81 bytes) are recorded in the bundle gate, without
additional headroom. Bundled WebP payload drops from 122,498 to 94,790 bytes.
The focused shared-contract, settings and bundle-import tests pass (35 tests).
