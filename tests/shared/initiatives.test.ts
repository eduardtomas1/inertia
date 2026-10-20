import { describe, expect, it } from "vitest";

import { PROJECT_COLOR_NAMES } from "../../src/shared/project-colors";
import {
  compareInitiatives,
  defaultInitiativeColor,
  INITIATIVE_COLORS,
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_LABELS,
  initiativeAcceptsChats,
  initiativeMembers,
  initiativeNameInputSchema,
  initiativeNameSchema,
  initiativePatchSchema,
  initiativeSchema,
  isInitiativeColor,
  isInitiativeName,
  MAX_INITIATIVE_BRIEF_BYTES,
  MAX_INITIATIVE_NAME_CHARS,
  MAX_INITIATIVES,
  type Initiative,
} from "../../src/shared/initiatives";

const ID = "11111111-1111-4111-8111-111111111111";

function initiative(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: ID,
    name: "Checkout redesign",
    color: "teal",
    status: "active",
    brief: "",
    briefRevision: 0,
    revision: 1,
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    ...overrides,
  };
}

describe("initiative contracts", () => {
  it("pins the product limits, statuses and palette", () => {
    expect(MAX_INITIATIVES).toBe(100);
    expect(MAX_INITIATIVE_NAME_CHARS).toBe(120);
    expect(MAX_INITIATIVE_BRIEF_BYTES).toBe(8_192);
    expect(INITIATIVE_STATUSES).toEqual(["active", "done", "archived"]);
    expect(INITIATIVE_STATUSES.map((status) => INITIATIVE_STATUS_LABELS[status]))
      .toEqual(["Active", "Done", "Archived"]);
    expect(INITIATIVE_COLORS).toEqual(PROJECT_COLOR_NAMES);
  });

  it("trims typed names and rejects empty, multi-line, tabbed, NUL and overlong names", () => {
    expect(initiativeNameInputSchema.parse("  Release 1.0  ")).toBe("Release 1.0");
    expect(initiativeNameInputSchema.parse("\tRelease\u00a0")).toBe("Release");
    expect(initiativeNameInputSchema.parse("x".repeat(120))).toHaveLength(120);
    for (const invalid of ["", "   ", "x".repeat(121), "Two\nlines", "Carriage\rreturn", "nul\0", "Tab\tinside"]) {
      expect(initiativeNameInputSchema.safeParse(invalid).success).toBe(false);
    }
    expect(isInitiativeName("Release")).toBe(true);
    expect(isInitiativeName(" Release ")).toBe(false);
    expect(isInitiativeName(42)).toBe(false);
  });

  it("validates stored names exactly like the SQL CHECK, counting characters", () => {
    // SQLite trim() strips only spaces and length() counts characters.
    expect(initiativeNameSchema.safeParse("\u00a0").success).toBe(true);
    expect(initiativeNameSchema.safeParse("😀".repeat(120)).success).toBe(true);
    expect(initiativeNameSchema.safeParse("😀".repeat(121)).success).toBe(false);
    for (const invalid of [" Leading", "Trailing ", "", "Tab\tinside", "Line\nbreak", "nul\0"]) {
      expect(initiativeNameSchema.safeParse(invalid).success).toBe(false);
    }
    // Stored names are validated, never rewritten.
    expect(initiativeNameSchema.parse("Release")).toBe("Release");
  });

  it("accepts only palette colour names", () => {
    for (const color of PROJECT_COLOR_NAMES) expect(isInitiativeColor(color)).toBe(true);
    for (const invalid of ["#ff0000", "magenta", "", null, 3]) expect(isInitiativeColor(invalid)).toBe(false);
  });

  it("rotates default colours through the palette", () => {
    expect(defaultInitiativeColor(0)).toBe(PROJECT_COLOR_NAMES[0]);
    expect(defaultInitiativeColor(1)).toBe(PROJECT_COLOR_NAMES[1]);
    expect(defaultInitiativeColor(PROJECT_COLOR_NAMES.length)).toBe(PROJECT_COLOR_NAMES[0]);
    expect(defaultInitiativeColor(-3)).toBe(PROJECT_COLOR_NAMES[0]);
    expect(defaultInitiativeColor(Number.NaN)).toBe(PROJECT_COLOR_NAMES[0]);
  });

  it("validates complete initiatives strictly", () => {
    expect(initiativeSchema.parse(initiative())).toEqual(initiative());
    expect(initiativeSchema.parse(initiative({ brief: "😀".repeat(2_048), revision: 0 })))
      .toMatchObject({ revision: 0 });
    for (const invalid of [
      initiative({ id: "not-a-uuid" }),
      initiative({ color: "#00ff00" as never }),
      initiative({ status: "paused" as never }),
      initiative({ brief: "b".repeat(8_193) }),
      // The brief counts UTF-8 bytes: 2,049 four-byte characters are 8,196 bytes.
      initiative({ brief: "😀".repeat(2_049) }),
      initiative({ brief: "nul\0" }),
      initiative({ briefRevision: -1 }),
      initiative({ revision: -1 }),
      initiative({ createdAt: "yesterday" }),
      { ...initiative(), preferences: {} },
    ]) {
      expect(initiativeSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires every patch to change something known", () => {
    expect(initiativePatchSchema.parse({ status: "done" })).toEqual({ status: "done" });
    for (const invalid of [{}, { name: "" }, { color: "magenta" }, { status: "paused" }, { brief: "Later" }]) {
      expect(initiativePatchSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("orders by creation time, then identity, and lets only active initiatives take chats", () => {
    const later = initiative({ id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-19T11:00:00.000Z" });
    const sameTime = initiative({ id: "00000000-0000-4000-8000-000000000000" });
    expect([later, initiative(), sameTime].sort(compareInitiatives).map(({ id }) => id))
      .toEqual([sameTime.id, ID, later.id]);
    expect(initiativeAcceptsChats({ status: "active" })).toBe(true);
    expect(initiativeAcceptsChats({ status: "done" })).toBe(false);
    expect(initiativeAcceptsChats({ status: "archived" })).toBe(false);
  });

  it("groups members by initiative in input order and skips chats without one", () => {
    const chats = [
      { id: "a", initiativeId: "one" },
      { id: "b", initiativeId: null },
      { id: "c", initiativeId: "two" },
      { id: "d", initiativeId: "one" },
      { id: "e" },
    ];
    const members = initiativeMembers(chats, ({ initiativeId }: { initiativeId?: string | null }) => initiativeId);
    expect([...members.keys()]).toEqual(["one", "two"]);
    expect(members.get("one")?.map(({ id }) => id)).toEqual(["a", "d"]);
    expect(members.get("two")?.map(({ id }) => id)).toEqual(["c"]);
  });
});
