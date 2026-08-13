import { describe, expect, it } from "vitest";

import {
  codeLanguage,
  fileLanguageFromAlias,
  fileLanguageFromPath,
  fileLanguageFromReference,
} from "../../src/renderer/src/utils/fileLanguage";

describe("local file-language recognition", () => {
  it("gives Java first-class recognition from project-relative paths", () => {
    expect(fileLanguageFromPath("src/main/java/example/Main.JAVA"))
      .toMatchObject({
        id: "java",
        label: "Java",
        accent: "amber",
        highlightLanguage: "java",
        recognized: true,
      });
    expect(fileLanguageFromReference("src/main/java/example/Main.java:42:7").id)
      .toBe("java");
    expect(fileLanguageFromReference("src/main/java/example/Main.java#L42-L44").id)
      .toBe("java");
  });

  it("recognizes representative common paths and special filenames", () => {
    expect(fileLanguageFromPath("src/view.tsx").id).toBe("typescript");
    expect(fileLanguageFromPath("tools/release.py").id).toBe("python");
    expect(fileLanguageFromPath("Cargo.toml").id).toBe("data");
    expect(fileLanguageFromPath("ops/Dockerfile").id).toBe("dockerfile");
    expect(fileLanguageFromPath("src\\server\\query.sql").id).toBe("sql");
    expect(fileLanguageFromPath("src/Service?backup.java").id).toBe("java");
    expect(fileLanguageFromPath("src/Service.java?backup.txt").recognized)
      .toBe(false);
    expect(fileLanguageFromPath("src/Service#L12.java").id).toBe("java");
  });

  it("keeps unknown extensions neutral and lets file paths outrank fence labels", () => {
    expect(fileLanguageFromPath("generated/widget.future")).toEqual({
      id: "text",
      label: "Text",
      accent: "neutral",
      highlightLanguage: null,
      recognized: false,
    });
    expect(codeLanguage("src/Main.java", "typescript").id).toBe("java");
    expect(codeLanguage("src/Main.kt", "typescript")).toMatchObject({
      id: "kotlin",
      highlightLanguage: null,
    });
    expect(codeLanguage("generated/widget.future", "typescript").id)
      .toBe("typescript");
    expect(fileLanguageFromAlias("futurelang").recognized).toBe(false);
  });
});
