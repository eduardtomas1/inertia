import "./styles.css";

import type {
  RemoteSafeConversationDetail,
  RemoteSafeShell,
} from "../../../src/shared/remote-protocol";
import { RemoteCompanionClient } from "./remote-client";
import { appendRemoteText, button } from "./safe-dom";

const root = document.querySelector<HTMLElement>("#app")!;
if (!root) throw new Error("Remote Companion root is missing.");

let shell: RemoteSafeShell | null = null;
let detail: RemoteSafeConversationDetail | null = null;
let status = "Starting…";
let online = false;
let pairingCode: string | null = null;
let promptStatus: { message: string; uncertain: boolean } | null = null;
let pairing = false;

const client = new RemoteCompanionClient({
  status: (message, isOnline) => {
    status = message;
    online = isOnline;
    render();
  },
  pairingCode: (code) => {
    pairingCode = code;
    pairing = true;
    render();
  },
  shell: (value) => {
    shell = value;
    render();
  },
  detail: (value) => {
    detail = value;
    if (value === null) promptStatus = null;
    render();
  },
  promptResult: (message, uncertain) => {
    promptStatus = { message, uncertain };
    render();
  },
});

void client.initialize().then(
  () => render(),
  (error: unknown) => {
    status = error instanceof Error
      ? error.message
      : "The stored Remote Companion profile could not be opened.";
    render();
  },
);

function render(): void {
  root.replaceChildren();
  const header = document.createElement("header");
  const title = document.createElement("h1");
  title.textContent = "Inertia Remote Companion";
  header.append(title);
  appendRemoteText(
    header,
    status,
    `status ${online ? "online" : "offline"}`,
  );
  root.append(header);

  const profile = client.currentProfile();
  if (!profile) {
    renderPairing();
    return;
  }

  const device = document.createElement("section");
  device.className = "card";
  const heading = document.createElement("h2");
  heading.textContent = profile.deviceLabel;
  device.append(heading);
  appendRemoteText(
    device,
    `Permissions: ${profile.scopes.join(", ")} · expires ${new Date(profile.expiresAt).toLocaleString()}`,
    "muted",
  );
  device.append(
    button("Reconnect", () => void client.connect()),
    button("Forget this browser", () => {
      void client.forget().then(() => location.reload());
    }, "secondary"),
  );
  root.append(device);

  if (!shell) {
    appendRemoteText(root, "No live desktop state is available.", "empty");
    return;
  }
  const layout = document.createElement("div");
  layout.className = "layout";
  const navigation = document.createElement("nav");
  navigation.setAttribute("aria-label", "Conversations");
  for (const project of shell.projects) {
    const projectTitle = document.createElement("h2");
    projectTitle.textContent = project.name;
    navigation.append(projectTitle);
    for (const conversation of shell.conversations.filter(
      ({ projectId }) => projectId === project.id,
    )) {
      navigation.append(button(
        `${conversation.title} · ${conversation.status}`,
        () => client.selectConversation(conversation.id),
        detail?.conversation.id === conversation.id ? "selected" : undefined,
      ));
    }
  }
  layout.append(navigation);
  const content = document.createElement("section");
  content.className = "conversation";
  if (detail) renderDetail(content, detail, profile.scopes.includes("prompt"));
  else appendRemoteText(content, "Choose a conversation.", "empty");
  layout.append(content);
  root.append(layout);
}

function renderPairing(): void {
  const section = document.createElement("section");
  section.className = "card pair";
  const heading = document.createElement("h2");
  heading.textContent = "Pair this browser";
  section.append(heading);
  appendRemoteText(
    section,
    "On the desktop, enable Remote Companion and create a five-minute invitation. Compare the six-digit code before approving.",
    "muted",
  );
  const label = document.createElement("label");
  label.textContent = "Browser name";
  const name = document.createElement("input");
  name.maxLength = 80;
  name.value = navigator.userAgent.includes("Mobile")
    ? "Mobile browser"
    : "Web browser";
  label.append(name);
  const invitationLabel = document.createElement("label");
  invitationLabel.textContent = "Invitation";
  const invitation = document.createElement("textarea");
  invitation.rows = 8;
  invitation.spellcheck = false;
  invitationLabel.append(invitation);
  section.append(label, invitationLabel);
  section.append(button(pairing ? "Waiting for desktop…" : "Pair", () => {
    if (pairing) return;
    pairing = true;
    void client.pair(invitation.value, name.value).catch((error: unknown) => {
      status = error instanceof Error ? error.message : "Pairing failed.";
      pairing = false;
      render();
    });
  }));
  if (pairingCode) {
    appendRemoteText(section, `Comparison code: ${pairingCode}`, "pairing-code");
  }
  root.append(section);
}

function renderDetail(
  parent: HTMLElement,
  value: RemoteSafeConversationDetail,
  canPrompt: boolean,
): void {
  const heading = document.createElement("h2");
  heading.textContent = value.conversation.title;
  parent.append(heading);
  appendRemoteText(
    parent,
    `${value.conversation.providerLabel} · ${value.conversation.status}`,
    "muted",
  );
  if (value.waitingForLocalAction) {
    appendRemoteText(
      parent,
      "This run is waiting for an action on the desktop. Remote approvals and secret answers are unavailable.",
      "warning",
    );
  }
  const transcript = document.createElement("div");
  transcript.className = "transcript";
  for (const message of value.messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    appendRemoteText(article, message.role === "user" ? "You" : "Agent", "role");
    appendRemoteText(article, message.content, "message-content");
    transcript.append(article);
  }
  parent.append(transcript);
  if (value.activities.length > 0) {
    const activities = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `Safe workstream (${value.activities.length})`;
    activities.append(summary);
    for (const activity of value.activities) {
      appendRemoteText(
        activities,
        `${activity.title} · ${activity.status}`,
        "activity",
      );
    }
    parent.append(activities);
  }
  if (value.subagents.length > 0) {
    const subagents = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `Delegated agents (${value.subagents.length})`;
    subagents.append(summary);
    for (const subagent of value.subagents) {
      appendRemoteText(
        subagents,
        `${subagent.name ?? "Agent"} · ${subagent.providerLabel} · ${subagent.status}`,
        "activity",
      );
    }
    parent.append(subagents);
  }
  if (!canPrompt) {
    appendRemoteText(
      parent,
      "This device is view-only. Prompting must be enabled on the desktop.",
      "muted",
    );
    return;
  }
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "Text prompt";
  const prompt = document.createElement("textarea");
  prompt.rows = 4;
  prompt.maxLength = 8_000;
  label.append(prompt);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Send to desktop";
  form.append(label, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = prompt.value;
    prompt.value = "";
    promptStatus = null;
    void client.sendPrompt(value.conversation.id, content);
  });
  parent.append(form);
  if (promptStatus) {
    appendRemoteText(
      parent,
      promptStatus.message,
      promptStatus.uncertain ? "warning" : "status",
    );
  }
}
