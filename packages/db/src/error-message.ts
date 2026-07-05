// Render an arbitrary thrown value as a message string for Effect error mapping.
// Internal substrate for the db package; intentionally not re-exported from the
// package index.
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
