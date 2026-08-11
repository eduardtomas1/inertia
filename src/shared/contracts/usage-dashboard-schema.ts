type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function integerField(value: UnknownRecord, key: string): boolean {
  return Number.isSafeInteger(value[key]);
}

function nullableNonNegativeInteger(value: UnknownRecord, key: string): boolean {
  return value[key] === null
    || (integerField(value, key) && Number(value[key]) >= 0);
}

function recordWithStrings(value: unknown, ...keys: string[]): value is UnknownRecord {
  return record(value) && keys.every((key) => stringField(value, key));
}

function arrayOf(value: unknown, validate: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(validate);
}

function uniqueRecordField(values: unknown[], key: string): boolean {
  return new Set(values.map((entry) => record(entry) ? entry[key] : undefined)).size
    === values.length;
}

function sumRecordField(values: unknown[], key: string): number {
  return values.reduce<number>((sum, entry) =>
    sum + (record(entry) ? Number(entry[key]) : 0), 0);
}

function measuredValue(value: unknown): boolean {
  if (!record(value)) return false;
  if (!(nullableNonNegativeInteger(value, "value")
    && integerField(value, "measuredRequests")
    && Number(value.measuredRequests) >= 0
    && integerField(value, "totalRequests")
    && Number(value.totalRequests) >= Number(value.measuredRequests)
    && ["complete", "partial", "unavailable"].includes(String(value.coverage)))) {
    return false;
  }
  if (value.coverage === "complete") {
    return value.value !== null && value.measuredRequests === value.totalRequests;
  }
  if (value.coverage === "partial") {
    return value.value !== null
      && Number(value.measuredRequests) > 0
      && Number(value.measuredRequests) < Number(value.totalRequests);
  }
  return value.coverage === "unavailable" && value.value === null;
}

function statusCounts(value: UnknownRecord): boolean {
  const keys = [
    "completedCount",
    "failedCount",
    "cancelledCount",
    "interruptedCount",
  ];
  return integerField(value, "requestCount")
    && Number(value.requestCount) >= 0
    && keys.every((key) => integerField(value, key) && Number(value[key]) >= 0)
    && keys.reduce((sum, key) => sum + Number(value[key]), 0)
      === Number(value.requestCount);
}

function metricForRequests(value: unknown, requestCount: number): boolean {
  return measuredValue(value)
    && record(value)
    && value.totalRequests === requestCount;
}

function breakdown(value: unknown, model = false): boolean {
  if (!recordWithStrings(value, "key", "providerId", "providerLabel")) return false;
  return ["codex", "claude", "cursor", "opencode"].includes(value.providerId as string)
    && integerField(value, "requestCount")
    && Number(value.requestCount) >= 0
    && metricForRequests(value.runtime, Number(value.requestCount))
    && metricForRequests(value.processedTokens, Number(value.requestCount))
    && (!model || (
      recordWithStrings(
        value,
        "model",
        "backendProfileId",
        "backendLabel",
      )
      && integerField(value, "backendConfigurationRevision")
      && Number(value.backendConfigurationRevision) >= 0
    ));
}

export function usageDashboardSchema(value: unknown): boolean {
  if (!recordWithStrings(value, "generatedAt") || !record(value.range)) return false;
  const range = value.range;
  if (
    !integerField(range, "days")
    || ![7, 30, 90].includes(range.days as number)
    || !recordWithStrings(
      range,
      "fromInclusive",
      "toExclusive",
      "startDate",
      "endDate",
      "timeZone",
    )
    || !record(value.totals)
  ) return false;
  const totals = value.totals;
  return statusCounts(totals)
    && integerField(totals, "activeDays")
    && Number(totals.activeDays) >= 0
    && Number(totals.activeDays) <= Number(range.days)
    && Number(totals.activeDays) <= Number(totals.requestCount)
    && metricForRequests(totals.runtime, Number(totals.requestCount))
    && metricForRequests(totals.processedTokens, Number(totals.requestCount))
    && arrayOf(value.daily, (entry) => {
      if (!recordWithStrings(entry, "date")) return false;
      return statusCounts(entry)
        && metricForRequests(entry.runtime, Number(entry.requestCount))
        && metricForRequests(entry.processedTokens, Number(entry.requestCount));
    })
    && (value.daily as unknown[]).length === Number(range.days)
    && uniqueRecordField(value.daily as unknown[], "date")
    && sumRecordField(value.daily as unknown[], "requestCount")
      === Number(totals.requestCount)
    && (value.daily as unknown[]).filter((entry) =>
      record(entry) && Number(entry.requestCount) > 0).length
      === Number(totals.activeDays)
    && arrayOf(value.providers, (entry) => breakdown(entry))
    && uniqueRecordField(value.providers as unknown[], "key")
    && uniqueRecordField(value.providers as unknown[], "providerId")
    && sumRecordField(value.providers as unknown[], "requestCount")
      === Number(totals.requestCount)
    && arrayOf(value.models, (entry) => breakdown(entry, true))
    && uniqueRecordField(value.models as unknown[], "key")
    && sumRecordField(value.models as unknown[], "requestCount")
      === Number(totals.requestCount)
    && record(value.tokens)
    && [
      value.tokens.input,
      value.tokens.cachedInput,
      value.tokens.cacheWriteInput,
      value.tokens.output,
      value.tokens.reasoningOutput,
    ].every((entry) => metricForRequests(
      entry,
      Number(totals.requestCount),
    ))
    && record(value.cost)
    && value.cost.status === "unavailable"
    && stringField(value.cost, "reason");
}
