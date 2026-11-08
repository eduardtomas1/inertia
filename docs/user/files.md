# Files

**Files** shows the project's files next to the chat. Open it from the workspace panel, or press F while the surface chooser is open. Files is available after the chat's first message creates its workspace.

- **Tree:** folders load as you expand them. Arrow keys move through the tree, Enter opens a file or folder, and Git badges mark changed files. Dependency and build folders such as `node_modules` and `dist` are left out of search.
- **Preview:** a file opens read-only with syntax highlighting. Markdown files show a rendered **Preview** or their **Source**. Very large files show only their beginning.
- **Edit:** the pencil button opens the file in an editing dialog. Saving checks that the file hasn't changed on disk since you opened it; if it has, reload it first.

## Search

Type in the search field at the top of the explorer, then choose what to search:

- **Names** matches file and folder paths.
- **Contents** finds text inside files. The search matches your text literally and ignores case, and shows each matching line with a short excerpt. Results take the preview area with the match count at the top; Enter or a click opens the file at that line, and **Back to results** returns to the list. Hidden files, binary files and files over 1 MB are skipped. A search stops after 200 matches, 64 MB read or 3 seconds and then says **Partial results**; make the text more specific to narrow it. Typing again replaces a search that is still running.

## Ask about or add selected lines

In the source view of a file, click a line number to select that line. Shift+click another line number, or press Shift+Enter on it, to select the range between them. With a line number focused, the arrow keys move between lines, and Shift with an arrow key extends the selection. Escape clears it.

- **Add to prompt** puts the file's name, the line range and the selected lines into the chat's message box.
- **Ask about** does the same and moves the cursor to a new line below the excerpt so you can type your question.

An excerpt holds at most 300 lines or 16 KB; a longer selection is shortened and the message says so. When the chat's message box isn't open, for example because the chat is in its own window, the selection stays and the toolbar says **Open this chat's message box to add the selection.** Line selection isn't available in a rendered Markdown preview, while the file is open in the editing dialog, or when no chat is open.
