import { readFileSync } from "node:fs";

export interface CssRule {
  context: string;
  selectors: string[];
  declarations: Map<string, string>;
}

export function readRendererCss(...paths: string[]): string {
  return paths
    .map((path) => readFileSync(new URL(`../../src/renderer/src/${path}`, import.meta.url), "utf8"))
    .join("\n")
    .replace(/\r\n?/gu, "\n");
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/gu, " ").trim();
}

function splitSelectors(head: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < head.length; index += 1) {
    const character = head[index];
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      selectors.push(normalizeSelector(head.slice(start, index)));
      start = index + 1;
    }
  }
  selectors.push(normalizeSelector(head.slice(start)));
  return selectors;
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim();
    if (!property) continue;
    declarations.set(property, part.slice(colon + 1).replace(/\s+/gu, " ").trim());
  }
  return declarations;
}

export function parseCssRules(source: string): CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: CssRule[] = [];
  const walk = (text: string, context: string): void => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf("{", index);
      if (open < 0) return;
      const prelude = text.slice(index, open).trim();
      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth > 0) {
        if (text[close] === "{") depth += 1;
        if (text[close] === "}") depth -= 1;
        close += 1;
      }
      const body = text.slice(open + 1, close - 1);
      const statementEnd = prelude.lastIndexOf(";");
      const head = statementEnd >= 0 ? prelude.slice(statementEnd + 1).trim() : prelude;
      if (head.startsWith("@")) {
        if (!head.startsWith("@keyframes")) walk(body, normalizeSelector(head));
      } else {
        rules.push({
          context,
          selectors: splitSelectors(head),
          declarations: parseDeclarations(body),
        });
      }
      index = close;
    }
  };
  walk(css, "");
  return rules;
}

export function declarationsFor(
  rules: readonly CssRule[],
  selector: string,
  context = "",
): Map<string, string> {
  const wanted = normalizeSelector(selector);
  const merged = new Map<string, string>();
  for (const rule of rules) {
    if (rule.context !== context || !rule.selectors.includes(wanted)) continue;
    for (const [property, value] of rule.declarations) merged.set(property, value);
  }
  return merged;
}
