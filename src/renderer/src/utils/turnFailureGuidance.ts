import { INTERFACE_LOCALE } from "../lib/locale";

export type TurnFailureKind = "billing" | "authentication" | "rate-limited" | "model-not-found";

const FAILURE_KINDS: ReadonlySet<string> = new Set([
  "billing",
  "authentication",
  "rate-limited",
  "model-not-found",
]);

export interface TurnFailure {
  kind: TurnFailureKind;
  resetsAt: string | null;
}

export interface TurnFailureRoute {
  routeKind: "account" | "api-key";
  protocol: string;
  backendProfileId: string;
  displayName: string;
  preset?: string;
  endpointHost?: string | null;
}

function officialBilling(route: TurnFailureRoute): "anthropic" | "openai" | null {
  if (route.preset === "anthropic-api-key" || route.endpointHost === "api.anthropic.com") return "anthropic";
  if (route.preset === "openai-api-key" || route.endpointHost === "api.openai.com") return "openai";
  return null;
}

export type TurnFailureAction =
  | { kind: "replace-key"; label: "Replace key" }
  | { kind: "edit-models"; label: "Edit models" };

export interface TurnFailureGuidance {
  title: string;
  detail: string;
  action: TurnFailureAction | null;
}

function stringField(value: object, key: string): string | null {
  const field = (value as Readonly<Record<string, unknown>>)[key];
  return typeof field === "string" && field.trim() ? field : null;
}

export function turnFailure(turn: object | null | undefined): TurnFailure | null {
  if (!turn) return null;
  const kind = stringField(turn, "failureKind");
  if (!kind || !FAILURE_KINDS.has(kind)) return null;
  const resetsAt = stringField(turn, "failureResetsAt") ?? stringField(turn, "resetsAt");
  return {
    kind: kind as TurnFailureKind,
    resetsAt: resetsAt && Number.isFinite(Date.parse(resetsAt)) ? resetsAt : null,
  };
}

function resetLabel(resetsAt: string, now: number): string {
  const at = new Date(resetsAt);
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const time = at.toLocaleTimeString(INTERFACE_LOCALE, { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? `at ${time}`
    : `on ${at.toLocaleDateString(INTERFACE_LOCALE, { weekday: "long" })} at ${time}`;
}

export function turnFailureGuidance(
  failure: TurnFailure | null,
  route: TurnFailureRoute | null,
  now = Date.now(),
): TurnFailureGuidance | null {
  if (!failure || !route || route.routeKind !== "api-key") return null;
  if (failure.kind === "billing") {
    const official = officialBilling(route);
    return {
      title: `${route.displayName} is out of credits`,
      detail: official === "anthropic"
        ? "Add credits in the Anthropic Console, then send again."
        : official === "openai"
          ? "Add credits at platform.openai.com, then send again."
          : "Check your credits with this backend's provider, then send again.",
      action: null,
    };
  }
  if (failure.kind === "authentication") {
    return {
      title: `${route.displayName} was rejected`,
      detail: "The API key is no longer accepted. Replace it to keep using this route.",
      action: { kind: "replace-key", label: "Replace key" },
    };
  }
  if (failure.kind === "rate-limited") {
    return {
      title: `${route.displayName} is rate limited`,
      detail: failure.resetsAt
        ? `The provider limits how often this key can be used. Try again ${resetLabel(failure.resetsAt, now)}.`
        : "The provider limits how often this key can be used. Try again in a moment.",
      action: null,
    };
  }
  return {
    title: `${route.displayName} does not offer this model`,
    detail: "The model may have been renamed or retired. Edit the models for this route.",
    action: { kind: "edit-models", label: "Edit models" },
  };
}
