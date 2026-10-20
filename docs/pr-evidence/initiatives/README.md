# Initiatives

Screenshots of the built Electron app on Linux x64 under Xvfb (1280×1024,
device scale 1), captured by `tests/e2e/initiatives.spec.ts` with
`INERTIA_E2E_EVIDENCE=1` and `animations: "disabled"`. The spec drives a fake
Codex app-server with synthetic chats and an initiative named "Checkout
redesign". No live profile, credentials, provider CLI or user history is used.
Every capture exists in a dark and a light variant.

`initiatives-tour.gif` is a slideshow of the dark captures in the order a user
meets them: the sidebar section, the composer picker, the Initiative page, the
brief editor, the notes review strip, the receipt under a user message, the
Tools & defaults rows, the access limit in the chooser, the MCP servers card
and an agent proposal in the chat.

| Capture | What it shows |
| --- | --- |
| `sidebar-initiative-section-*` | An active initiative as a collapsible section above Recent, with the attention badge and member count |
| `composer-initiative-picker-*` | The initiative picker next to the project picker in a new chat |
| `composer-initiative-chip-*` | The initiative chip in the composer's checkout line of a member chat |
| `initiative-page-*` | The Initiatives page with members grouped by status |
| `initiative-brief-*` | The brief editor with its revision line and byte counter |
| `initiative-notes-review-*` | Notes with an agent proposal under Needs review, showing its kind and source chat |
| `chat-initiative-receipt-*` | The Initiative context receipt under the user message that carried the brief |
| `chat-initiative-proposal-*` | The timeline row for a note an agent proposed |
| `initiative-tools-*` | Tools & defaults rows with inheritance hints |
| `composer-access-limit-*` | The access chooser with Full access disabled and the initiative's reason |
| `initiative-mcp-servers-*` | The MCP servers card with provider support line |
| `initiative-mcp-server-edit-*` | Editing a server whose secret header shows only "Set" |
| `chat-mcp-turn-*` | A member chat turn after the server configuration reached the provider |
