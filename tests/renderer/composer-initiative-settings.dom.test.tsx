import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversation, Project, ProviderInfo } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import { MODEL_FAVORITES_STORAGE_KEY } from "../../src/renderer/src/utils/modelFavorites";
import { composerAccessCeiling } from "../../src/renderer/src/utils/initiativeAccess";
import { defaultInitiativePreferences } from "../../src/shared/initiatives";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { composerProps, conversation, provider } from "./composer-fixtures";

afterEach(() => {
  window.localStorage.clear();
});

const AT = "2026-10-19T08:00:00.000Z";
const project: Project = {
  id: "77777777-7777-4777-8777-777777777777",
  name: "Studio",
  path: "/workspace/studio",
  normalizedPath: "/workspace/studio",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 128,
  color: "#5661d8",
  status: "ready",
  createdAt: AT,
  updatedAt: AT,
};

const ceiling = composerAccessCeiling({
  name: "Checkout",
  preferences: { ...defaultInitiativePreferences(), accessCeiling: "auto-edit" },
});

describe("composer in an initiative", () => {
  it("disables access above the initiative's limit and says why", async () => {
    const onUpdateConversation = vi.fn(() => Promise.resolve());
    render(<Composer {...composerProps(conversation("ceiling"), { accessCeiling: ceiling, onUpdateConversation })} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose project access. Current access: Supervised." }));
    const access = screen.getByRole("menu", { name: "Project access" });
    const full = within(access).getByRole("menuitemradio", { name: /Full access/u });
    expect(full).toBeDisabled();
    expect(full).toHaveTextContent("“Checkout” limits chats to Auto-accept edits.");
    fireEvent.click(full);
    expect(onUpdateConversation).not.toHaveBeenCalled();

    const edits = within(access).getByRole("menuitemradio", { name: /^Auto-accept edits/u });
    expect(edits).toBeEnabled();
    expect(edits).not.toHaveTextContent("limits chats");
    fireEvent.click(edits);
    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledWith({ accessMode: "auto-edit" }));
  });

  it("lowers a starred model's saved access to the initiative's limit", async () => {
    const favorite = providerNativeModelSelection({ providerId: "codex", modelId: "agent", reasoningEffort: "high" });
    window.localStorage.setItem(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify({ version: 2, favorites: [{
      harnessId: favorite.harnessId, backendProfileId: favorite.backendProfileId, modelId: "agent",
      reasoningEffort: "high", configuration: { accessMode: "full", interactionMode: "plan" },
    }] }));
    const available: ProviderInfo = { ...provider, models: [{
      id: "agent", label: "Saved Agent", description: "", isDefault: true, inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }], defaultReasoningEffort: "high",
    }], metadataState: { ...provider.metadataState, models: {
      ...provider.metadataState.models, freshness: "fresh", provenance: "provider",
    } } };
    const onUpdateConversation = vi.fn(() => Promise.resolve());
    render(<Composer {...composerProps(conversation("favorite"), {
      providers: [available], accessCeiling: ceiling, onUpdateConversation,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(screen.getByTitle("Saved Agent").closest("button")!);
    await waitFor(() => expect(onUpdateConversation).toHaveBeenCalledOnce());
    expect(onUpdateConversation).toHaveBeenCalledWith(expect.objectContaining({
      accessMode: "auto-edit",
      interactionMode: "plan",
    }));
  });

  it("explains that Antigravity cannot run under a Supervised limit and does not send", () => {
    const antigravity: ProviderInfo = { ...provider, id: "antigravity", label: "Antigravity", command: "agy" };
    const chat: Conversation = {
      ...conversation("antigravity"),
      providerId: "antigravity",
      modelSelection: providerNativeModelSelection({ providerId: "antigravity", modelId: "provider-default" }),
    };
    const supervised = composerAccessCeiling({
      name: "Checkout",
      preferences: { accessCeiling: "supervised" },
    });
    const onSend = vi.fn(async () => undefined);
    const { rerender } = render(<Composer {...composerProps(chat, {
      providers: [antigravity], accessCeiling: supervised, onSend,
    })} />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Access limit");
    expect(notice).toHaveTextContent("“Checkout” limits chats to Supervised. Antigravity cannot run supervised.");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Ship it" } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    // An Auto-accept edits limit is one Antigravity can stay within.
    rerender(<Composer {...composerProps(chat, { providers: [antigravity], accessCeiling: ceiling, onSend })} />);
    expect(screen.queryByText(/Antigravity cannot run supervised/u)).not.toBeInTheDocument();
  });

  it("offers every access mode without a limit", () => {
    expect(composerAccessCeiling({ name: "Open", preferences: defaultInitiativePreferences() })).toBeUndefined();
    expect(composerAccessCeiling(null)).toBeUndefined();
    render(<Composer {...composerProps(conversation("no-ceiling"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose project access. Current access: Supervised." }));
    expect(within(screen.getByRole("menu", { name: "Project access" })).getByRole("menuitemradio", { name: /Full access/u }))
      .toBeEnabled();
  });

  it("names the initiative a new chat's model comes from", () => {
    render(<Composer {...composerProps(conversation("new-chat"), {
      newChatProjectPicker: { projects: [project], selectedProject: project, disabled: false, onChange: () => undefined },
      modelSourceLabel: "From initiative “Checkout”",
    })} />);
    // Announced once, by the line beside the pickers; the model chip keeps its own name.
    expect(screen.getAllByText("From initiative “Checkout”")).toHaveLength(1);
    expect(screen.getByText("From initiative “Checkout”")).toHaveClass("composer-new-chat-source");
    expect(screen.queryByRole("button", { name: /From initiative/u })).not.toBeInTheDocument();
    const chip = document.querySelector(".selected-model-chip");
    expect(chip?.getAttribute("aria-label")).not.toContain("From initiative");
  });
});
