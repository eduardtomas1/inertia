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
let promptDraft: { conversationId: string; value: string } | null = null;
let invitationDraft = "";
let deviceNameDraft = "";
let promptConversationId: string | null = null;

function captureDrafts(): void {
  const prompt = document.getElementById("remote-prompt-input");
  if (prompt instanceof HTMLTextAreaElement && promptConversationId) {
    promptDraft = {
      conversationId: promptConversationId,
      value: prompt.value,
    };
  }
  const invitation = document.getElementById("remote-invitation-input");
  if (invitation instanceof HTMLTextAreaElement) {
    invitationDraft = invitation.value;
  }
  const name = document.getElementById("remote-device-name");
  if (name instanceof HTMLInputElement) deviceNameDraft = name.value;
}

interface RemoteFieldFocus {
  id: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

function activeFieldFocus(): RemoteFieldFocus | null {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLTextAreaElement
      || active instanceof HTMLInputElement)
    || !active.id
  ) return null;
  return {
    id: active.id,
    selectionStart: active.selectionStart,
    selectionEnd: active.selectionEnd,
  };
}

function restoreFieldFocus(focus: RemoteFieldFocus | null): void {
  if (!focus) return;
  const field = document.getElementById(focus.id);
  if (
    !(field instanceof HTMLTextAreaElement
      || field instanceof HTMLInputElement)
  ) return;
  field.focus();
  if (focus.selectionStart === null || focus.selectionEnd === null) return;
  field.setSelectionRange(focus.selectionStart, focus.selectionEnd);
}

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
  const focus = activeFieldFocus();
  captureDrafts();
  root.replaceChildren();
  promptConversationId = null;
  renderInto();
  restoreFieldFocus(focus);
}

function renderInto(): void {
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
  name.id = "remote-device-name";
  name.maxLength = 80;
  deviceNameDraft ||= navigator.userAgent.includes("Mobile")
    ? "Mobile browser"
    : "Web browser";
  name.value = deviceNameDraft;
  label.append(name);
  const invitationLabel = document.createElement("label");
  invitationLabel.textContent = "Invitation";
  const invitation = document.createElement("textarea");
  invitation.id = "remote-invitation-input";
  invitation.rows = 8;
  invitation.spellcheck = false;
  invitation.value = invitationDraft;
  invitationLabel.append(invitation);
  section.append(label, invitationLabel);
  section.append(button(pairing ? "Waiting for desktop…" : "Pair", () => {
    if (pairing) return;
    pairing = true;
    void client.pair(invitation.value, name.value).then(() => {
      invitationDraft = "";
    }, (error: unknown) => {
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
  prompt.id = "remote-prompt-input";
  prompt.rows = 4;
  prompt.maxLength = 8_000;
  prompt.value = promptDraft?.conversationId === value.conversation.id
    ? promptDraft.value
    : "";
  promptConversationId = value.conversation.id;
  label.append(prompt);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Send to desktop";
  form.append(label, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = prompt.value;
    prompt.value = "";
    promptDraft = null;
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
