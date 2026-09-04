// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import {
  geminiPromptWithReconstructedHistory,
  parseGeminiNewSessionResponse,
  parseGeminiPromptResponse,
} from "../../src/server/provider/gemini-acp-session";
import { validateGeminiInitialize } from "../../src/server/provider/gemini-acp-projection";

const validInitialize = {
  protocolVersion: 1,
  agentCapabilities: {
    promptCapabilities: { image: true },
    mcpCapabilities: { http: true },
  },
  agentInfo: { name: "gemini-cli", version: "0.58.0" },
};

const validSession = {
  sessionId: "gemini-session",
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan", description: "Read-only planning" },
    ],
  },
};

describe("Gemini ACP control response validation", () => {
  it("accepts only an exact, bounded Gemini CLI initialize identity", () => {
    expect(validateGeminiInitialize(validInitialize)).toEqual(validInitialize);

    for (const response of [
      null,
      [],
      { ...validInitialize, protocolVersion: 2 },
      { ...validInitialize, agentCapabilities: [] },
      { ...validInitialize, agentCapabilities: { promptCapabilities: [] } },
      { ...validInitialize, agentCapabilities: { mcpCapabilities: "http" } },
      { ...validInitialize, agentInfo: null },
      { ...validInitialize, agentInfo: { name: "Gemini CLI", version: "0.58.0" } },
      { ...validInitialize, agentInfo: { name: "gemini-cli ", version: "0.58.0" } },
      { ...validInitialize, agentInfo: { name: "gemini-cli", version: "" } },
      { ...validInitialize, agentInfo: { name: "gemini-cli", version: "0.58.0\nspoof" } },
    ]) {
      expect(() => validateGeminiInitialize(response)).toThrow(/gemini acp|gemini cli/iu);
    }
  });

  it("rejects malformed session identities and incoherent mode state", () => {
    expect(parseGeminiNewSessionResponse(validSession)).toMatchObject(validSession);

    const malformed = [
      null,
      [],
      { ...validSession, sessionId: "" },
      { ...validSession, sessionId: "x".repeat(201) },
      { ...validSession, sessionId: "session\nspoof" },
      { ...validSession, modes: null },
      { ...validSession, modes: { currentModeId: "default", availableModes: [] } },
      {
        ...validSession,
        modes: {
          currentModeId: "missing",
          availableModes: [{ id: "default", name: "Default" }],
        },
      },
      {
        ...validSession,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "default", name: "Duplicate" },
          ],
        },
      },
      {
        ...validSession,
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default\0spoof" }],
        },
      },
      {
        ...validSession,
        modes: {
          currentModeId: "default",
          availableModes: Array.from({ length: 17 }, (_, index) => ({
            id: `mode-${index}`,
            name: `Mode ${index}`,
          })),
        },
      },
    ];

    for (const response of malformed) {
      expect(() => parseGeminiNewSessionResponse(response)).toThrow(
        /malformed response/iu,
      );
    }
  });

  it("accepts every ACP v1 terminal reason and rejects malformed usage metadata", () => {
    for (const stopReason of [
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ]) {
      expect(parseGeminiPromptResponse({ stopReason })).toEqual({ stopReason });
    }
    expect(parseGeminiPromptResponse({
      stopReason: "end_turn",
      usage: {
        totalTokens: 8,
        inputTokens: 5,
        outputTokens: 3,
        thoughtTokens: 1,
      },
      _meta: {
        quota: { token_count: { input_tokens: 5, output_tokens: 3 } },
      },
    })).toMatchObject({ stopReason: "end_turn" });

    for (const response of [
      null,
      {},
      { stopReason: "done" },
      { stopReason: "end_turn\nspoof" },
      { stopReason: "end_turn", usage: [] },
      {
        stopReason: "end_turn",
        usage: { totalTokens: 1, inputTokens: 1 },
      },
      {
        stopReason: "end_turn",
        usage: { totalTokens: 1, inputTokens: -1, outputTokens: 0 },
      },
      {
        stopReason: "end_turn",
        usage: { totalTokens: 1.5, inputTokens: 1, outputTokens: 0 },
      },
      { stopReason: "end_turn", _meta: [] },
      { stopReason: "end_turn", _meta: { quota: "unavailable" } },
      {
        stopReason: "end_turn",
        _meta: { quota: { token_count: { input_tokens: Number.MAX_VALUE } } },
      },
    ]) {
      expect(() => parseGeminiPromptResponse(response)).toThrow(
        /malformed response/iu,
      );
    }
  });

  it("serializes only bounded role-tagged reconstructed history", () => {
    const prompt = geminiPromptWithReconstructedHistory("Continue", {
      source: "visible-transcript",
      truncated: true,
      messages: [
        { role: "user", content: "First request" },
        { role: "assistant", content: "First answer" },
      ],
    });
    expect(prompt).toContain("application-reconstructed conversation context");
    expect(prompt).toContain(
      JSON.stringify([
        { role: "user", content: "First request" },
        { role: "assistant", content: "First answer" },
      ]),
    );
    expect(prompt).toContain("Earlier visible history or long messages were truncated");
    expect(prompt).toMatch(/\[Current request\]\nContinue$/u);

    for (const history of [
      { source: "visible-transcript", truncated: false, messages: [] },
      {
        source: "visible-transcript",
        truncated: false,
        messages: [{ role: "system", content: "hidden" }],
      },
      {
        source: "visible-transcript",
        truncated: false,
        messages: [{ role: "user", content: "" }],
      },
      {
        source: "visible-transcript",
        truncated: false,
        messages: Array.from({ length: 65 }, () => ({
          role: "user",
          content: "message",
        })),
      },
      {
        source: "visible-transcript",
        truncated: false,
        messages: [{ role: "user", content: "x".repeat(24 * 1024 + 1) }],
      },
    ]) {
      expect(() => geminiPromptWithReconstructedHistory(
        "Continue",
        history as Parameters<typeof geminiPromptWithReconstructedHistory>[1],
      )).toThrow(/reconstructed conversation history/iu);
    }
  });
});
