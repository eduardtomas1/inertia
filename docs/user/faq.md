# FAQ

## Does Inertia send my code to its own cloud?

No. History and preferences stay on your computer. Agents run through the providers you connect, and each provider keeps its own authentication. API keys and custom backend credentials are stored in your operating system's credential vault, never in Inertia's database.

## Which agents does Inertia support?

Codex, Claude, Cursor, Antigravity, Kimi Code and OpenCode. Connect them in **Settings → Agents**.

## Do I need a new subscription?

No. Inertia uses the coding accounts you already have with each provider.

## Can I use API credits instead of a subscription?

Yes. In **Settings → Agents → Accounts and API keys**, choose **Add API key** on the Claude Code card for an Anthropic API key, or on the Codex card for an OpenAI API key. For Claude Code you can also choose **Sign in for API billing through Claude Code**, which uses your Anthropic Console credits. It is under **Sign in through Claude Code** while you are signed out, and beside **Refresh** once you are signed in. Antigravity is account only for now. The provider's command-line tool must be installed, but you don't need to sign in to its account. See [Accounts and API keys](getting-started.md#accounts-and-api-keys).

## Does a chat use my account or my API key?

The route you choose in the model chooser. Rows that run on an API key read *‹name› · API key*; account rows keep the account name. You can keep both set up and switch per chat.

## Can I use Kimi with an API key?

Yes. The Kimi Code card has a built-in Kimi key route: choose **Add key** on its row. It runs through Claude Code, so Claude Code must be installed.

## Is Full Access safe?

It lets the agent act without asking, so choose it only for a workspace and task you trust. **Supervised** keeps the provider's approvals, and **Auto-edit** allows supported file edits only.

## Can I work on several chats at once?

Yes. Use [split view](working-side-by-side.md), give chats their own windows, or launch a [Duo](duo.md).

## Can a watcher change my files?

Not by default. A [watcher](watcher.md) is read-only unless you give it chat access when you add it. On Claude Code, Codex and OpenCode, a read-only watcher's approval requests, including requests to edit a file, are declined automatically, and Inertia stops a check in which the watcher starts to edit a file. If files change during a check in which the watcher started an edit or ran a command outside its read-only allowlist, and no running agent accounts for them, the watcher pauses and lists the paths. Every agent can be a watcher, but on Cursor, Kimi Code and Antigravity Inertia holds it to read-only less strictly; see [Which agents can be watchers](watcher.md#which-agents-can-be-watchers).

With **Supervised**, **Auto-accept edits** or **Full access**, the watcher works like a chat with that access, and its approvals appear in the watcher chat.

## Can the watcher run commands?

A read-only watcher runs only read-only ones. On Claude Code and OpenCode it runs commands from Inertia's read-only allowlist, such as `git diff`, `git log`, `rg` and `cat`, without asking, and Inertia declines any other command that reaches it. Claude Code also runs its own read and search tools without asking; its commands go through the same allowlist. Codex runs its own known-safe read-only commands inside its read-only sandbox. See [Read-only guarantees](watcher.md#read-only-guarantees). A watcher you gave chat access runs commands like a chat with that access.

## Can I use Inertia from another device?

[Private Connect](../PRIVATE_CONNECT.md) gives scoped access from another device over Tailscale while the desktop is online. Read its [security model](../PRIVATE_CONNECT_SECURITY.md) for the boundaries.

## How do I change a keyboard shortcut?

Open **Settings → Keyboard**. See [Keyboard shortcuts](keyboard-shortcuts.md).

## How do I see the welcome guide again?

Open **Settings → Help** and choose **Show welcome guide**.

## Where do I report a problem?

See [Troubleshooting](troubleshooting.md#report-a-problem).
