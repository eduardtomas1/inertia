import {
  arrayOf,
  integerField,
  measuredValue,
  record,
  recordWithStrings,
  stringField,
  sumRecordField,
  uniqueRecordField,
  type UnknownRecord,
} from "./usage-dashboard-schema";

const PROVIDERS = ["codex", "claude", "cursor", "opencode"];

function booleanField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "boolean";
}

function providerId(value: unknown): boolean {
  return typeof value === "string" && PROVIDERS.includes(value);
}

function nonNegativeIntegerField(value: UnknownRecord, key: string): boolean {
  return integerField(value, key) && Number(value[key]) >= 0;
}

function summaryMetrics(value: UnknownRecord): boolean {
  return nonNegativeIntegerField(value, "turnCount")
    && nonNegativeIntegerField(value, "activeTurnCount")
    && Number(value.activeTurnCount) <= Number(value.turnCount)
    && measuredValue(value.runtime)
    && measuredValue(value.processedTokens);
}

function providerSummary(value: unknown): boolean {
  return recordWithStrings(value, "providerLabel")
    && providerId(value.providerId)
    && stringField(value, "providerLabel")
    && summaryMetrics(value);
}

function conversationSummary(value: unknown): boolean {
  return recordWithStrings(
    value,
    "conversationId",
    "projectId",
    "projectName",
    "title",
    "lastActivityAt",
  )
    && arrayOf(value.providerIds, providerId)
    && new Set(value.providerIds as unknown[]).size
      === (value.providerIds as unknown[]).length
    && booleanField(value, "createdToday")
    && booleanField(value, "running")
    && summaryMetrics(value)
    && value.running === (Number(value.activeTurnCount) > 0);
}

export function dailyWorkDashboardSchema(value: unknown): boolean {
  if (
    !record(value)
    || !stringField(value, "generatedAt")
    || !stringField(value, "date")
    || !record(value.range)
    || !["fromInclusive", "toExclusive", "timeZone"]
      .every((key) => stringField(value.range as UnknownRecord, key))
    || !record(value.totals)
    || !nonNegativeIntegerField(value.totals, "conversationCount")
    || !summaryMetrics(value.totals)
    || !arrayOf(value.providers, providerSummary)
    || !arrayOf(value.conversations, conversationSummary)
  ) return false;

  const providers = value.providers as UnknownRecord[];
  const conversations = value.conversations as UnknownRecord[];
  return uniqueRecordField(providers, "providerId")
    && uniqueRecordField(conversations, "conversationId")
    && value.totals.conversationCount === conversations.length
    && value.totals.turnCount === sumRecordField(conversations, "turnCount")
    && value.totals.activeTurnCount
      === sumRecordField(conversations, "activeTurnCount")
    && value.totals.turnCount === sumRecordField(providers, "turnCount")
    && value.totals.activeTurnCount
      === sumRecordField(providers, "activeTurnCount");
}
