/** Field checks shared by the renderer's server-event validators. */
export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function stringField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}
export function nonemptyStringField(value: UnknownRecord, key: string): boolean {
  return stringField(value, key) && (value[key] as string).length > 0;
}
export function nullableStringField(value: UnknownRecord, key: string): boolean {
  return value[key] === null || stringField(value, key);
}
export function booleanField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "boolean";
}
export function numberField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}
export function integerField(value: UnknownRecord, key: string): boolean {
  return Number.isSafeInteger(value[key]);
}
export function integerFieldAtLeast(value: UnknownRecord, key: string, minimum = 0): boolean {
  return integerField(value, key) && Number(value[key]) >= minimum;
}
export function nullableNumberField(value: UnknownRecord, key: string): boolean {
  return value[key] === null || numberField(value, key);
}
export function optionalStringField(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || stringField(value, key);
}
export function optionalNullableStringField(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || nullableStringField(value, key);
}
export function optionalBooleanField(value: UnknownRecord, key: string): boolean {
  return value[key] === undefined || booleanField(value, key);
}
export function oneOf(value: UnknownRecord, key: string, options: readonly string[]): boolean {
  return typeof value[key] === "string" && options.includes(value[key] as string);
}
export function recordWithStrings(value: unknown, ...keys: string[]): value is UnknownRecord {
  return record(value) && keys.every((key) => stringField(value, key));
}
export function arrayOf(value: unknown, validate: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(validate);
}
