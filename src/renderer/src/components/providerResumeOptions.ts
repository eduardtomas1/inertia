import type { ProviderTerminalResumeAvailability } from "@shared/contracts";

/**
 * One resumable provider chat offered by the terminal or the composer. This
 * lives apart from both surfaces so the picker and the panel can share it
 * without importing each other.
 */
export interface ProviderTerminalResumeOption {
  projectId: string;
  projectName: string;
  conversationId: string;
  conversationTitle: string;
  availability: ProviderTerminalResumeAvailability;
}
