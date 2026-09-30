import type { MascotStatus } from "./mascot";

export interface MascotChatChoice {
  title: string;
  project: string | null;
}

export function mascotChatChoices(chats: readonly MascotStatus[]): MascotChatChoice[] {
  const choices = chats.map((chat) => ({ title: chat.chatTitle || "Untitled chat", project: chat.projectName || null }));
  const age = chats.map((chat) => `${chat.since ?? ""}\u0000${chat.conversationId ?? ""}`);
  const oldestFirst = chats.map((_, index) => index).sort((left, right) => age[left]! < age[right]! ? -1 : 1);
  for (let pass = 0; pass < chats.length; pass += 1) {
    const groups = new Map<string, number[]>();
    for (const index of oldestFirst) {
      const key = JSON.stringify(choices[index]);
      groups.set(key, [...groups.get(key) ?? [], index]);
    }
    const twins = [...groups.values()].filter((group) => group.length > 1);
    if (!twins.length) break;
    for (const group of twins) group.forEach((index, position) => { choices[index]!.title += ` (${position + 1})`; });
  }
  return choices;
}
