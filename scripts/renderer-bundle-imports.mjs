import { parse } from "@babel/parser";

// Parse emitted modules so every static import form contributes to route cost.
// Dynamic imports remain deferred; comments and strings are not dependencies.
export function staticJavaScriptImports(source) {
  const imports = new Set();
  for (const statement of parse(source, { sourceType: "module" }).program.body) {
    if (statement.type !== "ImportDeclaration"
      && statement.type !== "ExportNamedDeclaration"
      && statement.type !== "ExportAllDeclaration") continue;
    const path = statement.source?.value;
    if (path?.startsWith("./") && path.endsWith(".js")) {
      imports.add(path.slice(2));
    }
  }
  return imports;
}
