import { describe, expect, it } from "vitest";

import { insertComposerSkillToken } from "../../src/renderer/src/utils/composerSkillToken";

describe("insertComposerSkillToken", () => {
  it("inserts a canonical invocation at the caret with readable spacing", () => {
    expect(insertComposerSkillToken("Review this", "security-review", 7, 7))
      .toEqual({
        value: "Review $security-review this",
        selectionStart: 24,
        selectionEnd: 24,
        inserted: true,
      });
  });

  it("replaces the current dollar fragment and selected text", () => {
    expect(insertComposerSkillToken("Please $sec", "security-review", 11, 11))
      .toMatchObject({
        value: "Please $security-review ",
        inserted: true,
      });
    expect(insertComposerSkillToken("Please inspect now", "review", 7, 14))
      .toMatchObject({
        value: "Please $review now",
        inserted: true,
      });
  });

  it("focuses an existing exact token instead of duplicating it", () => {
    expect(insertComposerSkillToken(
      "$security-review inspect this",
      "security-review",
      29,
      29,
    )).toEqual({
      value: "$security-review inspect this",
      selectionStart: 16,
      selectionEnd: 16,
      inserted: false,
    });
  });

  it("does not confuse escaped or longer tokens with an existing invocation", () => {
    const value = "\\$review and $review-extra done";
    expect(insertComposerSkillToken(
      value,
      "review",
      value.length,
      value.length,
    )).toMatchObject({
      value: "\\$review and $review-extra done $review ",
      inserted: true,
    });
  });
});
