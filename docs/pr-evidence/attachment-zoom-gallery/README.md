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
rather than provider or signed-package certification. These committed captures
are from the original Windows verification; the macOS follow-up is recorded below.

The expanded gallery capture is taken after the test scrolls the gallery to its
end, which is why the first row is clipped above the scroll container.

## Captures

| Surface | Light | Dark |
| --- | --- | --- |
| Lightbox zoomed to 225% with the zoom controls | [Light](image-zoom-light.png) | [Dark](image-zoom-dark.png) |
| Collapsed panel showing the three most recent attachments | [Light](attachments-collapsed-light.png) | [Dark](attachments-collapsed-dark.png) |
| Expanded, scrolled gallery of every attachment in the chat | [Light](attachments-gallery-expanded-light.png) | — |

## Gallery image loading follow-up (2026-09-21)

Expanded galleries retain all 60 preview buttons, but mount original image
elements only while their tiles intersect the viewport and gallery scrollport.
An IntersectionObserver removes images when their tiles leave view and
disconnects when the tile unmounts. This bounds active gallery image elements
by visibility while keeping keyboard navigation, retained attachment IDs and
the original image used by the zoom dialog intact. Native lazy loading alone
would retain images after scrolling through them.

The DOM regression fails against the eager implementation (60 images mounted
instead of zero before visibility is reported). It then verifies entry, exit,
focus preservation and observer cleanup. The Electron regression uses 60 real
retained attachments, including an 8,000 × 5,000 PNG initially offscreen. It
checks actual decoded dimensions, clipped gallery geometry, scrolling by
keyboard focus, opening and zooming that image, Escape focus restoration and
removal of the large image after returning to the start. The existing native
scenario also covers both themes, PDFs and a missing retained file.

Final local verification used macOS ARM64, Node 22.23.2 and Electron 44.3.0:

- Focused renderer and zoom tests: 38 passed across five files.
- Large-WAL fixture tests: 21 passed. The normal merge of main already included
  the narrow 30-second allowance; this follow-up changes no WAL assertion or
  production deadline. The original Intel Mac slowdown was not reproduced here.
- `npm run check`: passed, including 9,603 tests (146 platform skips), lint,
  type checks, builds and the existing PR bundle caps without further increases.
- Both attachment Electron scenarios: passed with one worker in 19.8 seconds.

The final follow-up was not exercised on Windows, Linux or Intel Mac locally.
The regression proves visible-only mounting and real decoding; it does not
measure process RSS or promise immediate eviction of Chromium's image caches.
Provider execution and signed packaging are outside these renderer checks.
