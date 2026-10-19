# Troubleshooting

Find what you're seeing below.

## An agent isn't listed, won't start or stops responding

- Open **Settings → Agents** and refresh the provider. The page shows whether it's installed and signed in.
- Each provider keeps its own sign-in. If it reports that you need to sign in, sign in with the provider's own tools, then refresh.
- The welcome guide's **Connect an agent** step shows the same readiness at a glance. Replay it from **Settings → Help → Welcome guide → Show welcome guide**.

## A chat is waiting and nothing happens

In **Supervised** mode the agent pauses for your approval. Open the chat and answer the request. The **Work** tab marks chats that need input.

OpenCode keeps admitted approval and question requests open while you decide. Its inactivity limit resumes after you answer; the overall run limit still applies.

## A provider feature is unavailable

Open **Settings → Agents**, choose the provider and open **Details** to see which features are ready, need setup, or are checked when a chat starts. The installation status above it shows the version Inertia verified. Some features depend on the selected model; Cursor only offers reasoning choices observed for that model.

## Update an agent's CLI

**Settings → Agents** offers **Update** when Inertia can tell what installed the CLI and your account can write it: the provider's own installer, npm (also through nvm or fnm), pnpm, bun, Yarn, Volta or Homebrew. Otherwise it shows the command to run in a terminal, such as `sudo npm install -g --prefix /usr @openai/codex@latest` for a system npm prefix or `sudo snap refresh <name>` for a snap. OpenCode updates stay on 1.x.

## I can't open another chat window

Up to eight chats can have their own windows at once. Close one, or bring a chat back into the main window, then try again.

## A chat can't be added to split view

A chat that already has its own window can't join split view. Choose the chat in the sidebar to focus its window, or close that window first.

## Find earlier messages in a long chat

Chats open with recent history. Choose **Load earlier messages** at the top of the transcript to read more. Message search and turn links load their destination when it is outside the current page, including in split and detached windows. Loading a page preserves your reading position.

If an individual turn is too large to display, Inertia reports that without disconnecting your other chats. Its saved history remains in the database and can be included in a data export from Settings.

## Launch Electron app is unavailable

**Launch Electron app** is greyed out while Inertia's local service is reconnecting, while a launch is starting, and while the chat already runs two launches; stop one first. The App surface itself is unavailable until the chat's first message has created its workspace.

When the button works but the launch fails, the App surface shows why:

- *This project has no node_modules/electron.* Install the project's dependencies in the chat's workspace, including its worktree if the chat has one, then launch again. Electron must be installed in the project folder itself; a global Electron, or one hoisted to or linked from a folder outside the project, is not used.
- *node_modules/electron has no Electron build for this platform.* Reinstall the project's dependencies on this computer.
- *The project's Electron files resolve outside its folder.* Install Electron as a dependency of this project instead of linking it.
- *No readable package.json*, or *the package.json main entry does not exist yet.* Open the chat in the Electron project's own folder, and build the app if its `main` points at build output.

**Settings → Projects → Agent app access** set to **Off** stops only the agent's App tools, which then report that access is disabled. You can still launch the app yourself. A project action needs no Electron; its windows, if it opens any, are read through accessibility.

## The agent says the app is showing a dialog

While an app window shows an alert, confirmation or prompt, nothing can be read from it, so the agent's snapshots, waits, screenshots and window list stop with a note naming the kind of dialog. Answer it yourself in the app window, or let the agent's next click, type or press answer it. In a **Supervised** chat that approval only answers the dialog; the agent then asks again for its action.

## A chat or project cannot be deleted because its app is still running

Deleting a chat or removing a project first stops every app it launched and waits until Inertia has confirmed that the whole process tree is gone. If that cannot be confirmed, the chat and its worktree are kept. Stop the app from the App surface, or quit it yourself, then try again.

## Log lines say console events were dropped

Inertia keeps at most 200 console messages a second from one launch, with short bursts of up to 400. When an app logs faster, the rest are counted and **Logs** shows one "console events dropped" line at most once a second.

## The app opened but no window is listed

- An Electron launch lists its windows over its debugging pipe. A project action lists its windows through the system's accessibility support; if none appear, see [The agent cannot inspect my app's windows](#the-agent-cannot-inspect-my-apps-windows).
- Windows appear once the app has created them and Inertia has connected to them, which can take a few seconds after the launch shows **Running**. DevTools windows are never listed. If nothing appears, check **Logs** for errors.
- Windows opened by a separate process that the app starts are not owned by the launch and are not listed.
- At most eight windows are listed per chat.
- A window whose page turns into DevTools or another internal page is removed from the list.
- If the app has exited, its launch shows **Exited** with its exit code; read **Logs** to see why.

## The agent cannot inspect my app's windows

Electron launches use their debugging pipe and are not affected. For a project action, open **Settings → Devices & integrations → App control**, and check the **Windows** section of the App surface, which names what blocks the launch:

- **macOS.** Allow Inertia in **System Settings → Privacy & Security → Accessibility** (the card's **Accessibility settings** button shows macOS's permission prompt and opens that pane), then return to Inertia. Screenshots also need **Screen Recording**.
- **macOS, helper denied.** If the card says macOS denied access to Inertia's App control helper although Inertia is allowed, this build's helper does not share Inertia's permission, so native windows cannot be read on this Mac. Read the app's output in **Logs** instead, and report the build and macOS version with **Settings → Help → Report an issue** ([Report a problem](#report-a-problem)).
- **Windows.** An app that runs as administrator cannot be read by Inertia, which runs without elevation. Start the app without administrator rights.
- **Linux.** Native windows are read over AT-SPI. If the card says the AT-SPI bus did not answer, or the App surface says accessibility support is turned off for this desktop session, turn on accessibility support for your desktop session (the `at-spi2-core` service) and restart Inertia. Chromium and Electron apps expose their windows only when started with `--force-renderer-accessibility` or with `ACCESSIBILITY_ENABLED=1`; until then the App surface says the app is not exposing its accessibility tree. Actions get the variable, but an app that clears its environment needs the switch in the action's arguments. On Wayland, windows can be read but screenshots are unavailable.
- **Fields that cannot be filled.** Some toolkits do not let accessibility clients set a field's value; Chromium and Electron on Linux are one. The agent then reports that the control does not support the action, and nothing is typed.
- **Protected apps.** Password managers, credential, password and PIN prompts (such as `ssh-askpass`, `pinentry` and Git Credential Manager), keyrings and wallets, consent prompts and system settings are never read, even when the app started them. The **Windows** list only counts them as protected apps.
- **Very large process trees.** If the app has started more than 1,024 processes, Inertia does not check part of them: window tools report that the app's process tree is too large to check. Stop processes the app started, or restart it.
- **App control could not start.** If Inertia's App control helper fails to start three times in a row, App control stays off and the App surface says so. Open **Settings → Devices & integrations → App control** to try again, or restart Inertia.
- **Screenshots after typing a password.** Once the agent has typed into a password or credential field of a launch, screenshots of every window of that launch are withheld. Restart the app to take one.
- **App control is off until Inertia restarts.** One of Inertia's helper processes could not be confirmed stopped. Quit and reopen Inertia.

## Pull, push or commit fails

Inertia explains Git failures, such as authentication, connectivity, a rejected non-fast-forward push, an index lock, a branch checked out elsewhere or a missing author identity, without exposing credentials. Pull only fast-forwards, and Inertia never force-pushes. See [Git workflows](../GIT_WORKFLOWS.md).

## Limits look stale, or a countdown reached zero

A countdown reaching zero doesn't refill the bar. The window shows **Reset due** until the provider reports new quota, and Codex and Claude are checked again a few seconds after the reset. When a provider is limiting quota checks, Limits says how long the provider asked Inertia to wait. It keeps the last reported numbers, marked stale, when it can confirm the same account; a Cursor login read from the macOS Keychain or a login without a stable account shows the message without numbers. **Refresh limits** asks right away. See [Provider usage limits](../USAGE_LIMITS.md).

## Inertia says it restored a backup or started with empty data

The recovery notice explains what happened and offers recovery actions, including copying a report. See [Database recovery](../DATABASE_RECOVERY.md).

## Check local storage and backups

Open **Settings → Data → Storage**. **Local storage** and **Full local database backup** measure the database, browser cache and temporary attachments while open, and show backup retention and the last validated backup. Backup files and saved attachment files are excluded from those measured totals. Clearing browser cache keeps chats and backups; archiving a chat keeps its data.

## Startup is blocked on Windows after an update

Follow the [profile recovery steps](../WINDOWS_STARTUP_RECOVERY.md).

## Report a problem

- **Settings → Help → Report an issue** builds the exact issue for you to review and edit. Nothing is submitted until you choose **Create on GitHub**. See [Issue reporting](../ISSUE_REPORTING.md).
- **Settings → Help → Diagnostics → Copy support summary** copies a bounded summary you can attach to a [bug report](https://github.com/eduardtomas1/inertia/issues/new?template=bug_report.yml).

Don't share raw logs, databases or credentials.
