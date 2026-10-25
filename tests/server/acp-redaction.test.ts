// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import { AcpSecretRedactor } from "../../src/server/provider/acp-redaction";
import { CappedProviderBuffer } from "../../src/server/provider/io";

describe("ACP diagnostic stream redaction", () => {
  it("redacts a credential split where a raw cap would retain its prefix", () => {
    const secret = "split-secret-value";
    const split = 9;
    const redactor = new AcpSecretRedactor({ KIMI_API_KEY: secret });
    const capped = new CappedProviderBuffer(12);

    capped.append(redactor.stderrChunk(`safe:${secret.slice(0, split)}`));
    capped.append(redactor.stderrChunk(secret.slice(split)));
    capped.append(redactor.finishStderr());

    expect(capped.toString()).toContain("safe:");
    expect(capped.toString()).toContain("[redac");
    expect(capped.toString()).not.toContain(secret.slice(0, split));
    expect(capped.toString()).not.toContain(secret);
  });

  it("does not flush a terminal credential prefix into diagnostics", () => {
    const secret = "terminal-secret-value";
    const prefix = secret.slice(0, 11);
    const redactor = new AcpSecretRedactor({ KIMI_API_KEY: secret });

    const output = redactor.stderrChunk(`diagnostic:${prefix}`)
      + redactor.finishStderr();

    expect(output).toBe("diagnostic:[redacted]");
    expect(output).not.toContain(prefix);
  });

  it.each(["assistant", "reasoning", "stderr"] as const)(
    "redacts the whole held %s prefix when a shorter credential also matches",
    (stream) => {
      const secret = "overlapping-credential-value";
      const redactor = new AcpSecretRedactor({
        LONG_TOKEN: secret,
        PREFIX_TOKEN: secret.slice(0, 8),
      });
      const prefix = `safe:${secret.slice(0, -1)}`;
      const output = stream === "assistant"
        ? redactor.assistantChunk(prefix) + redactor.finishAssistant()
        : stream === "reasoning"
          ? redactor.reasoningChunk(prefix) + redactor.finishReasoning()
          : redactor.stderrChunk(prefix) + redactor.finishStderr();

      expect(output).toBe("safe:[redacted]");
    },
  );

  describe("overlapping credentials", () => {
    const token = "Tk9q7Zr2Wv5Nx8Lm4Pc6Hy3Jd1";
    type Stream = "assistant" | "reasoning" | "stderr";

    function stream(
      environment: NodeJS.ProcessEnv,
      updates: readonly string[],
      kind: Stream = "assistant",
      registered: readonly string[] = [token],
    ): { chunks: string[]; output: string } {
      const redactor = new AcpSecretRedactor(environment);
      redactor.addSecrets(registered);
      const push = (value: string) => kind === "assistant"
        ? redactor.assistantChunk(value)
        : kind === "reasoning" ? redactor.reasoningChunk(value) : redactor.stderrChunk(value);
      const chunks = updates.map(push);
      chunks.push(kind === "assistant"
        ? redactor.finishAssistant()
        : kind === "reasoning" ? redactor.finishReasoning() : redactor.finishStderr());
      return { chunks, output: chunks.join("") };
    }

    function leakedWindows(output: string, secrets: readonly string[]): string[] {
      const windows: string[] = [];
      for (const secret of secrets) {
        for (let index = 0; index + 4 <= secret.length; index += 1) {
          const window = secret.slice(index, index + 4);
          if (output.includes(window)) windows.push(window);
        }
      }
      return windows;
    }

    function everySplit(text: string): string[][] {
      const splits: string[][] = [[text]];
      for (let first = 1; first < text.length; first += 1) {
        splits.push([text.slice(0, first), text.slice(first)]);
        for (let second = first + 1; second < text.length; second += 1) {
          splits.push([text.slice(0, first), text.slice(first, second), text.slice(second)]);
        }
      }
      return splits;
    }

    it.each(["assistant", "reasoning", "stderr"] as const)(
      "redacts a credential tail that meets the token head on the %s stream",
      (kind) => {
        const text = `token k3y${token} done`;
        for (const updates of everySplit(text)) {
          const { output } = stream({ OTHER_TOKEN: "k3yTk9q7" }, updates, kind);
          expect(output, JSON.stringify(updates)).toBe("token [redacted] done");
        }
      },
    );

    it("redacts the reported single-update overlap without leaking the token tail", () => {
      const { output } = stream({ OTHER_TOKEN: "k3yTk9q7" }, [`token k3y${token} done`]);

      expect(output).toBe("token [redacted] done");
      expect(leakedWindows(output, [token, "k3yTk9q7"])).toEqual([]);
    });

    it("redacts a token followed by a credential that begins with its tail", () => {
      for (const updates of everySplit(`say ${token}XYZW ok`)) {
        const { output } = stream({ OTHER_TOKEN: "Jd1XYZW" }, updates);
        expect(output, JSON.stringify(updates)).toBe("say [redacted] ok");
      }
    });

    it("merges a three-way chain of overlapping credentials into one redaction", () => {
      const environment = { HEAD_TOKEN: "k3yTk9q7", TAIL_TOKEN: "Jd1XYZW" };
      for (const updates of everySplit(`a k3y${token}XYZW b`)) {
        const { output } = stream(environment, updates);
        expect(output, JSON.stringify(updates)).toBe("a [redacted] b");
      }
    });

    it("emits one redaction for duplicate, nested, and adjacent credentials", () => {
      expect(stream({ A_TOKEN: token, B_TOKEN: token }, [`x${token}${token}y`]).output).toBe("x[redacted]y");
      expect(stream({ NESTED_TOKEN: "Zr2Wv5" }, ["say Tk9q7Zr2W", "v5Nx8Lm4Pc6Hy3Jd1 ok"]).output)
        .toBe("say [redacted] ok");
      expect(stream({ NEXT_TOKEN: "abcd" }, [`abcd${token}abcd`]).output).toBe("[redacted]");
      expect(stream({ NEXT_TOKEN: "abcd" }, ["abcd", token, "abcd", " end"]).output).toBe("[redacted] end");
      expect(stream({ NEXT_TOKEN: "abcd" }, ["abcd abcd"]).output).toBe("[redacted] [redacted]");
    });

    it("keeps an open run held until the stream proves it cannot grow", () => {
      const redactor = new AcpSecretRedactor({ NEXT_TOKEN: "abcd" });
      redactor.addSecrets([token]);

      expect(redactor.assistantChunk("x abcd")).toBe("x ");
      expect(redactor.assistantChunk(token)).toBe("");
      expect(redactor.assistantChunk(" y")).toBe("[redacted] y");
      expect(redactor.assistantChunk(" abcd")).toBe(" ");
      expect(redactor.finishAssistant()).toBe("[redacted]");
    });

    it("redacts a held prefix at the end of the stream together with a shorter match", () => {
      expect(stream({ SHORT_TOKEN: token.slice(0, 3) }, [`say ${token.slice(0, 20)}`]).output).toBe("say [redacted]");
      expect(stream({ SHORT_TOKEN: token.slice(0, 2) }, [`say ${token.slice(0, 5)}`]).output).toBe("say [redacted]9q7");
      expect(stream({ SHORT_TOKEN: token.slice(0, 2) }, [`say ${token.slice(0, 5)}`], "stderr").output).toBe("say [redacted]");
    });

    it("matches multi-byte credentials and never splits a surrogate pair across chunks", () => {
      const emoji = "pw\u{1F600}secret99";
      const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
      for (const updates of everySplit(`say pw\u{1F600}secret99 ok \u{1F600}`)) {
        const { chunks, output } = stream({ EMOJI_TOKEN: emoji }, updates);
        expect(output, JSON.stringify(updates)).toBe("say [redacted] ok \u{1F600}");
        for (const chunk of chunks) expect(loneSurrogate.test(chunk), JSON.stringify(updates)).toBe(false);
      }
      expect(stream({ EMOJI_TOKEN: "\u{1F601}abcdef" }, ["say \u{1F600}\u{1F601}abcdef \u{1F600}"]).output)
        .toBe("say \u{1F600}[redacted] \u{1F600}");
      expect(stream({ ACCENT_TOKEN: "clé-日本-secret" }, ["a clé-日", "本-secret b"]).output).toBe("a [redacted] b");
    });
  });

  it("keeps paths and ordinary configuration out of the secret inventory", () => {
    const redactor = new AcpSecretRedactor({
      KIMI_API_KEY: "kimi-credential",
      KIMI_CONFIG_FILE: "/Users/example/.kimi/config.toml",
      PWD: "/Users/example/project",
    });

    expect(redactor.payload({
      text: "kimi-credential /Users/example/.kimi/config.toml /Users/example/project",
    })).toEqual({
      text: "[redacted] /Users/example/.kimi/config.toml /Users/example/project",
    });
  });
});
