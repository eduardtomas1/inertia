const MAX_OWNED_PROMPTS = 64;
const MAX_OWNED_ASSISTANTS = 2_048;

interface OwnedPrompt {
  kind: "initial" | "follow-up";
  accepted: boolean;
  workObserved: boolean;
  admission: Promise<boolean>;
  settleAdmission: (accepted: boolean) => void;
  admissionSettled: boolean;
}

function ownedPrompt(kind: OwnedPrompt["kind"]): OwnedPrompt {
  let settleAdmission!: (accepted: boolean) => void;
  const admission = new Promise<boolean>((resolve) => {
    settleAdmission = resolve;
  });
  return {
    kind,
    accepted: false,
    workObserved: false,
    admission,
    settleAdmission,
    admissionSettled: false,
  };
}

/**
 * Correlates one owned OpenCode run with the exact prompts and assistant
 * messages admitted for it. Session-scoped SSE can contain historical or
 * independently queued work, so a matching session ID alone is not authority
 * to project assistant output or failures.
 */
export class OpenCodeRunOwnership {
  private readonly prompts = new Map<string, OwnedPrompt>();
  private readonly assistantPrompts = new Map<string, string>();
  private activePromptId: string | null = null;
  private acceptedEventSequence = 0;

  constructor(initialPromptId: string) {
    this.prompts.set(initialPromptId, ownedPrompt("initial"));
  }

  reserveFollowUp(promptId: string): boolean {
    if (this.prompts.has(promptId)) return true;
    if (this.prompts.size >= MAX_OWNED_PROMPTS) return false;
    this.prompts.set(promptId, ownedPrompt("follow-up"));
    return true;
  }

  rejectFollowUp(promptId: string): void {
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.accepted || prompt.workObserved) return;
    this.settleAdmission(prompt, false);
    this.prompts.delete(promptId);
    if (this.activePromptId === promptId) this.activePromptId = null;
  }

  acceptPrompt(promptId: string): boolean {
    const prompt = this.prompts.get(promptId);
    if (!prompt) return false;
    prompt.accepted = true;
    this.settleAdmission(prompt, true);
    this.activePromptId = promptId;
    this.acceptedEventSequence += 1;
    return true;
  }

  rejectPromptAdmission(promptId: string): void {
    const prompt = this.prompts.get(promptId);
    if (prompt) this.settleAdmission(prompt, false);
  }

  pendingPromptAdmission(): Promise<boolean> | null {
    let pending: OwnedPrompt | undefined;
    for (const prompt of this.prompts.values()) {
      if (!prompt.admissionSettled) pending = prompt;
    }
    return pending?.admission ?? null;
  }

  rejectPendingAdmissions(): void {
    for (const prompt of this.prompts.values()) {
      this.settleAdmission(prompt, false);
    }
  }

  eventSequence(): number {
    return this.acceptedEventSequence;
  }

  ownsPrompt(promptId: string | undefined): boolean {
    return Boolean(promptId && this.prompts.has(promptId));
  }

  ownsAssistant(assistantId: string | undefined): boolean {
    return Boolean(assistantId && this.assistantPrompts.has(assistantId));
  }

  ownsPromptOrAssistant(identity: string | undefined): boolean {
    return this.ownsPrompt(identity) || this.ownsAssistant(identity);
  }

  claimAssistant(
    assistantId: string,
    parentPromptId?: string,
    allowActivePrompt = false,
  ): boolean {
    const existingPromptId = this.assistantPrompts.get(assistantId);
    if (existingPromptId) {
      this.markPromptWork(existingPromptId);
      return true;
    }
    const promptId = parentPromptId && this.prompts.has(parentPromptId)
      ? parentPromptId
      : allowActivePrompt
        ? this.activePromptId
        : null;
    if (!promptId || !this.prompts.has(promptId)) return false;
    if (this.assistantPrompts.size >= MAX_OWNED_ASSISTANTS) {
      throw new Error("OpenCode exceeded the bounded owned-assistant budget.");
    }
    this.assistantPrompts.set(assistantId, promptId);
    this.markPromptWork(promptId);
    return true;
  }

  markAssistantWork(assistantId: string | undefined): boolean {
    if (!assistantId) return false;
    const promptId = this.assistantPrompts.get(assistantId);
    if (!promptId) return false;
    this.markPromptWork(promptId);
    return true;
  }

  markActivePromptWork(): boolean {
    if (!this.activePromptId) return false;
    return this.markPromptWork(this.activePromptId);
  }

  acceptedFollowUpsAwaitingWork(): boolean {
    for (const prompt of this.prompts.values()) {
      if (
        prompt.kind === "follow-up"
        && prompt.accepted
        && !prompt.workObserved
      ) return true;
    }
    return false;
  }

  workedPromptIds(): string[] {
    return [...this.prompts.entries()].flatMap(([promptId, prompt]) =>
      prompt.workObserved ? [promptId] : []);
  }

  assistantIds(promptId: string): string[] {
    return [...this.assistantPrompts.entries()].flatMap(
      ([assistantId, ownerPromptId]) =>
        ownerPromptId === promptId ? [assistantId] : [],
    );
  }

  settlePrompt(promptId: string): void {
    this.prompts.delete(promptId);
    for (const [assistantId, ownerPromptId] of this.assistantPrompts) {
      if (ownerPromptId === promptId) this.assistantPrompts.delete(assistantId);
    }
    if (this.activePromptId === promptId) this.activePromptId = null;
  }

  private markPromptWork(promptId: string): boolean {
    const prompt = this.prompts.get(promptId);
    if (!prompt) return false;
    prompt.accepted = true;
    prompt.workObserved = true;
    this.settleAdmission(prompt, true);
    this.activePromptId = promptId;
    this.acceptedEventSequence += 1;
    return true;
  }

  private settleAdmission(prompt: OwnedPrompt, accepted: boolean): void {
    if (prompt.admissionSettled) return;
    prompt.admissionSettled = true;
    prompt.settleAdmission(accepted);
  }
}
