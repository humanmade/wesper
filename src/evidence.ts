export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function recordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((item) => recordOrUndefined(item) !== undefined);
}

export function stringArrayMap(value: unknown): value is Record<string, string[]> {
  const record = recordOrUndefined(value);
  return record !== undefined && Object.values(record).every(
    (entry) => Array.isArray(entry) && entry.every((item) => typeof item === 'string'),
  );
}

export function recordWithRecordArray(
  value: unknown,
  arrayKey: string,
): Record<string, Array<Record<string, unknown>>> | undefined {
  const record = recordOrUndefined(value);
  return record && recordArray(record[arrayKey]) ? record as Record<string, Array<Record<string, unknown>>> : undefined;
}
