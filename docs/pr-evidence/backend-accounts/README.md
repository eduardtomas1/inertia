# Accounts and API keys

Screenshots of the built Electron app on Windows (x64), taken by
`tests/e2e/backend-accounts-visual.spec.ts` at 1440 × 920 with
`animations: "disabled"` and the pointer moved away. The fixture is synthetic:
a seeded project and chat, Codex shown as signed in, Claude Code shown as
installed and signed out, and a local fake Anthropic-compatible endpoint served
by the end-to-end preview server on `127.0.0.1`. No live profile, provider
account, real API key or user repository is shown. The key typed into the
fixture is `fixture-key-not-a-real-secret`, which only the local fake accepts.

The Anthropic API key preset always connects to `https://api.anthropic.com`,
so the fixture route is a custom backend on the Claude harness with
**Allow localhost HTTP** turned on, named "Anthropic API key", with two models
(Claude Opus 5.5 and Claude Sonnet 5.5). It goes through the real setup: the
route is saved, the key is stored in the credential vault, the key is checked
against the fake endpoint's model list, and the route is turned on. The spec
then presses **Test**, which sends a short request to both models.

## Accounts and API keys

`accounts-and-api-keys-light.png`, `accounts-and-api-keys-dark.png`

Settings → Agents, scrolled to **Accounts and API keys**, with the line "A chat
uses one route at a time: the account, or an API key you choose in the model
chooser. You can keep both set up."

- **Claude Code**: Account "Signed out" with **Sign in through Claude Code**
  (it opens a menu with the account sign-in and **Sign in for API billing
  through Claude Code**). Under **API keys**, **Add API key** and the fixture
  row "Anthropic API key", "Custom · 127.0.0.1:‹port› · 2 models", state
  "Ready", with **Replace key**, **Test (uses a little credit)**, **Edit…**
  (a custom backend shows **Edit…**; a preset key shows **Models…**),
  **Turn off** and **Remove**.
- **Codex**: Account "Signed in" with **Refresh**, **Add API key**, and "No API
  keys yet. Add an OpenAI API key to use your API credits."
- **OpenCode**: Account "Checking…" and "OpenCode keeps its own keys. Use Sign
  in through OpenCode to run opencode auth login."
- **Cursor**: Account "Checking…" and "Account only, with usage not reported."

The Kimi Code and Antigravity cards are further down the page and are not in
the frame.

## Add API key dialog

`add-api-key-dialog-light.png`, `add-api-key-dialog-dark.png`

**Add API key** on the Claude Code card opens **Add Anthropic API key**: "The
key is stored in your system's credential vault. Inertia checks that it works;
each model is tested the first time a chat uses it." The name is prefilled
with "Anthropic API key", the empty **API key** field has focus, its hint reads
"Create one in the Anthropic Console. Usage is billed to your API credits.",
and **Models** offers **Use the default models** (Claude Fable 5.1, Claude Opus
5.5, Claude Sonnet 5.5, Claude Haiku 5.5) or **Discover models from the
endpoint**. The footer has **Cancel** and **Add API key**.

## Model chooser

`model-chooser-api-key-route-light.png`, `model-chooser-api-key-route-dark.png`

Before these screenshots the fixture marks Claude Code as signed in and
waits for the Claude Code card to show it. The chooser is opened from the
composer and searched for "Claude".
The rows, in order:

- **Provider default** · Claude: the Claude account route.
- **Claude Opus 5.5** and **Claude Sonnet 5.5** · Claude harness · Anthropic
  API key, marked Partial: the fixture's API key route. It reads as an API key
  rather than "Custom", and because it is a custom backend it keeps its own
  source in the rail.
- **K3**, **K3 256K**, **Kimi for Coding**, **Kimi for Coding High-speed** ·
  Kimi Code · Kimi · API key, marked Partial: the built-in Kimi key route,
  listed under Kimi Code. It matches the search through the Claude harness it
  runs on, so it comes after Claude's own routes.

| | Light | Dark |
| --- | --- | --- |
| Accounts and API keys | [accounts-and-api-keys-light](accounts-and-api-keys-light.png) | [accounts-and-api-keys-dark](accounts-and-api-keys-dark.png) |
| Add API key dialog | [add-api-key-dialog-light](add-api-key-dialog-light.png) | [add-api-key-dialog-dark](add-api-key-dialog-dark.png) |
| Model chooser, searching "Claude" | [model-chooser-api-key-route-light](model-chooser-api-key-route-light.png) | [model-chooser-api-key-route-dark](model-chooser-api-key-route-dark.png) |
