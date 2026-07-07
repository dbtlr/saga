// Presentation helpers shared by the READ client commands (SGA-239 slice 2).
//
// These reimplement the record-building helpers the original apps/cli commands
// use, but typed against the @saga/api-client WIRE shapes (ISO-string dates)
// instead of the @saga/db shapes (Date objects). The service already applies the
// agent-facing redaction pass before the value crosses the wire (proven by the
// service /v1 read-parity test), so the client renders the pre-redacted strings
// verbatim — it neither can (the boundary guard forbids @saga/db) nor needs to
// re-run redaction. The parity tests pin the rendered output byte-for-byte
// against the original commands.

// Wire dates are ISO strings, never Date objects; null renders as "none".
export function formatDate(value: string | null): string {
  return value === null ? 'none' : value;
}

export function formatRange(start: number | null, end: number | null): string {
  if (start === null && end === null) {
    return 'none';
  }
  return `${start === null ? '?' : String(start)}..${end === null ? '?' : String(end)}`;
}

export function compactJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? 'undefined' : truncate(json, 220);
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function stripTsHeadline(value: string): string {
  return value.replaceAll(/<\/?b>/g, '');
}

export function formatScore(value: number): string {
  return value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '');
}
