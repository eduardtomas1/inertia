import type Database from "better-sqlite3";

import type { Conversation } from "../../shared/contracts";
import type { ConversationRepository } from "./conversation-repository";
import type { PairedLaunchRepository } from "./paired-launch-repository";
import type { NewConversationOptions } from "./types";

export interface DuoConversationPlan {
  projectId: string;
  title: string;
  options: NewConversationOptions;
}

export interface CreatedDuoConversations {
  sides: [Conversation, Conversation];
  comparison: Conversation | null;
}

export function createDuoConversationsAtomically(
  database: Database.Database,
  conversations: ConversationRepository,
  pairedLaunches: PairedLaunchRepository,
  launchId: string,
  sides: readonly [DuoConversationPlan, DuoConversationPlan],
  comparison: DuoConversationPlan | null,
  now: string,
): CreatedDuoConversations {
  return database.transaction(() => {
    const createdSides = sides.map((side) => conversations.create(
      side.projectId,
      side.title,
      { ...side.options, activate: false },
    )) as [Conversation, Conversation];
    pairedLaunches.attachConversations(
      launchId,
      [createdSides[0].id, createdSides[1].id],
      now,
    );
    const createdComparison = comparison
      ? conversations.create(
          comparison.projectId,
          comparison.title,
          { ...comparison.options, activate: false },
        )
      : null;
    if (createdComparison) {
      pairedLaunches.attachComparisonConversation(
        launchId,
        createdComparison.id,
        now,
      );
    }
    return { sides: createdSides, comparison: createdComparison };
  })();
}
