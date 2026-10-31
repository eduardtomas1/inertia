# Keyboard shortcuts

On macOS the modifier is ⌘; on Windows and Linux it's Ctrl.

## App shortcuts

| Action | Default |
|---|---|
| Search everything | ⌘K / Ctrl+K |
| New chat | ⌘N / Ctrl+N |
| Toggle project navigation | ⌘B / Ctrl+B |
| Toggle terminal | ⌘J / Ctrl+J |
| Open tasks | ⌘T / Ctrl+T |
| Open a surface | ⌘G / Ctrl+G |

Change them in **Settings → Keyboard → App shortcuts**. Each action uses ⌘ or Ctrl with one of B, G, H, J, K, N, T, U or Y, and no two actions can share a key. If you changed a shortcut to G before **Open a surface** existed, your choice stays and **Open a surface** takes the first free key instead.

**Open tasks** opens Tasks with the cursor in the add row, also while a Browser page has focus.

While a Browser page has focus, it hands back only the keys your app shortcuts are bound to, plus ⌘W / Ctrl+W to close the surface, and only with ⌘ on macOS or Ctrl on Windows and Linux. Every other chord stays with the page: an unbound key such as Ctrl+Y or Ctrl+U, and on macOS the Control text-editing keys such as Ctrl+H.

**Open a surface** shows the surface chooser for the current chat: the right panel's launcher when no surface is open, otherwise its **Add panel surface** menu. Then press a surface's letter on its own, without ⌘ or Ctrl.

Search everything (⌘K / Ctrl+K) also lists commands for the current chat once you type: **Open Changes** and the other surfaces, the Git actions the header currently allows (**Commit…**, **Fetch**, **Pull**, **Push**, **Create pull request…**, **Switch branch…**), **Toggle terminal dock** and **Open chat in a new window**. A command that is not available yet stays listed with the reason.

## Settings

| Action | Keys |
|---|---|
| Open or close Settings | ⌘, / Ctrl+, |
| Leave Settings | Esc (a text field keeps its text: the first Esc leaves the field, the next leaves Settings) |
| Move through search results | ↑ ↓ in **Search settings**, Enter to open the setting |
| Clear the search | Esc while the search has text |

## Global shortcut

| Action | Default |
|---|---|
| Window snapshot | ⌘⌥S / Ctrl+Alt+S, or both Shift keys together on macOS and Windows |

Turn on Window snapshots in **Settings → Devices & integrations**, and choose its shortcut in **Settings → Keyboard → Global shortcut**. It works while another app is in front.

## Sidebar

| Action | Keys |
|---|---|
| Move between chats in the Work list | ↑ ↓, Home, End |
| Open a chat's actions | Shift+F10 or the Menu key |

## Right-click menus

| Action | Keys |
|---|---|
| Open the menu for a focused message, file or changed file | Shift+F10 or the Menu key |
| Paste into a workspace terminal | ⌘V on macOS, Ctrl+V on Windows, Ctrl+Shift+V on Linux |
| Paste a code into a provider sign-in | ⌘V on macOS, Ctrl+V on Windows and Linux |

## Surfaces

| Action | Keys |
|---|---|
| Open a surface while the surface chooser is open | D Changes, F Files, B Browser, T Terminal, H Attachments, A Background tasks, U Usage, G Goal, P Plan |
| Close the active surface, or the window when no surface is open | ⌘W / Ctrl+W |
| Close a focused surface tab | Delete or Backspace |
| Move between surface tabs | ← →, Home, End |
| Move a focused surface tab left or right | ⌘⇧← / ⌘⇧→, Ctrl+Shift+← / Ctrl+Shift+→ |
| Find in a workspace terminal | ⌘F on macOS, Ctrl+Shift+F on Windows and Linux, while the terminal has focus; Enter, Shift+Enter for next and previous; Esc closes |

Changes, Files, Browser and Terminal are available after the chat's first message creates its workspace.

## Changes

| Action | Keys |
|---|---|
| Next or previous hunk | N, P in the diff |
| Select a diff line | Enter on the line |
| Extend the selection to a line in the same hunk | Shift+Enter, or Shift-click |

## Composer

| Action | Keys |
|---|---|
| Send, or send a follow-up while an agent works | Enter |
| Stop the agent and send, for agents that cannot take a follow-up mid-turn | Enter, while *Enter stops and sends · Tab queues* is shown |
| Queue a follow-up for the next turn | Tab, while *Enter sends · Tab queues* or *Enter stops and sends · Tab queues* is shown |

Type these in the composer:

| Type | What it does |
|---|---|
| `/goal` | View or set this chat's goal. |
| `/plan` | Switch this chat into plan mode. |
| `/build` | Switch this chat back to build mode. |
| `/resume` | Resume a provider chat from this folder in a terminal. |
| `/compact [instruction]` | Compact this chat's provider context, optionally with an instruction for the summary. |
| `$` and part of a name | Insert a provider skill. |
| `@` and part of a path | Mention a project file. |
| `@` and part of a chat title | Reference another chat. |
| `@this` | Reference this chat's earlier messages. |

In the suggestion lists, ↑ ↓ choose, Tab or Enter inserts and Esc dismisses.

## Split view

| Action | Keys |
|---|---|
| Resize the split | ← → (or ↑ ↓ when stacked) on the divider, with Shift for bigger steps |
| Smallest or largest split | Home, End |
| Reset the split | Enter on the divider, or double-click it |

## Welcome guide

| Action | Keys |
|---|---|
| Next or previous step | → ← |
| Next step | Enter |
| Choose a tour topic | ↑ ↓ |
| Close | Esc |
