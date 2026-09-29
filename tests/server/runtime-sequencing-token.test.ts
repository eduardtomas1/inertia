import { expect, it, vi } from "vitest";

const { timingSafeEqual } = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual };
});

import { parseRuntimeResumeRequest } from "../../src/server/runtime-sequencing";

it("compares the runtime WebSocket path token in constant time", () => {
  const path = "/runtime/0123456789abcdef0123456789abcdef";

  expect(parseRuntimeResumeRequest(path, path)).toEqual({ kind: "none" });
  expect(timingSafeEqual).toHaveBeenCalledOnce();
  expect(parseRuntimeResumeRequest("/runtime/0123456789abcdef0123456789abcdee", path))
    .toEqual({ kind: "invalid" });
  expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  expect(parseRuntimeResumeRequest("/runtime/0123", path)).toEqual({ kind: "invalid" });
  expect(parseRuntimeResumeRequest(`${path}/`, path)).toEqual({ kind: "invalid" });
});
