import { describe, expect, it } from "vitest";
import { staticJavaScriptImports } from "../../scripts/renderer-bundle-imports.mjs";

describe("renderer bundle static dependencies", () => {
  it("counts default, namespace, named, side-effect and re-export dependencies", () => {
    expect([...staticJavaScriptImports(`
      import value from './default.js';
      import * as namespace from './namespace.js';
      import { named } from './named.js';
      import './side-effect.js';
      export { other } from './export.js';
      export * from './export-all.js';
      export * as exportedNamespace from './export-namespace.js';
      import { duplicate } from './named.js';
    `)]).toEqual([
      "default.js", "namespace.js", "named.js", "side-effect.js",
      "export.js", "export-all.js", "export-namespace.js",
    ]);
  });

  it("excludes deferred imports, external packages, comments and strings", () => {
    expect([...staticJavaScriptImports(`
      import(' ./not-real.js');
      import('./deferred.js');
      import external from 'external';
      // import './comment.js';
      const text = "import './string.js'";
      export const value = 1;
    `)]).toEqual([]);
  });

  it("fails closed on malformed emitted JavaScript", () => {
    expect(() => staticJavaScriptImports("import {")).toThrow();
  });
});
