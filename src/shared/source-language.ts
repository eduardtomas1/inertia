export type SourceLanguageFamily =
  | "java"
  | "web"
  | "script"
  | "systems"
  | "data"
  | "markup"
  | "neutral";

export interface SourceLanguage {
  id: string;
  label: string;
  family: SourceLanguageFamily;
  highlightLanguage: string | null;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SourceLanguage>> = {
  java: language("java", "Java", "java", "java"),
  gradle: language("gradle", "Gradle", "java", null),
  kt: language("kotlin", "Kotlin", "java", null),
  kts: language("kotlin", "Kotlin", "java", null),
  scala: language("scala", "Scala", "java", null),
  ts: language("typescript", "TypeScript", "web", "typescript"),
  mts: language("typescript", "TypeScript", "web", "typescript"),
  cts: language("typescript", "TypeScript", "web", "typescript"),
  tsx: language("tsx", "TSX", "web", "typescript"),
  js: language("javascript", "JavaScript", "web", "javascript"),
  mjs: language("javascript", "JavaScript", "web", "javascript"),
  cjs: language("javascript", "JavaScript", "web", "javascript"),
  jsx: language("jsx", "JSX", "web", "javascript"),
  css: language("css", "CSS", "web", "css"),
  scss: language("scss", "SCSS", "web", null),
  sass: language("sass", "Sass", "web", null),
  less: language("less", "Less", "web", null),
  html: language("html", "HTML", "web", "xml"),
  htm: language("html", "HTML", "web", "xml"),
  vue: language("vue", "Vue", "web", "xml"),
  svelte: language("svelte", "Svelte", "web", "xml"),
  py: language("python", "Python", "script", "python"),
  pyw: language("python", "Python", "script", "python"),
  rb: language("ruby", "Ruby", "script", null),
  php: language("php", "PHP", "script", null),
  sh: language("shell", "Shell", "script", "bash"),
  bash: language("shell", "Shell", "script", "bash"),
  zsh: language("shell", "Shell", "script", "bash"),
  fish: language("shell", "Shell", "script", null),
  ps1: language("powershell", "PowerShell", "script", null),
  rs: language("rust", "Rust", "systems", "rust"),
  go: language("go", "Go", "systems", null),
  c: language("c", "C", "systems", null),
  h: language("c", "C", "systems", null),
  cc: language("cpp", "C++", "systems", null),
  cpp: language("cpp", "C++", "systems", null),
  cxx: language("cpp", "C++", "systems", null),
  hpp: language("cpp", "C++", "systems", null),
  cs: language("csharp", "C#", "systems", null),
  swift: language("swift", "Swift", "systems", null),
  json: language("json", "JSON", "data", "json"),
  jsonc: language("jsonc", "JSON with comments", "data", "json"),
  yaml: language("yaml", "YAML", "data", "yaml"),
  yml: language("yaml", "YAML", "data", "yaml"),
  toml: language("toml", "TOML", "data", null),
  sql: language("sql", "SQL", "data", "sql"),
  graphql: language("graphql", "GraphQL", "data", null),
  gql: language("graphql", "GraphQL", "data", null),
  xml: language("xml", "XML", "markup", "xml"),
  svg: language("svg", "SVG", "markup", "xml"),
  md: language("markdown", "Markdown", "markup", "markdown"),
  markdown: language("markdown", "Markdown", "markup", "markdown"),
  diff: language("diff", "Diff", "neutral", "diff"),
  patch: language("diff", "Diff", "neutral", "diff"),
};

const LANGUAGE_BY_NAME: Readonly<Record<string, SourceLanguage>> = {
  dockerfile: language("dockerfile", "Dockerfile", "systems", null),
  makefile: language("makefile", "Makefile", "systems", null),
  rakefile: language("ruby", "Ruby", "script", null),
  gemfile: language("ruby", "Ruby", "script", null),
};

const LANGUAGE_BY_ALIAS: Readonly<Record<string, SourceLanguage>> = {
  ...LANGUAGE_BY_EXTENSION,
  bash: LANGUAGE_BY_EXTENSION.sh!,
  shell: LANGUAGE_BY_EXTENSION.sh!,
  html: LANGUAGE_BY_EXTENSION.html!,
  javascript: LANGUAGE_BY_EXTENSION.js!,
  jsonc: LANGUAGE_BY_EXTENSION.jsonc!,
  markdown: LANGUAGE_BY_EXTENSION.md!,
  md: LANGUAGE_BY_EXTENSION.md!,
  python: LANGUAGE_BY_EXTENSION.py!,
  py: LANGUAGE_BY_EXTENSION.py!,
  rust: LANGUAGE_BY_EXTENSION.rs!,
  rs: LANGUAGE_BY_EXTENSION.rs!,
  js: LANGUAGE_BY_EXTENSION.js!,
  jsx: LANGUAGE_BY_EXTENSION.jsx!,
  typescript: LANGUAGE_BY_EXTENSION.ts!,
  ts: LANGUAGE_BY_EXTENSION.ts!,
  tsx: LANGUAGE_BY_EXTENSION.tsx!,
  xml: LANGUAGE_BY_EXTENSION.xml!,
  yaml: LANGUAGE_BY_EXTENSION.yaml!,
  yml: LANGUAGE_BY_EXTENSION.yml!,
};

const GENERIC_FILE = language("file", "File", "neutral", null);
const GENERIC_TEXT = language("text", "Text", "neutral", null);

function language(
  id: string,
  label: string,
  family: SourceLanguageFamily,
  highlightLanguage: string | null,
): SourceLanguage {
  return { id, label, family, highlightLanguage };
}

function normalizedFileName(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLocaleLowerCase(
    "en-US",
  );
}

function languageFromShebang(content: string): SourceLanguage | null {
  const firstLine = content.slice(0, 256).split(/\r?\n/u, 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return null;
  if (/\b(?:python|python3)(?:\s|$)/iu.test(firstLine)) {
    return LANGUAGE_BY_EXTENSION.py!;
  }
  if (/\b(?:node|deno|bun)(?:\s|$)/iu.test(firstLine)) {
    return LANGUAGE_BY_EXTENSION.js!;
  }
  if (/\b(?:bash|sh|zsh)(?:\s|$)/iu.test(firstLine)) {
    return LANGUAGE_BY_EXTENSION.sh!;
  }
  return null;
}

export function sourceLanguageFromAlias(
  alias: string | null | undefined,
): SourceLanguage | null {
  const normalized = alias?.trim().toLocaleLowerCase("en-US") ?? "";
  return normalized ? LANGUAGE_BY_ALIAS[normalized] ?? null : null;
}

export function sourceLanguageForFile(
  path: string,
  content?: string,
): SourceLanguage {
  const name = normalizedFileName(path);
  const named = LANGUAGE_BY_NAME[name];
  if (named) return named;
  const extensionIndex = name.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? name.slice(extensionIndex + 1) : "";
  const byExtension = extension ? LANGUAGE_BY_EXTENSION[extension] : null;
  if (byExtension) return byExtension;
  if (content !== undefined) {
    return languageFromShebang(content) ?? GENERIC_TEXT;
  }
  return GENERIC_FILE;
}
