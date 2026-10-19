# Terminal

Each chat has terminals that run in the chat's folder: the project, or the chat's worktree when it has one. They are available after the chat's first message creates its workspace.

- **Dock or surface.** ⌘J (Ctrl+J elsewhere) shows or hides the terminal docked under the chat. Choose **Terminal** in the right panel's surface chooser (⌘G, then T) to open it as a surface instead.
- **Tabs.** **New terminal** adds a tab, up to four. Move between tabs with ← →, Home and End; Delete or a tab's close button ends that terminal.
- **Split.** **Split terminals** shows two terminals side by side, or stacked in a narrow panel. Drag the divider to resize it.
- **Session controls.** **Fit terminal** refits the terminal to its space, **Restart terminal** starts a fresh shell, and **Close terminal** ends it. **Hide terminal** hides it and keeps its terminals running.
- **Right-click** for **Copy**, **Paste**, **Select all** and **Clear**. ⌘V pastes on macOS, Ctrl+V on Windows and Ctrl+Shift+V on Linux.
- **Resume a provider chat.** Type `/resume` in the composer to open the terminal with **Resume chat**, which continues the chat's provider session in that provider's command-line tool. Choose another chat from the same folder when there is more than one. While a session is resumed there, end that terminal session before you send another message in Inertia. A session can be resumed in one tab at a time.
- **Project actions.** Actions you run from the header, such as a dev server or a check, start in a terminal tab.
