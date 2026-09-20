# Attachment zoom and the expandable attachment gallery

These are actual Electron captures produced by
`tests/e2e/recent-attachments.spec.ts`, taken on Windows x64 with Node 22.23.1
and Electron 44.3.0 on the primary display. The project, conversation and every
attachment are synthetic fixtures created by the test; the user's installed app
and its profile were not opened, modified or photographed.

The fixture stubs the native file dialog and attaches copies of the bundled
`resources/icons` artwork, so each gallery tile is a distinct real image
decoded through the same validated `inertia://bundle/attachment-preview` route
the product uses. Provider execution stays disabled, so these are UI captures
rather than provider or signed-package certification. Linux and macOS were not
exercised locally.

The expanded gallery capture is taken after the test scrolls the gallery to its
end, which is why the first row is clipped above the scroll container.

## Captures

| Surface | Light | Dark |
| --- | --- | --- |
| Lightbox zoomed to 225% with the zoom controls | [Light](image-zoom-light.png) | [Dark](image-zoom-dark.png) |
| Collapsed panel showing the three most recent attachments | [Light](attachments-collapsed-light.png) | [Dark](attachments-collapsed-dark.png) |
| Expanded, scrolled gallery of every attachment in the chat | [Light](attachments-gallery-expanded-light.png) | — |
