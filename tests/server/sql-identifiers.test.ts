import { describe, expect, it } from "vitest";

import { quotedSqlIdentifier } from "../../src/server/persistence/migrations/sql-identifiers";

describe("migration SQL identifiers", () => {
  it("quotes only identifiers present in the explicit call-site allowlist", () => {
    expect(
      quotedSqlIdentifier("agent_turns", [
        "messages",
        "agent_turns",
      ]),
    ).toBe('"agent_turns"');
    expect(() =>
      quotedSqlIdentifier("agent_turns; DROP TABLE projects", [
        "agent_turns",
      ])
    ).toThrow(/allowlisted/u);
    expect(() =>
      quotedSqlIdentifier("projects", ["agent_turns"])
    ).toThrow(/allowlisted/u);
  });
});
