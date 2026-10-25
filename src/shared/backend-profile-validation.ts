import type { z } from "zod";

import { modelBackendProfileDraftSchema } from "./backend-profile-settings";

export { normalizeBackendBaseUrl } from "./backend-presets";

export type BackendProfileIssueField =
  | "name"
  | "baseUrl"
  | "models"
  | `models.${number}.id`
  | `models.${number}.displayName`
  | "contextWindow"
  | "authenticationMode"
  | "protocol";

export interface BackendProfileIssue {
  field: BackendProfileIssueField;
  message: string;
}

type DraftIssue = z.core.$ZodIssue;

const UNREADABLE_MESSAGE = "The backend settings could not be read.";

function authored(issue: DraftIssue): boolean {
  return issue.code === "custom";
}

function sizeMessage(
  issue: DraftIssue,
  missing: string,
  tooLong: string,
): string {
  if (authored(issue)) return issue.message;
  if (issue.code === "too_big") return tooLong;
  if (issue.code === "too_small" || issue.code === "invalid_type") return missing;
  return issue.message;
}

function modelIssue(issue: DraftIssue, rest: readonly PropertyKey[]): BackendProfileIssue {
  const [index, key] = rest;
  if (typeof index !== "number") {
    return {
      field: "models",
      message: sizeMessage(issue, "Add at least one model.", "A backend can list at most 128 models."),
    };
  }
  if (key === "id" && rest.length === 2) {
    return {
      field: `models.${index}.id`,
      message: sizeMessage(issue, "Enter a model ID.", "Model IDs can be at most 500 characters."),
    };
  }
  if (key === "displayName" && rest.length === 2) {
    return {
      field: `models.${index}.displayName`,
      message: sizeMessage(
        issue,
        "Enter a display name for this model.",
        "Model names can be at most 200 characters.",
      ),
    };
  }
  if (key === "contextWindowTokens" && rest.length === 2) {
    if (issue.code === "too_small") {
      return { field: "contextWindow", message: "Context windows must be at least 8,192 tokens." };
    }
    if (issue.code === "too_big") {
      return { field: "contextWindow", message: "Context windows can be at most 100,000,000 tokens." };
    }
    return {
      field: "contextWindow",
      message: "Enter the context window as a whole number of tokens.",
    };
  }
  if (key === undefined) {
    return {
      field: "models",
      message: issue.code === "unrecognized_keys"
        ? `Model ${index + 1} contains an unsupported field.`
        : `Model ${index + 1} could not be read.`,
    };
  }
  return {
    field: "models",
    message: authored(issue)
      ? issue.message
      : `Check the reasoning options and capabilities for model ${index + 1}.`,
  };
}

function draftIssue(issue: DraftIssue, draft: unknown): BackendProfileIssue {
  const [head, ...rest] = issue.path;
  switch (head) {
    case "displayName":
      return {
        field: "name",
        message: sizeMessage(issue, "Enter a name for this backend.", "Names can be at most 200 characters."),
      };
    case "baseUrl":
      return {
        field: "baseUrl",
        message: sizeMessage(issue, "Enter the backend URL.", "Backend URLs can be at most 2,048 characters."),
      };
    case "allowInsecureLocalhost":
    case "allowPrivateNetwork":
      return {
        field: "baseUrl",
        message: authored(issue)
          ? issue.message
          : "Choose whether this backend may use a local or private-network address.",
      };
    case "models":
      return modelIssue(issue, rest);
    case "routing":
      return {
        field: "models",
        message: authored(issue) ? issue.message : "Choose which model this backend uses by default.",
      };
    case "capabilityHints":
      return {
        field: "models",
        message: authored(issue) ? issue.message : "The capability hints could not be read.",
      };
    case "authenticationMode":
      return {
        field: "authenticationMode",
        message: authored(issue) ? issue.message : "Choose a supported authentication method.",
      };
    case "protocol":
      return {
        field: "protocol",
        message: authored(issue) ? issue.message : "Choose a supported protocol.",
      };
    case "harnessId":
      return {
        field: "protocol",
        message: authored(issue) ? issue.message : "Choose a supported harness.",
      };
    case "promptCacheTtl":
      return {
        field: "protocol",
        message: authored(issue) ? issue.message : "Choose a supported prompt cache length.",
      };
    case "preset":
      return {
        field: "protocol",
        message: authored(issue) ? issue.message : "Choose Anthropic API key, OpenAI API key or Custom.",
      };
    case undefined:
      if (issue.code === "unrecognized_keys") {
        return { field: "name", message: "The backend settings contain an unsupported field." };
      }
      if (
        issue.code === "invalid_union"
        && typeof draft === "object"
        && draft !== null
        && !Array.isArray(draft)
      ) {
        return { field: "protocol", message: "Choose Anthropic API key, OpenAI API key or Custom." };
      }
      return { field: "name", message: authored(issue) ? issue.message : UNREADABLE_MESSAGE };
    default:
      return { field: "name", message: authored(issue) ? issue.message : UNREADABLE_MESSAGE };
  }
}

export function validateBackendProfileDraft(draft: unknown): BackendProfileIssue[] {
  const result = modelBackendProfileDraftSchema.safeParse(draft);
  if (result.success) return [];
  const seen = new Set<string>();
  const issues: BackendProfileIssue[] = [];
  for (const issue of result.error.issues) {
    const mapped = draftIssue(issue, draft);
    const key = `${mapped.field}\u0000${mapped.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(mapped);
  }
  return issues;
}
