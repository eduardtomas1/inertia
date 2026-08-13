function boundedText(value: unknown, max: number): boolean {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= max
    && !/[\0\r\n]/u.test(value);
}

export function providerFastModeField(
  value: unknown,
  expectedProviderValue: "priority" | "fast" | null,
): boolean {
  if (value === undefined || value === null) return true;
  if (expectedProviderValue === null) return false;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 4
    && keys.every((key) => [
      "providerValue",
      "label",
      "description",
      "isDefault",
    ].includes(key))
    && record.providerValue === expectedProviderValue
    && boundedText(record.label, 80)
    && boundedText(record.description, 500)
    && typeof record.isDefault === "boolean";
}
