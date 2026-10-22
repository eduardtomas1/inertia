import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readSourceText } from "../helpers/source-text";
import { MultiSpawnDialog } from "../../src/renderer/src/components/MultiSpawnDialog";
import type { MultiSpawnDraft } from "../../src/renderer/src/utils/multiSpawn";
import {
  defaultSettings,
  type AppSnapshot,
  type ProviderInfo,
} from "../../src/shared/contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-21T10:00:00.000Z";

const provider: ProviderInfo = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
  version: "1.0.0",
  executable: "/opt/bin/codex",
  installState: "installed",
  authState: "authenticated",
  canRun: true,
  statusMessage: null,
  models: [{
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Test model",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [],
    defaultReasoningEffort: "",
  }],
  rateLimits: [],
  metadataState: {
    models: { freshness: "fresh", provenance: "provider", updatedAt: now, lastAttemptedAt: now, refreshing: false },
    rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
  },
};

const settings = { ...defaultSettings, defaultProvider: "codex" as const, defaultModel: "gpt-5.6-sol" };
const snapshot: AppSnapshot = {
  projects: [{
    id: projectId,
    name: "Inertia",
    path: "/workspace/inertia",
    normalizedPath: "/workspace/inertia",
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: "",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#6366f1",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  }],
  conversations: [],
  providers: [provider],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  settings,
  activeProjectId: projectId,
  activeConversationId: null,
};

function renderDialog(props: Partial<React.ComponentProps<typeof MultiSpawnDialog>> = {}) {
  const onSubmit = vi.fn(async (_draft: MultiSpawnDraft) => undefined);
  const view = render(
    <MultiSpawnDialog
      open
      snapshot={snapshot}
      settings={settings}
      submitting={false}
      error={null}
      onClose={vi.fn()}
      onSubmit={onSubmit}
      onOpenProviderSetup={vi.fn()}
      onOpenBackendSetup={vi.fn()}
      {...props}
    />,
  );
  return { ...view, onSubmit };
}

function footerStatus(): HTMLElement {
  const status = document.querySelector<HTMLElement>(".dialog-shell-footer .multi-spawn-footer-status");
  if (!status) throw new Error("Expected the footer status line.");
  return status;
}

describe("New duo validation", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps Start enabled and explains the first problem in the footer on click", async () => {
    const { onSubmit } = renderDialog();
    const start = screen.getByRole("button", { name: "Start duo" });
    const status = footerStatus();
    expect(status).toHaveAttribute("role", "status");
    expect(status.nextElementSibling).toHaveTextContent("Cancel");
    expect(status).toBeEmptyDOMElement();
    expect(start).toBeEnabled();
    expect(start).not.toHaveAttribute("title");
    expect(screen.getByLabelText("Chat A name")).toHaveAttribute("placeholder", "Chat name");
    expect(screen.getByLabelText("Chat B name")).toHaveAttribute("placeholder", "Chat name");

    fireEvent.click(start);
    const brief = screen.getByLabelText("Brief for both chats");
    expect(status).toHaveTextContent("Write the brief first.");
    expect(brief).toHaveFocus();
    expect(brief).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(brief, { target: { value: "Review the updater." } });
    expect(status).toBeEmptyDOMElement();
    expect(brief).not.toHaveAttribute("aria-invalid");

    const nameA = screen.getByLabelText("Chat A name");
    fireEvent.change(nameA, { target: { value: " " } });
    expect(status).toHaveTextContent("Name chat A.");
    fireEvent.click(start);
    expect(nameA).toHaveFocus();
    expect(nameA).toHaveAttribute("aria-invalid", "true");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(nameA, { target: { value: "Updater review A" } });
    fireEvent.click(start);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(status).toBeEmptyDOMElement();
  });

  it("opens the judge settings to focus a missing judge name", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Brief for both chats"), { target: { value: "Compare." } });
    fireEvent.click(screen.getByRole("switch", { name: "Add an independent judge" }));
    const judgeConfig = document.querySelector("details.multi-spawn-judge-config");
    expect(judgeConfig).not.toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("Judge name"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Start duo" }));

    expect(judgeConfig).toHaveAttribute("open");
    expect(screen.getByLabelText("Judge name")).toHaveFocus();
    expect(footerStatus()).toHaveTextContent("Name the judge.");
  });

  it("disables Start only while offline or starting", () => {
    const { rerender } = renderDialog({ offline: true });
    expect(screen.getByRole("button", { name: "Start duo" })).toBeDisabled();

    rerender(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting
        error={null}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );
    const starting = screen.getByRole("button", { name: /Starting…/u });
    expect(starting).toBeDisabled();
    expect(starting).toHaveTextContent(/^Starting…$/u);
  });

  it("anchors the dialog to the top and stacks A over B on narrow windows", () => {
    const css = readSourceText("src/renderer/src/components/MultiSpawnDialog.css");
    expect(css).toMatch(/\.multi-spawn-dialog \{\n  --dialog-width: 980px;\n  align-self: start;\n  max-height: min\(860px, calc\(100dvh - 72px\)\);\n  margin-top: 24px;\n\}/u);
    expect(css).toMatch(/@media \(max-height: 560px\) \{\n  \.multi-spawn-dialog \{\n    max-height: min\(860px, calc\(100dvh - 48px\)\);\n    margin-top: 0;/u);
    expect(css).toMatch(/@media \(max-width: 820px\) \{\n  \.multi-spawn-sides \{\n    grid-template-columns: minmax\(0, 1fr\);\n  \}\n\n  \.multi-spawn-preset-toggle small \{\n    display: none;/u);
    expect(css).not.toMatch(/@media \(max-width: 620px\) \{\n  \.multi-spawn-sides/u);
  });
});
