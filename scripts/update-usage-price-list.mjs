import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMMIT = process.argv[2] ?? "";
if (!/^[0-9a-f]{40}$/u.test(COMMIT)) throw new Error("Pass the BerriAI/litellm commit to copy prices from, as a full SHA.");
const SOURCE = `https://raw.githubusercontent.com/BerriAI/litellm/${COMMIT}/model_prices_and_context_window.json`;
const OUTPUT = fileURLToPath(new URL("../src/server/usage/bundled-price-list.json", import.meta.url));
const PROVIDERS = new Set(["anthropic", "openai", "gemini", "xai", "moonshot", "deepseek", "mistral", "meta_llama"]);
const MODES = new Set(["chat", "responses", "completion"]);

const rate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

const response = await fetch(SOURCE, { redirect: "error", signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`The price list request failed with ${response.status}.`);
const document = await response.json();
const models = {};
for (const [rawKey, entry] of Object.entries(document).sort(([left], [right]) => left < right ? -1 : 1)) {
  if (entry === null || typeof entry !== "object") continue;
  const input = rate(entry.input_cost_per_token);
  const output = rate(entry.output_cost_per_token);
  if (input === null || output === null || !PROVIDERS.has(entry.litellm_provider) || !MODES.has(entry.mode)) continue;
  const rates = [
    input,
    output,
    rate(entry.cache_read_input_token_cost) ?? input,
    rate(entry.cache_creation_input_token_cost) ?? input,
  ];
  models[rawKey.trim().toLowerCase()] = rates;
}
for (const [key, rates] of Object.entries(models)) {
  const bare = key.slice(key.lastIndexOf("/") + 1);
  if (bare) models[bare] ??= rates;
}
if (Object.keys(models).length < 50) throw new Error("The price list has too few priced models.");
const rows = Object.entries(models).map(([id, rates]) => `  ${JSON.stringify(id)}: ${JSON.stringify(rates)}`);
writeFileSync(OUTPUT, `{\n "fetchedAt": ${JSON.stringify(new Date().toISOString())},\n "source": ${JSON.stringify(SOURCE)},\n "models": {\n${rows.join(",\n")}\n }\n}\n`);
process.stdout.write(`Wrote ${Object.keys(models).length} models to ${OUTPUT}\n`);
