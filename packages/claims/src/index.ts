import { createHash } from "node:crypto";

export const packageName = "@saga/claims";

export type ClaimKind = "decision" | "follow_up" | "observation" | "preference";

export interface ClaimEvidence {
  eventType: string;
  externalEventId: string;
  occurredAt: string;
  quote: string;
  rawEventId: string;
  sessionId?: string | undefined;
  sourceId: string;
  sourceType: string;
  traceId?: string | undefined;
}

export interface CandidateClaim {
  attributes: Record<string, unknown>;
  confidence: number;
  evidence: ClaimEvidence;
  kind: ClaimKind;
  text: string;
  workspaceId: string;
}

export interface ClaimExtractionRawEvent {
  eventType: string;
  externalEventId: string;
  id: string;
  occurredAt: Date | string;
  payload: Record<string, unknown>;
  sessionId?: string | null | undefined;
  sourceId: string;
  sourceType: string;
  traceId?: string | null | undefined;
  workspaceId: string;
}

const CLASSIFIERS: Array<{
  confidence: number;
  kind: ClaimKind;
  pattern: RegExp;
}> = [
  { confidence: 0.72, kind: "decision", pattern: /\b(agreed|sounds good|that makes sense)\b/i },
  {
    confidence: 0.7,
    kind: "preference",
    pattern: /\b(i'?d|i would|my bias|prefer|lean(?:ing)?|make sure)\b/i,
  },
  {
    confidence: 0.66,
    kind: "follow_up",
    pattern: /\b(we should|let'?s|can you|please|need to|worth)\b/i,
  },
  {
    confidence: 0.58,
    kind: "observation",
    pattern: /\b(i think|i imagine|it might|it feels|my guess)\b/i,
  },
];

export function extractCandidateClaimsFromRawEvents(
  events: readonly ClaimExtractionRawEvent[],
): CandidateClaim[] {
  return events.flatMap(extractCandidateClaimsFromRawEvent);
}

export function extractCandidateClaimsFromRawEvent(
  event: ClaimExtractionRawEvent,
): CandidateClaim[] {
  const prompt = promptFromRawEvent(event);
  if (prompt === undefined) return [];

  return candidateStatements(prompt).flatMap((statement) => {
    const classifier = CLASSIFIERS.find((entry) => entry.pattern.test(statement));
    if (classifier === undefined) return [];

    return [
      {
        attributes: {
          extractor: "deterministic-v1",
          source: "codex-hook-prompt",
        },
        confidence: classifier.confidence,
        evidence: {
          eventType: event.eventType,
          externalEventId: event.externalEventId,
          occurredAt:
            event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
          quote: statement,
          rawEventId: event.id,
          sessionId: event.sessionId ?? undefined,
          sourceId: event.sourceId,
          sourceType: event.sourceType,
          traceId: event.traceId ?? undefined,
        },
        kind: classifier.kind,
        text: normalizeClaimText(statement),
        workspaceId: event.workspaceId,
      },
    ];
  });
}

export function candidateClaimKey(claim: CandidateClaim): string {
  return createHash("sha256")
    .update(
      stableJson({
        evidence: {
          externalEventId: claim.evidence.externalEventId,
          quote: claim.evidence.quote,
          rawEventId: claim.evidence.rawEventId,
        },
        kind: claim.kind,
        text: claim.text,
        workspaceId: claim.workspaceId,
      }),
    )
    .digest("hex");
}

function promptFromRawEvent(event: ClaimExtractionRawEvent): string | undefined {
  if (event.eventType !== "codex.UserPromptSubmit") return undefined;
  const prompt = event.payload.prompt;
  return typeof prompt === "string" && prompt.trim() !== "" ? prompt : undefined;
}

function candidateStatements(prompt: string): string[] {
  const statements: string[] = [];
  let prefix = "";
  for (const line of prompt
    .split(/\r?\n|(?<=[.!])\s+/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => !line.endsWith("?"))) {
    if (/^(agreed|sounds good|that makes sense)[.!]?$/i.test(line)) {
      prefix = line;
      continue;
    }
    if (line.length < 12) continue;
    statements.push(prefix === "" ? line : `${prefix} ${line}`);
    prefix = "";
  }
  return statements;
}

function normalizeClaimText(statement: string): string {
  return statement
    .replace(/\s+/g, " ")
    .replace(/^(agreed[,.:;\s-]*)/i, "")
    .trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
