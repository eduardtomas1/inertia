# Right-click in the main frame

Platform: macOS 27.0.1, Electron at device scale 2, window 1200x820. Captured with the E2E harness from a build of this branch, using the `seedAssistantCodeBlock` conversation fixture; the terminal prompt was set to `$ ` before capture so no machine name appears.

The menus themselves are native. The E2E specs replace `Menu.prototype.popup` to record them, so a native menu cannot be captured here. The images show the surfaces with a selection or focus, and the lists below are the exact items the specs assert (`tests/e2e/edit-context-menu.spec.ts`, `tests/main/context-menu-ipc.test.ts`, `tests/main/edit-context-menu.test.ts`, `tests/main/preview-context-menu.test.ts`). Before this change, right-clicking any of these surfaces showed nothing (or, in the terminal, the generic text-field menu acting on xterm's hidden textarea).

Unpackaged development builds add **Inspect Element** at the end of every surface menu; packaged builds never do.

## Menus by surface

| Surface | Items |
| --- | --- |
| Agent answer | Copy (only with a selection), Copy Message, Copy as Markdown |
| Your message | Copy (only with a selection), Copy Message |
| Code block | Copy (only with a selection), Copy Code |
| File link in an answer, changed file | Open, Reveal in Finder, Copy Path, Copy Relative Path |
| File in Files | Open, Reveal in Finder, Copy Path, Copy Relative Path |
| Folder in Files | Reveal in Finder, Copy Path, Copy Relative Path |
| Workspace terminal | Copy (disabled without a selection), Paste, Select All, Clear |
| Sign-in terminal | Copy (disabled without a selection), Paste, Select All |
| Web link (native) | Copy Link Address, Open Link, then Copy for a selection |
| Image (native) | Copy Image |
| Misspelled word in a text field | Up to five suggestions or "No suggestions", then the editing actions |
| Browser pane page | Editing actions or Copy for a selection, Copy Link Address on a link, Back, Forward, Reload |

Reveal reads "Reveal in File Explorer" on Windows and "Reveal in File Manager" on Linux. On macOS, Chromium selects the word under a right-click, so Copy also appears there for links and text.

| Surface | Light | Dark |
| --- | --- | --- |
| Answer with a selection | ![](surface-transcript-selection-light.png) | ![](surface-transcript-selection-dark.png) |
| Workspace terminal | ![](surface-terminal-light.png) | ![](surface-terminal-dark.png) |
