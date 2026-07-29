const MAX_MODEL_SEARCH_QUERY_LENGTH = 300;

export interface ModelSearchRoute {
  /** Stable route key; callers should include harness, backend profile, and model identity. */
  key: string;
  displayName: string;
  modelId: string;
  alias: string | null;
  harnessId: string;
  harnessLabel: string;
  backendProfileId: string;
  backendProfileName: string;
  /** Revision is present for authoritative composer routes. */
  backendConfigurationRevision?: number;
  providerLabel: string;
  source: "built-in" | "custom";
  /**
   * Truthful route-specific terms that are not already present in the visible
   * identity, such as "Kimi" or "OpenAI". Do not infer these from display text.
   */
  routeTerms: readonly string[];
  reasoningEffort?: string | null;
  reasoningOptions?: readonly string[];
  selectable: boolean;
  unavailableReason: string | null;
}

export type ModelSearchEmptyState =
  | { kind: "no-models"; message: "No models are available yet." }
  | { kind: "no-results"; message: string };

export interface ModelSearchResult<Route extends ModelSearchRoute> {
  query: string;
  normalizedQuery: string;
  items: Route[];
  emptyState: ModelSearchEmptyState | null;
}

const combiningMarks = /\p{M}+/gu;
const searchTokens = /[\p{L}\p{N}]+/gu;

export function normalizeModelSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(combiningMarks, "")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/gu, " ");
}

function tokenize(value: string): string[] {
  return normalizeModelSearchText(value).match(searchTokens) ?? [];
}

function searchableFields(route: ModelSearchRoute): string[] {
  return [
    route.displayName,
    route.alias ?? "",
    route.modelId,
    route.backendProfileName,
    route.providerLabel,
    route.harnessLabel,
    route.harnessId,
    route.backendProfileId,
    ...route.routeTerms,
    route.source === "custom" ? "custom" : "",
  ].filter(Boolean);
}

function modelRouteSearchScore(
  route: ModelSearchRoute,
  normalizedQuery: string,
  queryTokens: readonly string[],
): number | null {
  const fields = searchableFields(route).map(normalizeModelSearchText);
  let phraseScore = Number.POSITIVE_INFINITY;

  fields.forEach((field, index) => {
    if (field === normalizedQuery) phraseScore = Math.min(phraseScore, index);
    else if (field.startsWith(normalizedQuery)) {
      phraseScore = Math.min(phraseScore, 20 + index);
    } else if (field.includes(normalizedQuery)) {
      phraseScore = Math.min(phraseScore, 40 + index);
    }
  });

  const fieldTokens = fields.map((field) => field.match(searchTokens) ?? []);
  let tokenScore = 0;
  for (const queryToken of queryTokens) {
    let bestTokenScore = Number.POSITIVE_INFINITY;
    fieldTokens.forEach((tokens, fieldIndex) => {
      tokens.forEach((token) => {
        if (token === queryToken) {
          bestTokenScore = Math.min(bestTokenScore, fieldIndex);
        } else if (token.startsWith(queryToken)) {
          bestTokenScore = Math.min(bestTokenScore, 20 + fieldIndex);
        } else if (token.includes(queryToken)) {
          bestTokenScore = Math.min(bestTokenScore, 40 + fieldIndex);
        }
      });
    });
    if (!Number.isFinite(bestTokenScore)) return null;
    tokenScore += bestTokenScore;
  }

  return Math.min(phraseScore, 100 + tokenScore);
}

/**
 * Filters and ranks model routes without changing any route identity or
 * availability state. Exact and prefix matches rank first; ties retain their
 * original provider order.
 */
export function searchModelRoutes<Route extends ModelSearchRoute>(
  routes: readonly Route[],
  rawQuery: string,
): ModelSearchResult<Route> {
  const query = rawQuery.trim().slice(0, MAX_MODEL_SEARCH_QUERY_LENGTH);
  const normalizedQuery = normalizeModelSearchText(query);
  const queryTokens = tokenize(query);

  if (!normalizedQuery || queryTokens.length === 0) {
    const items = [...routes];
    return {
      query,
      normalizedQuery,
      items,
      emptyState: items.length === 0
        ? { kind: "no-models", message: "No models are available yet." }
        : null,
    };
  }

  const items = routes
    .map((route, index) => ({
      route,
      index,
      score: modelRouteSearchScore(route, normalizedQuery, queryTokens),
    }))
    .filter((candidate): candidate is typeof candidate & { score: number } =>
      candidate.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ route }) => route);

  return {
    query,
    normalizedQuery,
    items,
    emptyState: items.length === 0
      ? {
          kind: "no-results",
          message: `No models match “${query}”.`,
        }
      : null,
  };
}
