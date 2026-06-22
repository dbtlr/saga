import { createHash } from "node:crypto";
import { Data, Effect } from "effect";
import type { DatabaseError, DatabaseService } from "./database.js";
import {
  importRawSessionRecord,
  type RawSessionContentType,
  type RawSessionHarness,
  type RawSessionImportResult,
} from "./raw-session-import.js";

type JsonRecord = Record<string, unknown>;
type SqlTag = <T extends readonly object[]>(
  strings: TemplateStringsArray,
  ...parameters: readonly unknown[]
) => Promise<T>;
type NormalizedSessionRedactionPattern = {
  flags?: string | undefined;
  kind: "literal" | "regex";
  pattern: string;
  replacement: string;
};

export interface DeleteSessionSafetyInput {
  id: string;
  origin?: string | undefined;
  reason?: string | undefined;
  workspaceId: string;
}

export interface DeleteSessionSafetyResult {
  deletedAt: Date;
  operation: "deleted";
  origin: string;
  reason: string | null;
  sessionId: string;
  workspaceId: string;
  deleted: {
    embeddings: number;
    rawSessionRecords: number;
    segments: number;
    turns: number;
  };
}

export interface SessionRedactionPattern {
  flags?: string | undefined;
  kind: "literal" | "regex";
  pattern: string;
  replacement?: string | undefined;
}

export interface RedactSessionSafetyInput {
  id: string;
  origin?: string | undefined;
  patterns: readonly SessionRedactionPattern[];
  reason?: string | undefined;
  workspaceId: string;
}

export interface RedactSessionSafetyResult {
  operation: "redacted";
  origin: string;
  patternCount: number;
  previousRawSessionRecordId: string;
  reason: string | null;
  redactedAt: Date;
  replacementCount: number;
  rawSessionImport: RawSessionImportResult;
  sessionId: string;
  workspaceId: string;
}

export class SessionSafetyError extends Data.TaggedError("SessionSafetyError")<{
  readonly message: string;
}> {}

interface SessionIdentityRow {
  session_id: string;
}

interface CountRow {
  count: number | string;
}

interface ActiveRawSessionRow {
  author_display_name: string | null;
  author_external_subject: string | null;
  author_handle: string;
  raw_record_body_json: unknown;
  raw_record_body_text: string | null;
  raw_record_captured_at: Date | string;
  raw_record_content_hash: string;
  raw_record_content_type: string;
  raw_record_harness: string;
  raw_record_harness_session_id: string | null;
  raw_record_id: string;
  raw_record_metadata: JsonRecord;
  raw_record_provenance: JsonRecord;
  raw_record_snapshot_ordinal: number;
  raw_record_source_locator: string | null;
  session_id: string;
  session_model: string | null;
  session_status: string;
  session_title: string | null;
  source_binding_config: JsonRecord;
  source_binding_source_type: string;
  source_binding_source_uri: string;
}

export function deleteSessionSafety(
  service: DatabaseService,
  input: DeleteSessionSafetyInput,
): Effect.Effect<DeleteSessionSafetyResult, DatabaseError | SessionSafetyError> {
  return Effect.tryPromise({
    try: async () => {
      const workspaceId = normalizeRequired(input.workspaceId, "workspaceId");
      const id = normalizeRequired(input.id, "id");
      const origin = normalizeOptional(input.origin) ?? "db-api";
      const reason = normalizeOptional(input.reason) ?? null;
      const deletedAt = new Date();

      return service.sql.begin(async (tx) => {
        const txSql = tx as unknown as SqlTag;
        const identity = await findSessionIdentity(txSql, { id, workspaceId });
        if (identity === undefined) {
          throw new SessionSafetyError({
            message: `session or raw session record not found: ${id}`,
          });
        }

        const rawSessionRecordIds = await tx<{ id: string }[]>`
          select id
          from raw_session_records
          where workspace_id = ${workspaceId}
            and session_id = ${identity.session_id}
        `;
        const counts = {
          embeddings:
            rawSessionRecordIds.length === 0
              ? 0
              : await countRows(txSql, "session_segment_embeddings", {
                  rawSessionRecordIds: rawSessionRecordIds.map((record) => record.id),
                }),
          rawSessionRecords: rawSessionRecordIds.length,
          segments: await countRows(txSql, "session_segments", {
            sessionId: identity.session_id,
            workspaceId,
          }),
          turns: await countRows(txSql, "session_turns", {
            sessionId: identity.session_id,
            workspaceId,
          }),
        };

        if (rawSessionRecordIds.length > 0) {
          await tx`
            delete from session_segment_embeddings
            where raw_session_record_id = any(${rawSessionRecordIds.map((record) => record.id)}::uuid[])
          `;
        }
        await tx`
          delete from session_segments
          where workspace_id = ${workspaceId}
            and session_id = ${identity.session_id}
        `;
        await tx`
          delete from session_turns
          where workspace_id = ${workspaceId}
            and session_id = ${identity.session_id}
        `;
        await tx`
          delete from raw_session_records
          where workspace_id = ${workspaceId}
            and session_id = ${identity.session_id}
        `;
        await tx`
          delete from sessions
          where workspace_id = ${workspaceId}
            and id = ${identity.session_id}
        `;

        return {
          deleted: counts,
          deletedAt,
          operation: "deleted",
          origin,
          reason,
          sessionId: identity.session_id,
          workspaceId,
        };
      });
    },
    catch: (cause) =>
      cause instanceof SessionSafetyError
        ? cause
        : new SessionSafetyError({ message: errorMessage(cause) }),
  });
}

export function redactSessionSafety(
  service: DatabaseService,
  input: RedactSessionSafetyInput,
): Effect.Effect<RedactSessionSafetyResult, DatabaseError | SessionSafetyError> {
  return Effect.tryPromise({
    try: async () => {
      const workspaceId = normalizeRequired(input.workspaceId, "workspaceId");
      const id = normalizeRequired(input.id, "id");
      const origin = normalizeOptional(input.origin) ?? "db-api";
      const reason = normalizeOptional(input.reason) ?? null;
      const patterns = normalizePatterns(input.patterns);
      const activeRecord = await findActiveRawSessionRecord(service, { id, workspaceId });
      if (activeRecord === undefined) {
        throw new SessionSafetyError({
          message: `active session or raw session record not found: ${id}`,
        });
      }

      const rawContent = activeRecord.raw_record_body_text;
      if (rawContent === null) {
        throw new SessionSafetyError({ message: "active raw session record has no raw body text" });
      }

      const redaction = applyRedactions(rawContent, patterns);
      if (redaction.replacementCount === 0) {
        throw new SessionSafetyError({ message: "redaction patterns did not match the session" });
      }
      if (redaction.content === rawContent) {
        throw new SessionSafetyError({ message: "redaction did not change the session body" });
      }
      validateRedactedContent({
        bodyJson: activeRecord.raw_record_body_json,
        contentType: parseContentType(activeRecord.raw_record_content_type),
        rawContent: redaction.content,
      });
      await assertRedactedSnapshotIsNew(service, {
        contentHash: sha256(redaction.content),
        sessionId: activeRecord.session_id,
        workspaceId,
      });

      const redactedAt = new Date();
      const auditMetadata = {
        origin,
        patternCount: patterns.length,
        reason,
        redactedAt: redactedAt.toISOString(),
        replacementCount: redaction.replacementCount,
      };
      const importResult = await Effect.runPromise(
        importRawSessionRecord(service, {
          author: {
            displayName: activeRecord.author_display_name ?? undefined,
            externalSubject: activeRecord.author_external_subject ?? undefined,
            handle: activeRecord.author_handle,
          },
          capturedAt: redactedAt,
          contentType: parseContentType(activeRecord.raw_record_content_type),
          harness: parseHarness(activeRecord.raw_record_harness),
          harnessSessionId: activeRecord.raw_record_harness_session_id ?? undefined,
          host: hostFromSourceBinding(activeRecord),
          locator: activeRecord.raw_record_source_locator ?? undefined,
          metadata: {
            redaction: {
              ...auditMetadata,
              previousSnapshotOrdinal: activeRecord.raw_record_snapshot_ordinal,
              redactedFromRawSessionRecordId: activeRecord.raw_record_id,
            },
          },
          model: activeRecord.session_model ?? undefined,
          provenance: {
            origin,
            redactedAt: redactedAt.toISOString(),
            redactedBy: "saga session safety",
            redactedFromRawSessionRecordId: activeRecord.raw_record_id,
          },
          rawContent: redaction.content,
          rawRecord: {
            inactivePrevious: {
              metadata: {
                redactionTombstone: auditMetadata,
              },
              provenance: {
                origin,
                redactedAt: redactedAt.toISOString(),
                redactedBy: "saga session safety",
              },
              status: "redacted",
            },
            redactedFromRawSessionRecordId: activeRecord.raw_record_id,
            status: "redacted",
          },
          status: parseSessionStatus(activeRecord.session_status),
          title: activeRecord.session_title ?? undefined,
          workspaceId,
        }),
      );

      return {
        operation: "redacted",
        origin,
        patternCount: patterns.length,
        previousRawSessionRecordId: activeRecord.raw_record_id,
        rawSessionImport: importResult,
        reason,
        redactedAt,
        replacementCount: redaction.replacementCount,
        sessionId: activeRecord.session_id,
        workspaceId,
      };
    },
    catch: (cause) =>
      cause instanceof SessionSafetyError
        ? cause
        : new SessionSafetyError({ message: errorMessage(cause) }),
  });
}

async function findSessionIdentity(
  sql: SqlTag,
  input: { id: string; workspaceId: string },
): Promise<SessionIdentityRow | undefined> {
  const rows = await sql<SessionIdentityRow[]>`
    select s.id as session_id
    from sessions s
    where s.workspace_id = ${input.workspaceId}
      and s.id::text = ${input.id}
    union all
    select r.session_id as session_id
    from raw_session_records r
    where r.workspace_id = ${input.workspaceId}
      and r.id::text = ${input.id}
    limit 1
  `;
  return rows[0];
}

async function findActiveRawSessionRecord(
  service: DatabaseService,
  input: { id: string; workspaceId: string },
): Promise<ActiveRawSessionRow | undefined> {
  const rows = await service.sql<ActiveRawSessionRow[]>`
    select
      s.id as session_id,
      s.title as session_title,
      s.model as session_model,
      s.status as session_status,
      u.handle as author_handle,
      u.display_name as author_display_name,
      u.external_subject as author_external_subject,
      sb.source_type as source_binding_source_type,
      sb.source_uri as source_binding_source_uri,
      sb.config as source_binding_config,
      r.id as raw_record_id,
      r.snapshot_ordinal as raw_record_snapshot_ordinal,
      r.harness as raw_record_harness,
      r.harness_session_id as raw_record_harness_session_id,
      r.source_locator as raw_record_source_locator,
      r.content_type as raw_record_content_type,
      r.content_hash as raw_record_content_hash,
      r.body_text as raw_record_body_text,
      r.body_json as raw_record_body_json,
      r.captured_at as raw_record_captured_at,
      r.metadata as raw_record_metadata,
      r.provenance as raw_record_provenance
    from raw_session_records r
    inner join sessions s
      on s.id = r.session_id
      and s.workspace_id = r.workspace_id
    inner join users u
      on u.id = r.author_user_id
      and u.workspace_id = r.workspace_id
    inner join source_bindings sb
      on sb.id = r.source_binding_id
      and sb.workspace_id = r.workspace_id
    where r.workspace_id = ${input.workspaceId}
      and r.is_active = true
      and (s.id::text = ${input.id} or r.id::text = ${input.id})
    limit 1
  `;
  return rows[0];
}

async function assertRedactedSnapshotIsNew(
  service: DatabaseService,
  input: { contentHash: string; sessionId: string; workspaceId: string },
): Promise<void> {
  const rows = await service.sql<{ id: string }[]>`
    select id
    from raw_session_records
    where workspace_id = ${input.workspaceId}
      and session_id = ${input.sessionId}
      and content_hash = ${input.contentHash}
    limit 1
  `;
  if (rows[0] !== undefined) {
    throw new SessionSafetyError({
      message: "redacted content duplicates an existing raw session snapshot",
    });
  }
}

async function countRows(
  sql: SqlTag,
  table: "session_segment_embeddings" | "session_segments" | "session_turns",
  input: { rawSessionRecordIds: readonly string[] } | { sessionId: string; workspaceId: string },
): Promise<number> {
  if ("rawSessionRecordIds" in input) {
    if (input.rawSessionRecordIds.length === 0) return 0;
    const rows = await sql<CountRow[]>`
      select count(*)::int as count
      from session_segment_embeddings
      where raw_session_record_id = any(${input.rawSessionRecordIds}::uuid[])
    `;
    return Number(rows[0]?.count ?? 0);
  }

  const rows =
    table === "session_segments"
      ? await sql<CountRow[]>`
          select count(*)::int as count
          from session_segments
          where workspace_id = ${input.workspaceId}
            and session_id = ${input.sessionId}
        `
      : await sql<CountRow[]>`
          select count(*)::int as count
          from session_turns
          where workspace_id = ${input.workspaceId}
            and session_id = ${input.sessionId}
        `;
  return Number(rows[0]?.count ?? 0);
}

function normalizePatterns(
  patterns: readonly SessionRedactionPattern[],
): readonly NormalizedSessionRedactionPattern[] {
  if (patterns.length === 0) {
    throw new SessionSafetyError({ message: "at least one redaction pattern is required" });
  }
  return patterns.map((pattern) => {
    const normalized = normalizeRequired(pattern.pattern, "redaction pattern");
    if (pattern.kind !== "literal" && pattern.kind !== "regex") {
      throw new SessionSafetyError({ message: "redaction pattern kind must be literal or regex" });
    }
    return {
      kind: pattern.kind,
      pattern: normalized,
      replacement: pattern.replacement ?? "[REDACTED]",
      ...(pattern.flags === undefined ? {} : { flags: pattern.flags }),
    };
  });
}

function applyRedactions(
  content: string,
  patterns: readonly NormalizedSessionRedactionPattern[],
): { content: string; replacementCount: number } {
  let redactedContent = content;
  let replacementCount = 0;
  for (const pattern of patterns) {
    if (pattern.kind === "literal") {
      const pieces = redactedContent.split(pattern.pattern);
      const matches = pieces.length - 1;
      replacementCount += matches;
      redactedContent = pieces.join(pattern.replacement);
      continue;
    }

    const flags = new Set((pattern.flags ?? "").split(""));
    flags.add("g");
    const regex = new RegExp(pattern.pattern, [...flags].join(""));
    redactedContent = redactedContent.replace(regex, () => {
      replacementCount += 1;
      return pattern.replacement;
    });
  }
  return { content: redactedContent, replacementCount };
}

function validateRedactedContent(input: {
  bodyJson: unknown;
  contentType: RawSessionContentType;
  rawContent: string;
}): void {
  if (input.bodyJson === null || input.bodyJson === undefined || input.contentType === "text") {
    return;
  }
  if (input.contentType === "json") {
    parseJson(input.rawContent, "redacted JSON body");
    return;
  }
  for (const line of input.rawContent.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    parseJson(line, "redacted JSONL line");
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SessionSafetyError({ message: `${label} must remain valid JSON` });
  }
}

function hostFromSourceBinding(row: ActiveRawSessionRow): {
  id: string;
  label?: string | undefined;
  projectRoot?: string | undefined;
} {
  const config = asRecord(row.source_binding_config);
  const hostId = typeof config.hostId === "string" ? config.hostId : row.source_binding_source_uri;
  return {
    id: hostId,
    label: typeof config.hostLabel === "string" ? config.hostLabel : undefined,
    projectRoot: typeof config.projectRoot === "string" ? config.projectRoot : undefined,
  };
}

function parseHarness(value: string): RawSessionHarness {
  if (value === "claude" || value === "codex") return value;
  throw new SessionSafetyError({ message: `unsupported raw session harness: ${value}` });
}

function parseContentType(value: string): RawSessionContentType {
  if (value === "json" || value === "jsonl" || value === "text") return value;
  throw new SessionSafetyError({ message: `unsupported raw session content type: ${value}` });
}

function parseSessionStatus(value: string): "active" | "completed" | undefined {
  if (value === "active" || value === "completed") return value;
  return undefined;
}

function normalizeRequired(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    throw new SessionSafetyError({ message: `${label} is required` });
  }
  return trimmed;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
