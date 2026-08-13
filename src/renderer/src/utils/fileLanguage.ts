import { parseWorkspaceFileReference } from "./workspaceFileReference";

export type FileLanguageAccent =
  | "amber"
  | "blue"
  | "cyan"
  | "green"
  | "neutral"
  | "red"
  | "violet";

export interface FileLanguage {
  id: string;
  label: string;
  accent: FileLanguageAccent;
  highlightLanguage: string | null;
  recognized: boolean;
}

const TEXT_LANGUAGE: FileLanguage = {
  id: "text",
  label: "Text",
  accent: "neutral",
  highlightLanguage: null,
  recognized: false,
};

const LANGUAGES = {
  bash: language("shell", "Shell", "neutral", "bash"),
  build: language("build", "Build file", "neutral"),
  c: language("c", "C", "blue"),
  cFamily: language("c-family", "C/C++", "blue"),
  cpp: language("cpp", "C++", "blue"),
  csharp: language("csharp", "C#", "violet"),
  css: language("css", "CSS", "violet", "css"),
  data: language("data", "Data", "green"),
  diff: language("diff", "Diff", "red", "diff"),
  dockerfile: language("dockerfile", "Dockerfile", "cyan"),
  go: language("go", "Go", "cyan"),
  html: language("html", "HTML", "amber", "html"),
  java: language("java", "Java", "amber", "java"),
  javascript: language("javascript", "JavaScript", "amber", "javascript"),
  json: language("json", "JSON", "green", "json"),
  kotlin: language("kotlin", "Kotlin", "violet"),
  markdown: language("markdown", "Markdown", "neutral", "markdown"),
  php: language("php", "PHP", "violet"),
  python: language("python", "Python", "blue", "python"),
  ruby: language("ruby", "Ruby", "red"),
  rust: language("rust", "Rust", "amber", "rust"),
  sql: language("sql", "SQL", "violet", "sql"),
  swift: language("swift", "Swift", "amber"),
  typescript: language("typescript", "TypeScript", "blue", "typescript"),
  vue: language("vue", "Vue", "green"),
  xml: language("xml", "XML", "amber", "xml"),
  yaml: language("yaml", "YAML", "green", "yaml"),
} as const;

function language(
  id: string,
  label: string,
  accent: FileLanguageAccent,
  highlightLanguage: string | null = null,
): FileLanguage {
  return { id, label, accent, highlightLanguage, recognized: true };
}

const EXTENSIONS: Record<string, FileLanguage> = {
  bash: LANGUAGES.bash,
  c: LANGUAGES.c,
  cc: LANGUAGES.cpp,
  cjs: LANGUAGES.javascript,
  cpp: LANGUAGES.cpp,
  cs: LANGUAGES.csharp,
  css: LANGUAGES.css,
  cts: LANGUAGES.typescript,
  go: LANGUAGES.go,
  gradle: LANGUAGES.build,
  h: LANGUAGES.cFamily,
  hpp: LANGUAGES.cpp,
  htm: LANGUAGES.html,
  html: LANGUAGES.html,
  java: LANGUAGES.java,
  js: LANGUAGES.javascript,
  json: LANGUAGES.json,
  jsonc: LANGUAGES.json,
  jsx: LANGUAGES.javascript,
  kt: LANGUAGES.kotlin,
  kts: LANGUAGES.kotlin,
  markdown: LANGUAGES.markdown,
  md: LANGUAGES.markdown,
  mdx: LANGUAGES.markdown,
  mjs: LANGUAGES.javascript,
  mts: LANGUAGES.typescript,
  php: LANGUAGES.php,
  py: LANGUAGES.python,
  rb: LANGUAGES.ruby,
  rs: LANGUAGES.rust,
  scss: LANGUAGES.css,
  sh: LANGUAGES.bash,
  sql: LANGUAGES.sql,
  swift: LANGUAGES.swift,
  toml: LANGUAGES.data,
  ts: LANGUAGES.typescript,
  tsx: LANGUAGES.typescript,
  vue: LANGUAGES.vue,
  xhtml: LANGUAGES.html,
  xml: LANGUAGES.xml,
  yaml: LANGUAGES.yaml,
  yml: LANGUAGES.yaml,
  zsh: LANGUAGES.bash,
};

const FILENAMES: Record<string, FileLanguage> = {
  dockerfile: LANGUAGES.dockerfile,
  gemfile: LANGUAGES.ruby,
  makefile: LANGUAGES.build,
};

const ALIASES: Record<string, FileLanguage> = {
  ...EXTENSIONS,
  cxx: LANGUAGES.cpp,
  html: LANGUAGES.html,
  java: LANGUAGES.java,
  javascript: LANGUAGES.javascript,
  kotlin: LANGUAGES.kotlin,
  markdown: LANGUAGES.markdown,
  plaintext: TEXT_LANGUAGE,
  python: LANGUAGES.python,
  rust: LANGUAGES.rust,
  shell: LANGUAGES.bash,
  text: TEXT_LANGUAGE,
  typescript: LANGUAGES.typescript,
};

function basename(path: string): string {
  return path.replace(/\\/gu, "/").split("/").at(-1)?.toLowerCase() ?? "";
}

export function fileLanguageFromPath(path: string): FileLanguage {
  const name = basename(path);
  const named = FILENAMES[name];
  if (named) return named;
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return EXTENSIONS[extension] ?? TEXT_LANGUAGE;
}

export function fileLanguageFromReference(reference: string): FileLanguage {
  return fileLanguageFromPath(parseWorkspaceFileReference(reference).path);
}

export function fileLanguageFromAlias(alias: string): FileLanguage {
  return ALIASES[alias.trim().toLowerCase()] ?? TEXT_LANGUAGE;
}

export function codeLanguage(
  path: string | null,
  declaredLanguage: string,
): FileLanguage {
  if (path) {
    const fromPath = fileLanguageFromReference(path);
    if (fromPath.recognized) return fromPath;
  }
  return fileLanguageFromAlias(declaredLanguage);
}
