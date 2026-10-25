# Getting started

## Install

Download the latest release for macOS, Windows or Linux, on Intel/AMD or ARM64. The [installation guide](../INSTALLING.md) covers each platform and the Canary channel.

## The welcome guide

The first time Inertia opens on a new computer, a short guide introduces the app in four steps:

1. **Welcome.** What Inertia is, with small live demos of following your agents, working side by side, and reviewing before you ship.
2. **How it works.** A tour of short looping demos: split view, the Work tab, Duo, review and shipping, limits, and your keyboard shortcuts. Each has one line saying what to do.
3. **Connect an agent.** Which agents are ready on this computer, with **Set up** for any that need attention.
4. **Start.** A summary and **Add a project**.

Move between steps with **Back** and the primary button, or with the ← and → keys. **Skip** or Esc closes the guide. It doesn't come back on its own, but you can replay it from **Settings → Help → Welcome guide → Show welcome guide**.

## Add a project

Choose **Add your first project** on the home screen, or the add-project button next to **All projects** in the sidebar. You can open a **Local folder** or **Clone repository** from an HTTPS or SSH Git URL.

## Connect an agent

Open **Settings → Agents** and connect a provider. Inertia uses the accounts you already have: each provider keeps its own authentication. To use API credits instead, add an API key under [Accounts and API keys](#accounts-and-api-keys); keys are stored in your operating system's credential vault. If a provider stops responding, refresh it in the same place.

The sign-in runs the provider's own login in a terminal. When the provider asks for a code, paste it there with ⌘V (Ctrl+V on Windows and Linux) or right-click and choose **Paste**. After **Copy link** or **Open again**, the terminal keeps focus, so the paste lands in it when you come back from the browser. The pasted code goes only to the provider's login; Inertia does not store it or add it to diagnostics.

For Codex, update the installed CLI from **Settings → Agents** when an update is available, then refresh the provider. Inertia reads models and their reasoning and speed options from that installation. GPT-6.1 Sol (`gpt-6.1-sol`) appears when Codex advertises it for your account; available options depend on your plan and workspace settings. See [OpenAI's model guide](https://learn.chatgpt.com/docs/models) for rollout details.

## Accounts and API keys

**Settings → Agents → Accounts and API keys** has one card per provider. Each card shows the provider account, and the API keys you can use instead of it.

A chat uses one route at a time: the account, or an API key you choose in the model chooser. You can keep both set up. Rows that run on an API key read *‹name› · API key*; account rows keep the account name and, when the provider reports it, the kind of sign-in, such as *Console API key* or *ChatGPT account*.

**Your own login, through the agent's CLI.** Each **Sign in through …** button runs the agent's own login in a terminal. Inertia never reads or stores a provider's login tokens; the CLI keeps them.

**API keys for credits.** An API key bills your provider's API credits instead of a subscription. Keys are stored in your operating system's credential vault, never in Inertia's database.

**Antigravity.** Google says wrapping agy in another app isn't supported on consumer plans and points to a Gemini API key. Inertia doesn't offer a Gemini API key route yet, so Antigravity runs on its own sign-in.

**Usage for Cursor and Kimi.** Cursor and Kimi Code don't report usage to Inertia, so **Usage → Limits** shows *Usage is not reported by this agent.* for them.

What each provider supports:

| Provider | Account | API key |
|---|---|---|
| Claude Code | **Sign in through Claude Code** offers your Claude account or **Sign in for API billing through Claude Code**, which uses your Anthropic Console credits. Once you are signed in, **Sign in for API billing through Claude Code** sits beside **Refresh**. | **Add API key** for an Anthropic API key. |
| Codex | **Sign in through Codex** runs Codex's own sign-in. | **Add API key** for an OpenAI API key. |
| Kimi Code | **Sign in through Kimi Code** runs Kimi Code's own sign-in. Usage is not reported. | A built-in Kimi key route. Choose **Add key** on its row. It runs on the Claude Code harness, so Claude Code must be installed. |
| OpenCode | **Sign in through OpenCode** runs `opencode auth login`. | OpenCode keeps its own keys; add them with `opencode auth login`. |
| Cursor | **Sign in through Cursor** runs Cursor's own sign-in. Usage is not reported. | Account only. |
| Antigravity | Sign in with Antigravity's own prompt; see the note above. | Account only. |

### Add an API key

1. On the provider's card, choose **Add API key**.
2. Keep the suggested name or type your own, then paste the key. Inertia trims spaces and line breaks around it.
3. Choose **Use the default models**, or **Discover models from the endpoint** to pick from the models your key can use once it is saved. A route can list up to 128 models.
4. Choose **Add API key**. Inertia saves the route, stores the key in your operating system's credential vault, checks that the key works and turns the route on. The key check lists the provider's models, which costs nothing. The new row shows **Setting up…** right away, and the dialog closes on its own once the route is ready. You can close it sooner; the setup carries on. If a step fails, the dialog stays open with the reason; fix the key or the models and choose **Try again**. If you already closed it, the row shows the reason and **Try again**.

Models are tested the first time a chat uses them: Inertia checks the model just before the chat starts, and the composer shows **Checking the backend…** for that moment.

The provider's command-line tool must be installed for its API keys to appear in the model chooser. You don't need to be signed in to its account.

Each key row has **Test (uses a little credit)**, **Replace key**, **Models…** (**Edit…** for a custom backend), **Turn off** or **Turn on**, and **Remove**:

- **Test** sends a short request to every model and lists each result, with the reason when one fails, so it uses a small amount of credit. A model that fails stays unavailable in the model chooser; the others keep working. **Test** never turns on a route you turned off.
- **Replace key** stores a new key and tests it. The route, its chats and its models stay as they are. The field shows *Stored secret, enter a new value to replace*; leaving it empty keeps the saved key.
- **Models…** lets you add, rename or remove models, or **Discover models** from the endpoint and choose which to add.
- Inertia re-tests a working route about once a day in the background. A route whose last test has expired, or that has not been tested yet, can still send: Inertia checks it just before the chat starts and stops only if that check fails. While a background check runs for a model that cannot be used yet, the composer shows **Checking the backend…**.

**Test** checks models 16 at a time, so a long list is tested in several passes, and the progress shows how many are done, such as *Tested 16 of 40 models…*. If the backend runs out of time, Inertia carries on with the models it has not reached yet.

When a chat on an API key fails, the composer says what to do: add credits in the Anthropic Console or at platform.openai.com for an Anthropic or OpenAI key, or check your credits with a custom backend's provider; **Replace key** for a rejected key; wait until the time shown for a rate limit; or **Edit models** for a model the provider no longer offers. Chats on a subscription keep the usage-limit notice.

Usage and limits are not available for API keys; the API key's provider bills it to your API account.

### Custom backends

**Add custom backend…** at the end of the section routes chats through your own Anthropic- or OpenAI-compatible endpoint, such as a company gateway. Choose the Claude or Codex harness, enter the base URL, the authentication, the key and the model IDs. Inertia shows the address it will connect to under **Base URL**. Claude-compatible backends need an API key or bearer token, because without one Claude Code would send your Anthropic account sign-in to that host; a keyless one shows *Add an API key or bearer token to use this backend.* and **Add key**. Custom backends appear on the Claude Code or Codex card. Changing a custom backend's address, protocol or authentication needs the key again: **Edit…** asks for it before saving, then tests the route and turns it back on if it was on.

Endpoints must use HTTPS. **Allow localhost HTTP** lets a backend on this computer use plain HTTP, for local development only. **Allow private network addresses** lets a backend reach an address on your own network or VPN, such as `10.0.0.5`; turn it on only for a server you trust.

## Start a chat

Use **New chat** in the sidebar, or press ⌘N on macOS (Ctrl+N elsewhere). In the composer, choose the model, reasoning level and access mode, then describe the task.

### Access modes

- **Supervised** keeps provider approvals active.
- **Auto-edit** allows supported file edits without asking.
- **Full Access** is an explicit choice for a workspace and task you trust.

New chats start in the mode chosen in **Settings → Chats → New chats**. A project can start its new chats in another mode with **Settings → Projects → Default access**; you can still change the mode for each chat in the composer.

Next: [Chats and agents](chats-and-agents.md).
