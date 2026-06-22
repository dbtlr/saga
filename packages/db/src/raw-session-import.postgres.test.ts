import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeDatabase, runMigrations, type DatabaseService } from "./database.js";
import { importRawSessionRecord } from "./raw-session-import.js";
import {
  rawSessionRecords,
  sessions,
  sessionSegments,
  sessionTurns,
  sourceBindings,
  users,
  workspaces,
} from "./schema.js";

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("raw session import", () => {
  const databaseName = `saga_raw_session_import_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? "", { max: 1 });
  let service: DatabaseService | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const testDatabaseUrl = new URL(databaseUrl ?? "");
    testDatabaseUrl.pathname = `/${databaseName}`;

    service = await Effect.runPromise(
      makeDatabase(
        {
          databaseUrl: testDatabaseUrl.toString(),
          environment: "test",
          logLevel: "info",
          service: {
            host: "127.0.0.1",
            port: 4766,
          },
          secrets: {
            openaiApiKey: undefined,
          },
        },
        {
          postgres: {
            max: 1,
          },
        },
      ),
    );
    await Effect.runPromise(runMigrations(service));
  });

  afterAll(async () => {
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  async function createBoundWorkspace(handlePrefix: string): Promise<string> {
    if (service === undefined) throw new Error("database service was not initialized");
    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `${handlePrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      })
      .returning();
    if (workspace === undefined) throw new Error("workspace insert returned no row");
    return workspace.id;
  }

  test("imports the same raw record idempotently without duplicate active snapshots", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("raw-import-idempotent");
    const input = {
      author: {
        displayName: "Drew",
        handle: "drew",
      },
      capturedAt: "2026-06-21T14:00:00.000Z",
      contentType: "jsonl",
      harness: "codex",
      harnessMetadata: {
        cliVersion: "test",
      },
      harnessSessionId: "codex-session-1",
      host: {
        id: "host-1",
        label: "local-host",
        projectRoot: "/tmp/saga",
      },
      locator: "/tmp/codex-session-1.jsonl",
      rawContent: '{"type":"user","text":"Build SGA-120"}\n',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const second = await Effect.runPromise(importRawSessionRecord(service, input));

    expect(first.operation).toBe("inserted");
    expect(second.operation).toBe("unchanged");
    expect(second.session.id).toBe(first.session.id);
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(second.sourceBinding.id).toBe(first.sourceBinding.id);
    expect(second.authorUser.id).toBe(first.authorUser.id);

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id));
    expect(records).toHaveLength(1);
    expect(records.filter((record) => record.isActive)).toHaveLength(1);
    expect(records[0]?.contentBytes).toBe(Buffer.byteLength(input.rawContent, "utf8"));
    expect(records[0]?.metadata).toMatchObject({
      contentBytes: Buffer.byteLength(input.rawContent, "utf8"),
      sourceLocatorHash: expect.stringMatching(/^sha256:/),
    });

    const bindings = await service.db
      .select()
      .from(sourceBindings)
      .where(eq(sourceBindings.workspaceId, workspaceId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sourceType: "codex",
      sourceUri: "codex://host/host-1",
    });

    const hostUsers = await service.db
      .select()
      .from(users)
      .where(eq(users.workspaceId, workspaceId));
    expect(hostUsers).toHaveLength(1);
    expect(hostUsers[0]).toMatchObject({
      handle: "drew",
      identitySource: "host",
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id));
    expect(turns).toHaveLength(1);
    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id));
    expect(segments).toHaveLength(1);
  });

  test("imports growing raw content as a new active snapshot and regenerates derived rows", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("raw-import-growing");
    const baseInput = {
      author: {
        handle: "drew",
      },
      capturedAt: "2026-06-21T15:00:00.000Z",
      contentType: "jsonl",
      harness: "claude",
      host: {
        id: "host-2",
        label: "local-host",
      },
      locator: "/tmp/claude-growing.jsonl",
      rawContent: '{"role":"user","content":"First turn"}\n',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, baseInput));
    const second = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: "2026-06-21T15:05:00.000Z",
        rawContent:
          '{"role":"user","content":"First turn"}\n{"role":"assistant","content":"Second turn"}\n',
      }),
    );

    expect(second.operation).toBe("inserted");
    expect(second.session.id).toBe(first.session.id);
    expect(second.rawSessionRecord.id).not.toBe(first.rawSessionRecord.id);
    expect(second.rawSessionRecord.snapshotOrdinal).toBe(
      first.rawSessionRecord.snapshotOrdinal + 1,
    );
    expect(second.rawSessionRecord.isActive).toBe(true);

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id));
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.isActive).map((record) => record.id)).toEqual([
      second.rawSessionRecord.id,
    ]);
    expect(records.find((record) => record.id === first.rawSessionRecord.id)?.isActive).toBe(false);

    const oldTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id));
    expect(oldTurns).toHaveLength(0);
    const oldSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id));
    expect(oldSegments).toHaveLength(0);

    const newTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, second.rawSessionRecord.id));
    expect(newTurns).toHaveLength(1);

    const activeSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(
        and(
          eq(sessionSegments.rawSessionRecordId, second.rawSessionRecord.id),
          eq(sessionSegments.sessionId, second.session.id),
        ),
      );
    expect(activeSegments).toHaveLength(1);
    expect(activeSegments[0]?.searchText).toContain("Second turn");
  });

  test("normalizes Codex transcript JSONL into session metadata, turns, parts, and spans", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("codex-normalize");
    const rawContent = codexTranscript([
      {
        timestamp: "2026-06-22T14:00:00.000Z",
        type: "session_meta",
        payload: {
          agent_role: "subagent",
          cli_version: "0.42.0-test",
          cwd: "/work/saga",
          id: "codex-transcript-session-1",
          model_provider: "openai",
          parent_thread_id: "parent-thread-1",
        },
      },
      {
        timestamp: "2026-06-22T14:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      },
      {
        timestamp: "2026-06-22T14:00:02.000Z",
        type: "turn_context",
        payload: {
          cwd: "/work/saga",
          model: "gpt-5-codex",
          turn_id: "turn-1",
        },
      },
      {
        timestamp: "2026-06-22T14:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Normalize Codex transcripts." }],
          metadata: { turn_id: "turn-1" },
        },
      },
      {
        timestamp: "2026-06-22T14:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "msg-assistant-1",
          role: "assistant",
          content: [{ type: "output_text", text: "I will parse JSONL into structured turns." }],
          metadata: { turn_id: "turn-1" },
        },
      },
      {
        timestamp: "2026-06-22T14:00:05.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "call-item-1",
          call_id: "call-1",
          name: "exec_command",
          arguments: '{"cmd":"pnpm test"}',
          metadata: { turn_id: "turn-1" },
        },
      },
      {
        timestamp: "2026-06-22T14:00:06.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "tests passed",
        },
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          displayName: "Drew",
          handle: "drew",
        },
        capturedAt: "2026-06-22T14:00:10.000Z",
        contentType: "jsonl",
        harness: "codex",
        host: {
          id: "host-codex-normalize",
          label: "local-host",
          projectRoot: "/work/saga",
        },
        locator: "/tmp/codex-transcript-session-1.jsonl",
        rawContent,
        workspaceId,
      }),
    );

    expect(result.operation).toBe("inserted");
    expect(result.session.harnessSessionId).toBe("codex-transcript-session-1");

    const [session] = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, result.session.id))
      .limit(1);
    expect(session).toMatchObject({
      harness: "codex",
      harnessSessionId: "codex-transcript-session-1",
      model: "gpt-5-codex",
    });
    expect(session?.metadata).toMatchObject({
      cliVersion: "0.42.0-test",
      cwd: "/work/saga",
      detectedHarnessSessionId: "codex-transcript-session-1",
      normalizer: "codex-transcript-v1",
      subagentEvidence: [
        {
          sourceRecordType: "session_meta",
        },
      ],
      turnCount: 4,
    });

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.bodyJson).toEqual(
      rawContent
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        cwd: "/work/saga",
        detectedHarnessSessionId: "codex-transcript-session-1",
        normalizer: "codex-transcript-v1",
        subagentEvidence: [
          {
            sourceRecordType: "session_meta",
          },
        ],
        turnCount: 4,
      },
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(turns[0]).toMatchObject({
      actorKind: "host_user",
      harnessTurnId: "turn-1:user:3",
      model: "gpt-5-codex",
      rawSpan: {
        lineStart: 3,
        lineEnd: 3,
      },
    });
    expect(turns[0]?.metadata).toMatchObject({
      codexTurnId: "turn-1",
      cwd: "/work/saga",
      normalizer: "codex-transcript-v1",
    });
    expect(turns[0]?.contentParts).toEqual([
      { type: "text", text: "Normalize Codex transcripts." },
    ]);
    expect(turns[1]?.harnessTurnId).toBe("msg-assistant-1");
    expect(turns[2]?.contentParts).toEqual([
      {
        type: "tool_call",
        name: "exec_command",
        callId: "call-1",
        arguments: { cmd: "pnpm test" },
      },
    ]);
    expect(turns[3]?.contentParts).toEqual([
      {
        type: "tool_result",
        name: "exec_command",
        callId: "call-1",
        output: "tests passed",
      },
    ]);

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(segments).toHaveLength(4);
    expect(segments.map((segment) => segment.searchText)).toEqual([
      "Normalize Codex transcripts.",
      "I will parse JSONL into structured turns.",
      'exec_command {"cmd":"pnpm test"}',
      "exec_command tests passed",
    ]);
    expect(segments[0]).toMatchObject({
      charStart: expect.any(Number),
      charEnd: expect.any(Number),
      metadata: {
        codexTurnId: "turn-1",
        normalizer: "codex-transcript-v1",
        role: "user",
      },
    });
  });

  test("regenerates Codex derived rows from the active growing snapshot", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("codex-growing");
    const baseRecords = [
      {
        timestamp: "2026-06-22T15:00:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/work/saga",
          id: "codex-growing-session",
        },
      },
      {
        timestamp: "2026-06-22T15:00:01.000Z",
        type: "turn_context",
        payload: {
          cwd: "/work/saga",
          model: "gpt-5-codex",
          turn_id: "turn-1",
        },
      },
      {
        timestamp: "2026-06-22T15:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "First prompt" }],
          metadata: { turn_id: "turn-1" },
        },
      },
    ] as const;

    const importInput = {
      author: {
        handle: "drew",
      },
      capturedAt: "2026-06-22T15:00:03.000Z",
      contentType: "jsonl",
      harness: "codex",
      host: {
        id: "host-codex-growing",
      },
      locator: "/tmp/codex-growing.jsonl",
      rawContent: codexTranscript(baseRecords),
      workspaceId,
    } as const;
    const first = await Effect.runPromise(importRawSessionRecord(service, importInput));
    const second = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...importInput,
        capturedAt: "2026-06-22T15:00:05.000Z",
        rawContent: codexTranscript([
          ...baseRecords,
          {
            timestamp: "2026-06-22T15:00:04.000Z",
            type: "response_item",
            payload: {
              type: "message",
              id: "assistant-growing-1",
              role: "assistant",
              content: [{ type: "output_text", text: "Second answer" }],
              metadata: { turn_id: "turn-1" },
            },
          },
        ]),
      }),
    );

    expect(second.operation).toBe("inserted");
    expect(second.session.id).toBe(first.session.id);

    const oldTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id));
    expect(oldTurns).toHaveLength(0);

    const newTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, second.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(newTurns.map((turn) => turn.role)).toEqual(["user", "assistant"]);

    const activeSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, second.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(activeSegments.map((segment) => segment.searchText)).toEqual([
      "First prompt",
      "Second answer",
    ]);
  });

  test("requires an existing bound workspace", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    await expect(
      Effect.runPromise(
        importRawSessionRecord(service, {
          author: {
            handle: "drew",
          },
          contentType: "text",
          harness: "codex",
          harnessSessionId: "missing-workspace",
          host: {
            id: "host-3",
          },
          rawContent: "missing workspace",
          workspaceId: "00000000-0000-0000-0000-000000000000",
        }),
      ),
    ).rejects.toThrow("workspace binding is required before importing raw sessions");
  });
});

function codexTranscript(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
