# Getting started

## Install

Download the latest release for macOS, Windows or Linux, on Intel/AMD or ARM64. The [installation guide](../INSTALLING.md) covers each platform and the Canary channel.

## The welcome guide

The first time Inertia opens on a new computer, a short guide introduces the app in four steps:

1. **Welcome.** What Inertia is, with small live demos of following your agents, working side by side, and reviewing before you ship.
2. **How it works.** A tour of short looping demos: split view, the Work tab, Duo, review and shipping, limits, and your keyboard shortcuts. Each has one line saying what to do.
3. **Connect an agent.** Which agents are ready on this computer, with **Set up** for any that need attention.
4. **Start.** A summary and **Add a project**.

Move between steps with **Back** and the primary button, or with the ← and → keys. **Skip** or Esc closes the guide. It doesn't come back on its own, but you can replay it from **Settings → Report an issue → Show welcome guide**.

## Add a project

Choose **Add your first project** on the home screen, or the add-project button next to **All projects** in the sidebar. You can open a **Local folder** or **Clone repository** from an HTTPS or SSH Git URL.

## Connect an agent

Open **Settings → Providers** and connect a provider. Inertia uses the accounts you already have: each provider keeps its own authentication, and custom backend credentials are stored in your operating system's credential vault. If a provider stops responding, refresh it in the same place.

For Codex, update the installed CLI from **Settings → Providers** when an update is available, then refresh the provider. Inertia reads models and their reasoning and speed options from that installation. GPT-6.1 Sol (`gpt-6.1-sol`) appears when Codex advertises it for your account; available options depend on your plan and workspace settings. See [OpenAI's model guide](https://learn.chatgpt.com/docs/models) for rollout details.

## Start a chat

Use **New chat** in the sidebar, or press ⌘N on macOS (Ctrl+N elsewhere). In the composer, choose the model, reasoning level and access mode, then describe the task.

### Access modes

- **Supervised** keeps provider approvals active.
- **Auto-edit** allows supported file edits without asking.
- **Full Access** is an explicit choice for a workspace and task you trust.

New chats start in the mode chosen in **Settings → Chats → New chats**. A project can start its new chats in another mode with **Settings → Projects → Default access**; you can still change the mode for each chat in the composer.

Next: [Chats and agents](chats-and-agents.md).
