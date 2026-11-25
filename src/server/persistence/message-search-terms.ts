import Database from "better-sqlite3";
import { messageSearchPattern } from "../../shared/message-search";

export const MESSAGE_SEARCH_INDEX_MIN_CHARACTERS = 3;
const MAX_TERM_GROUPS = 48;
const MAX_GROUP_ALTERNATIVES = 8;
const LAST_CASED_CODE_POINT = 0x1ffff;

let caseUniverse: string | null = null;

function codePointUniverse(): string {
  if (caseUniverse !== null) return caseUniverse;
  const parts: string[] = [];
  for (let start = 1; start <= LAST_CASED_CODE_POINT; start += 4_096) {
    const codes: number[] = [];
    for (let code = start; code < Math.min(start + 4_096, LAST_CASED_CODE_POINT + 1); code += 1) {
      if (code < 0xd800 || code > 0xdfff) codes.push(code);
    }
    parts.push(String.fromCodePoint(...codes));
  }
  caseUniverse = parts.join("");
  return caseUniverse;
}

function caseEquivalents(characters: readonly string[]): Map<string, string[]> {
  const members = new Map(characters.map((character) => [character, new Set([character])]));
  const sources = characters.map((character) => messageSearchPattern(character).source);
  const exact = characters.map((character, index) => [character, new RegExp(`^(?:${sources[index]})$`, "iu")] as const);
  for (const [found] of codePointUniverse().matchAll(new RegExp(sources.join("|"), "giu"))) {
    for (const [character, pattern] of exact) if (pattern.test(found)) members.get(character)!.add(found);
  }
  return new Map([...members].map(([character, set]) => [character, [...set]]));
}

function indexFolding(characters: readonly string[]): Map<string, string> {
  const folded = new Map<string, string>();
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE VIRTUAL TABLE folding USING fts5(text, tokenize = 'trigram', detail = full);
      CREATE VIRTUAL TABLE folding_terms USING fts5vocab(folding, 'instance');
    `);
    const insert = database.prepare("INSERT INTO folding (rowid, text) VALUES (?, ?)");
    database.transaction(() => {
      characters.forEach((character, index) => insert.run(index + 1, `\u0001${character}\u0001`));
    })();
    for (const { doc, term } of database.prepare("SELECT doc, term FROM folding_terms").iterate() as Iterable<{ doc: number; term: string }>) {
      const middle = [...term][1];
      const character = characters[doc - 1];
      if (middle !== undefined && character !== undefined) folded.set(character, middle);
    }
  } finally {
    database.close();
  }
  return folded;
}

function quoted(term: string): string {
  return `"${term.replaceAll("\"", "\"\"")}"`;
}

export function messageSearchIndexQuery(query: string): string | null {
  const characters = [...query];
  if (characters.length < MESSAGE_SEARCH_INDEX_MIN_CHARACTERS) return null;
  const equivalents = caseEquivalents([...new Set(characters)]);
  const folded = indexFolding([...new Set([...equivalents.values()].flat())]);
  const variants = new Map([...equivalents].map(([character, members]) => {
    const representatives = new Map<string, string>();
    for (const member of members) {
      const key = folded.get(member) ?? `\u0000${member}`;
      if (!representatives.has(key)) representatives.set(key, member);
    }
    return [character, [...representatives.values()]];
  }));
  const groups = new Set<string>();
  for (let index = 0; index + MESSAGE_SEARCH_INDEX_MIN_CHARACTERS <= characters.length; index += 1) {
    let alternatives = [""];
    for (const character of characters.slice(index, index + MESSAGE_SEARCH_INDEX_MIN_CHARACTERS)) {
      alternatives = alternatives.flatMap((prefix) => variants.get(character)!.map((variant) => prefix + variant));
      if (alternatives.length > MAX_GROUP_ALTERNATIVES) break;
    }
    if (alternatives.length > MAX_GROUP_ALTERNATIVES) continue;
    groups.add(alternatives.length === 1 ? quoted(alternatives[0]!) : `(${alternatives.map(quoted).join(" OR ")})`);
  }
  const all = [...groups];
  if (all.length === 0) return null;
  const selected = all.length <= MAX_TERM_GROUPS
    ? all
    : Array.from({ length: MAX_TERM_GROUPS }, (_, index) => all[Math.floor(index * (all.length - 1) / (MAX_TERM_GROUPS - 1))]!);
  return [...new Set(selected)].join(" AND ");
}
