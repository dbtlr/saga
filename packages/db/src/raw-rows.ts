// Shared boundary for the drizzle driver's untyped `execute` result.
//
// `execute` returns either a raw array of rows or a wrapper object with a `rows`
// array, depending on the driver. This is the single audited seam where that
// untyped result is narrowed to the row shape T the caller's SQL declares; the
// row type cannot be verified at runtime, so the one unavoidable assertion lives
// here rather than being scattered across every call site.

export type JsonRecord = Record<string, unknown>;

export function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rowsFromExecute<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- raw driver rows; T is the caller-declared row shape
    return value as T[];
  }
  if (isPlainRecord(value) && Array.isArray(value.rows)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- raw driver rows; T is the caller-declared row shape
    return value.rows as T[];
  }
  return [];
}
