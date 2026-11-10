import { describe, expect, it } from "vitest";

import {
  composerPlaceholder,
  composerTriggerHint,
  skillsMenuEnabled,
} from "../../src/renderer/src/components/composer/composerPlaceholder";

const idle = {
  disabled: false,
  running: false,
  stopsBeforeSending: false,
  queueBlocked: false,
  hasHistory: false,
  skillsAvailable: false,
};

describe("composer placeholder", () => {
  it("opens a new chat with Ask anything and the triggers it supports, in file, skill, command order", () => {
    expect(composerPlaceholder(idle)).toBe("Ask anything. @ files, / commands");
    expect(composerPlaceholder({ ...idle, skillsAvailable: true }))
      .toBe("Ask anything. @ files, $ skills, / commands");
  });

  it("says Follow up once the chat has history", () => {
    expect(composerPlaceholder({ ...idle, hasHistory: true })).toBe("Follow up. @ files, / commands");
    expect(composerPlaceholder({ ...idle, hasHistory: true, skillsAvailable: true }))
      .toBe("Follow up. @ files, $ skills, / commands");
  });

  it("keeps the queue placeholders while the agent works", () => {
    expect(composerPlaceholder({ ...idle, running: true, hasHistory: true, skillsAvailable: true }))
      .toBe("Enter sends · Tab queues");
    expect(composerPlaceholder({ ...idle, running: true, stopsBeforeSending: true, hasHistory: true }))
      .toBe("Enter stops and sends · Tab queues");
  });

  it("lists only commands while a blocked queue leaves a running chat without file and skill menus", () => {
    expect(composerPlaceholder({ ...idle, running: true, queueBlocked: true, hasHistory: true, skillsAvailable: true }))
      .toBe("Follow up. / commands");
    expect(composerPlaceholder({ ...idle, running: true, stopsBeforeSending: true, queueBlocked: true, hasHistory: true }))
      .toBe("Follow up. / commands");
  });

  it("falls back to the bare prompt while the composer is disabled, whatever else is true", () => {
    for (const running of [false, true]) {
      for (const stopsBeforeSending of [false, true]) {
        for (const skillsAvailable of [false, true]) {
          const state = { ...idle, disabled: true, running, stopsBeforeSending, skillsAvailable };
          expect(composerPlaceholder(state)).toBe("Ask anything.");
          expect(composerPlaceholder({ ...state, hasHistory: true })).toBe("Follow up.");
        }
      }
    }
  });

  it("offers $ skills only when the skills menu would open", () => {
    expect(skillsMenuEnabled({ disabled: false, running: false, skillsAvailable: true })).toBe(true);
    expect(skillsMenuEnabled({ disabled: true, running: false, skillsAvailable: true })).toBe(false);
    expect(skillsMenuEnabled({ disabled: false, running: true, skillsAvailable: true })).toBe(false);
    expect(skillsMenuEnabled({ disabled: false, running: false, skillsAvailable: false })).toBe(false);
    expect(composerTriggerHint({ disabled: true, running: false, skillsAvailable: true })).toBe("@ files, / commands");
  });

  it("never names a trigger the composer does not handle", () => {
    for (const disabled of [false, true]) {
      for (const running of [false, true]) {
        for (const skillsAvailable of [false, true]) {
          const hint = composerTriggerHint({ disabled, running, skillsAvailable });
          expect(hint.split(", ").map((part) => part[0])).toEqual(
            [...(running ? [] : ["@"]), ...(skillsAvailable && !running && !disabled ? ["$"] : []), "/"],
          );
          expect(hint).not.toMatch(/#|!/u);
        }
      }
    }
  });
});
