import { describe, expect, it } from "vitest";

import {
  sourceLanguageForFile,
  sourceLanguageFromAlias,
} from "../../src/shared/source-language";

describe("source language recognition", () => {
  it("gives Java first-class identity without case-sensitive extensions", () => {
    expect(sourceLanguageForFile("src/main/OrderService.java")).toEqual({
      id: "java",
      label: "Java",
      family: "java",
      highlightLanguage: "java",
    });
    expect(sourceLanguageForFile("src/main/OrderService.JAVA").id)
      .toBe("java");
    expect(sourceLanguageFromAlias("JAVA")?.label).toBe("Java");
  });

  it("recognizes representative web, script, systems, data, and markup files", () => {
    expect(sourceLanguageForFile("src/App.tsx"))
      .toMatchObject({ id: "tsx", family: "web" });
    expect(sourceLanguageForFile("tools/release.py"))
      .toMatchObject({ id: "python", family: "script" });
    expect(sourceLanguageForFile("src/lib.rs"))
      .toMatchObject({ id: "rust", family: "systems" });
    expect(sourceLanguageForFile("config/app.yaml"))
      .toMatchObject({ id: "yaml", family: "data" });
    expect(sourceLanguageForFile("docs/README.md"))
      .toMatchObject({ id: "markdown", family: "markup" });
  });

  it("uses bounded shebang evidence and keeps unknown files neutral", () => {
    expect(sourceLanguageForFile("tools/release", "#!/usr/bin/env python3\n"))
      .toMatchObject({ id: "python", family: "script" });
    expect(sourceLanguageForFile("notes.unknown", "ordinary text"))
      .toMatchObject({ id: "text", family: "neutral" });
    expect(sourceLanguageForFile("notes.unknown"))
      .toMatchObject({ id: "file", family: "neutral" });
    expect(sourceLanguageFromAlias("imaginary-provider-language")).toBeNull();
  });
});
