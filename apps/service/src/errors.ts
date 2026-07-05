// Render an arbitrary thrown value as a single human-readable line. postgres.js
// reports connection refusal as an AggregateError with an empty message, so
// unwrap those recursively; otherwise fall back to a non-empty Error message,
// the Error name, or String(). Shared by the server and the job runner.
export function describeError(cause: unknown): string {
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return cause.errors.map((error) => describeError(error)).join('; ');
  }
  if (cause instanceof Error) {
    return cause.message === '' ? cause.name : cause.message;
  }
  return String(cause);
}
