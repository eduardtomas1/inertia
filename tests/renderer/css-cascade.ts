interface StyleRule { selectors: string[]; body: string; order: number }

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

// Top-level style rules only; at-rule blocks (media, container, keyframes) are skipped.
function topLevelStyleRules(source: string): StyleRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: StyleRule[] = [];
  let depth = 0;
  let start = 0;
  let prelude = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      if (depth === 0) {
        prelude = text.slice(start, index).trim();
        start = index + 1;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        if (!prelude.startsWith("@")) {
          rules.push({
            selectors: splitTopLevel(prelude),
            body: text.slice(start, index),
            order: rules.length,
          });
        }
        start = index + 1;
      }
    } else if (character === ";" && depth === 0) {
      start = index + 1;
    }
  }
  return rules;
}

function withoutWhere(selector: string): string {
  let output = "";
  let index = 0;
  while (index < selector.length) {
    if (!selector.startsWith(":where(", index)) {
      output += selector[index];
      index += 1;
      continue;
    }
    let depth = 0;
    for (index += ":where".length; index < selector.length; index += 1) {
      if (selector[index] === "(") depth += 1;
      else if (selector[index] === ")" && (depth -= 1) === 0) {
        index += 1;
        break;
      }
    }
  }
  return output;
}

// :is(), :not() and :has() count as their most specific argument.
function specificity(selector: string): number {
  let counted = withoutWhere(selector);
  let nested = 0;
  for (let start = counted.search(/:(?:not|is|has)\(/u); start >= 0; start = counted.search(/:(?:not|is|has)\(/u)) {
    const open = counted.indexOf("(", start);
    let depth = 0;
    let close = open;
    for (; close < counted.length; close += 1) {
      if (counted[close] === "(") depth += 1;
      else if (counted[close] === ")" && (depth -= 1) === 0) break;
    }
    nested += Math.max(0, ...splitTopLevel(counted.slice(open + 1, close)).map(specificity));
    counted = `${counted.slice(0, start)} ${counted.slice(close + 1)}`;
  }
  const ids = counted.match(/#[\w-]+/gu)?.length ?? 0;
  const classes = counted.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/gu)?.length ?? 0;
  const types = counted
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+/gu, " ")
    .match(/[a-z][\w-]*/giu)?.length ?? 0;
  return ids * 10_000 + classes * 100 + types + nested;
}

function declaredValue(body: string, names: readonly string[]): string | undefined {
  let value: string | undefined;
  for (const declaration of body.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    if (names.includes(declaration.slice(0, separator).trim())) {
      value = declaration.slice(separator + 1).trim();
    }
  }
  return value;
}

export type CascadedValue = (
  element: { matches(selector: string): boolean },
  names: readonly string[],
  hover: boolean,
) => string | undefined;

// Resolves which declaration wins for an element: importance, then
// specificity, then source order. Hover is simulated by dropping `:hover`.
export function createCascade(source: string): CascadedValue {
  const styleRules = topLevelStyleRules(source);
  return (element, names, hover) => {
    let winner: { value: string; rank: readonly [number, number, number] } | undefined;
    for (const rule of styleRules) {
      const declared = declaredValue(rule.body, names);
      if (!declared) continue;
      const important = declared.endsWith("!important");
      const value = declared.replace(/\s*!important$/u, "");
      for (const selector of rule.selectors) {
        if (selector.includes("::")) continue;
        if (/:(?:active|focus|focus-visible|focus-within)\b/u.test(selector)) continue;
        if (!hover && selector.includes(":hover")) continue;
        let matches = false;
        try {
          matches = element.matches(selector.replaceAll(":hover", ""));
        } catch {
          matches = false;
        }
        if (!matches) continue;
        const rank = [important ? 1 : 0, specificity(selector), rule.order] as const;
        const wins = !winner
          || rank[0] > winner.rank[0]
          || (rank[0] === winner.rank[0] && rank[1] > winner.rank[1])
          || (rank[0] === winner.rank[0] && rank[1] === winner.rank[1] && rank[2] >= winner.rank[2]);
        if (wins) winner = { value, rank };
      }
    }
    return winner?.value;
  };
}
