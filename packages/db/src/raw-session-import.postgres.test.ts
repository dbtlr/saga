import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeClaudeTranscript } from "./claude-transcript-normalizer.js";
import { normalizeCodexTranscript } from "./codex-transcript-normalizer.js";
import { makeDatabase, runMigrations, type DatabaseService } from "./database.js";
import { importRawSessionRecord } from "./raw-session-import.js";
import {
  activityIntervals,
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

  test("migrates lexical indexes for session segment search", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const indexes = await service.db.execute<{ indexdef: string; indexname: string }>(sql`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'session_segments'
        and indexname in ('session_segments_search_tsv_idx', 'session_segments_search_trgm_idx')
      order by indexname
    `);

    expect(indexes.map((index) => index.indexname)).toEqual([
      "session_segments_search_trgm_idx",
      "session_segments_search_tsv_idx",
    ]);
    expect(
      indexes.find((index) => index.indexname === "session_segments_search_tsv_idx")?.indexdef,
    ).toContain("to_tsvector");
    expect(
      indexes.find((index) => index.indexname === "session_segments_search_trgm_idx")?.indexdef,
    ).toContain("gin_trgm_ops");
  });

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
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      ordinal: 0,
      searchText: "Build SGA-120",
      segmentKind: "turn",
      tokenStart: 0,
    });
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
    expect(newTurns).toHaveLength(2);

    const activeSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(
        and(
          eq(sessionSegments.rawSessionRecordId, second.rawSessionRecord.id),
          eq(sessionSegments.sessionId, second.session.id),
        ),
      );
    expect(activeSegments).toHaveLength(2);
    expect(activeSegments.map((segment) => segment.searchText)).toEqual([
      "First turn",
      "Second turn",
    ]);
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
          source: {
            subagent: {
              thread_spawn: {
                parent_turn_id: "parent-turn-1",
              },
            },
          },
          thread_source: "subagent",
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
          type: "custom_tool_call",
          status: "completed",
          call_id: "call-1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Add File: note.md\n+tests passed\n*** End Patch\n",
          metadata: { turn_id: "turn-1" },
        },
      },
      {
        timestamp: "2026-06-22T14:00:06.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated files\n",
        },
      },
      {
        timestamp: "2026-06-22T14:00:07.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          status: "completed",
          call_id: "call-2",
          name: "web.run",
          arguments: '{"open":[{"ref_id":"turn0search0"}]}',
          metadata: { turn_id: "turn-1" },
        },
      },
      {
        timestamp: "2026-06-22T14:00:08.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-2",
          output: [
            { type: "text", text: "Structured array output needle" },
            { type: "image", image_url: "file:///tmp/codex-output.png" },
          ],
        },
      },
      {
        timestamp: "2026-06-22T14:00:09.000Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          id: "ws-call-1",
          status: "completed",
          action: {
            type: "search",
            query: "SGA-121 Codex web_search_call fixture",
          },
          metadata: { turn_id: "turn-1" },
        },
      },
      {
        timestamp: "2026-06-22T14:00:10.000Z",
        type: "response_item",
        payload: {
          type: "tool_search_call",
          id: "ts-call-1",
          status: "completed",
          arguments: JSON.stringify({
            query: "tool search normalization fixture",
          }),
          execution: {
            duration_ms: 37,
            status: "completed",
          },
          tools: [
            {
              description: "Searches deferred tool metadata",
              name: "tool_search_tool",
            },
          ],
          metadata: { turn_id: "turn-1" },
        },
      },
      {
        timestamp: "2026-06-22T14:00:11.000Z",
        type: "response_item",
        payload: {
          type: "tool_search_output",
          call_id: "ts-call-1",
          status: "completed",
          execution: {
            status: "completed",
          },
          tools: [
            {
              name: "functions.exec_command",
              recipient_name: "functions.exec_command",
            },
          ],
          output: {
            matches: [
              {
                name: "functions.exec_command",
                text: "Runs a command in a PTY",
              },
            ],
          },
        },
      },
    ]);

    const normalized = normalizeCodexTranscript({
      contentType: "jsonl",
      rawContent,
    });
    expect(normalized?.turns[5]?.searchText).toContain("Structured array output needle");
    expect(normalized?.turns[5]?.searchText).toContain("codex-output.png");
    expect(normalized?.turns[6]?.searchText).toContain("SGA-121 Codex web_search_call fixture");
    expect(normalized?.turns[7]?.searchText).toContain("tool search normalization fixture");
    expect(normalized?.turns[7]?.searchText).toContain("tool_search_tool");
    expect(normalized?.turns[8]?.searchText).toContain("functions.exec_command");
    expect(normalized?.turns[8]?.searchText).toContain("Runs a command in a PTY");

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
    expect(result.session).toMatchObject({
      lastActivityAt: new Date("2026-06-22T14:00:11.000Z"),
      model: "gpt-5-codex",
      startedAt: new Date("2026-06-22T14:00:03.000Z"),
    });
    expect(result.session.metadata).toMatchObject({
      cliVersion: "0.42.0-test",
      cwd: "/work/saga",
      detectedHarnessSessionId: "codex-transcript-session-1",
      normalizer: "codex-transcript-v1",
      turnCount: 9,
    });
    expect(result.activityInterval.startedAt).toEqual(new Date("2026-06-22T14:00:03.000Z"));
    expect(result.activityInterval.metadata).toMatchObject({
      cwd: "/work/saga",
      normalizer: "codex-transcript-v1",
      parseErrors: [],
    });

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
          agent_role: "subagent",
          parent_thread_id: "parent-thread-1",
          source_subagent_thread_spawn: {
            parent_turn_id: "parent-turn-1",
          },
          sourceRecordType: "session_meta",
          thread_source: "subagent",
        },
      ],
      turnCount: 9,
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
            agent_role: "subagent",
            parent_thread_id: "parent-thread-1",
            sourceRecordType: "session_meta",
            thread_source: "subagent",
          },
        ],
        turnCount: 9,
      },
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(turns.map((turn) => turn.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
    ]);
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
        name: "apply_patch",
        callId: "call-1",
        input: "*** Begin Patch\n*** Add File: note.md\n+tests passed\n*** End Patch\n",
        status: "completed",
      },
    ]);
    expect(turns[3]?.contentParts).toEqual([
      {
        type: "tool_result",
        name: "apply_patch",
        callId: "call-1",
        output: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated files\n",
      },
    ]);
    expect(turns[4]?.contentParts).toEqual([
      {
        type: "tool_call",
        name: "web.run",
        callId: "call-2",
        arguments: { open: [{ ref_id: "turn0search0" }] },
        status: "completed",
      },
    ]);
    expect(turns[5]?.contentParts).toEqual([
      {
        type: "tool_result",
        name: "web.run",
        callId: "call-2",
        output: [
          { type: "text", text: "Structured array output needle" },
          { type: "image", image_url: "file:///tmp/codex-output.png" },
        ],
      },
    ]);
    expect(turns[6]?.contentParts).toEqual([
      {
        type: "tool_call",
        name: "web_search",
        callId: "ws-call-1",
        status: "completed",
        action: {
          type: "search",
          query: "SGA-121 Codex web_search_call fixture",
        },
      },
    ]);
    expect(turns[6]?.metadata).toMatchObject({
      sourcePayloadType: "web_search_call",
      sourceRecordType: "response_item",
    });
    expect(turns[7]?.contentParts).toEqual([
      {
        type: "tool_call",
        name: "tool_search",
        callId: "ts-call-1",
        arguments: {
          query: "tool search normalization fixture",
        },
        execution: {
          duration_ms: 37,
          status: "completed",
        },
        status: "completed",
        tools: [
          {
            description: "Searches deferred tool metadata",
            name: "tool_search_tool",
          },
        ],
      },
    ]);
    expect(turns[7]?.metadata).toMatchObject({
      sourcePayloadType: "tool_search_call",
      sourceRecordType: "response_item",
    });
    expect(turns[8]?.contentParts).toEqual([
      {
        type: "tool_result",
        name: "tool_search",
        callId: "ts-call-1",
        output: {
          matches: [
            {
              name: "functions.exec_command",
              text: "Runs a command in a PTY",
            },
          ],
        },
        execution: {
          status: "completed",
        },
        status: "completed",
        tools: [
          {
            name: "functions.exec_command",
            recipient_name: "functions.exec_command",
          },
        ],
      },
    ]);
    expect(turns[8]?.metadata).toMatchObject({
      sourcePayloadType: "tool_search_output",
      sourceRecordType: "response_item",
    });

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(segments).toHaveLength(6);
    expect(segments.map((segment) => segment.segmentKind)).toEqual([
      "turn",
      "turn",
      "tool_group",
      "tool_group",
      "turn",
      "tool_group",
    ]);
    expect(segments[2]?.searchText).toContain("apply_patch");
    expect(segments[2]?.searchText).toContain("Success. Updated files");
    expect(segments[3]?.searchText).toContain("web.run");
    expect(segments[3]?.searchText).toContain("Structured array output needle");
    expect(segments[5]?.searchText).toContain("tool_search");
    expect(segments[5]?.searchText).toContain("Runs a command in a PTY");
    expect(segments[2]?.metadata).toMatchObject({
      contentPartTypes: ["tool_call", "tool_result"],
      groupedTurnIds: [turns[2]?.id, turns[3]?.id],
      normalizer: "session-segments-v1",
      role: "tool",
    });
  });

  test("normalizes Claude transcript JSONL into session metadata, turns, parts, and spans", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("claude-normalize");
    const rawContent = claudeTranscript([
      {
        type: "mode",
        mode: "default",
        sessionId: "claude-transcript-session-1",
      },
      {
        parentUuid: null,
        isSidechain: false,
        promptId: "prompt-1",
        type: "user",
        message: {
          role: "user",
          content: "Normalize Claude transcripts.",
        },
        uuid: "user-1",
        timestamp: "2026-06-22T16:00:00.000Z",
        userType: "external",
        entrypoint: "cli",
        cwd: "/work/saga",
        sessionId: "claude-transcript-session-1",
        version: "2.1.160",
        gitBranch: "main",
      },
      {
        parentUuid: "user-1",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-5",
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "I will parse Claude JSONL." }],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 10,
            output_tokens: 7,
          },
        },
        requestId: "req-1",
        type: "assistant",
        uuid: "assistant-1",
        timestamp: "2026-06-22T16:00:01.000Z",
        userType: "external",
        entrypoint: "cli",
        cwd: "/work/saga",
        sessionId: "claude-transcript-session-1",
        version: "2.1.160",
        gitBranch: "main",
      },
      {
        parentUuid: "assistant-1",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-5",
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-bash-1",
              name: "Bash",
              attributionMcpServer: "claude-bash-mcp",
              attributionMcpTool: "run_command",
              input: {
                command: "pnpm test -- --run",
              },
              toolUseID: "legacy-toolu-bash-1",
            },
          ],
          stop_reason: "tool_use",
        },
        requestId: "req-1",
        type: "assistant",
        uuid: "assistant-2",
        timestamp: "2026-06-22T16:00:02.000Z",
        userType: "external",
        entrypoint: "cli",
        cwd: "/work/saga",
        sessionId: "claude-transcript-session-1",
        version: "2.1.160",
        gitBranch: "main",
      },
      {
        parentUuid: "assistant-2",
        isSidechain: false,
        promptId: "prompt-2",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-bash-1",
              attributionMcpServer: "claude-bash-mcp",
              attributionMcpTool: "run_command",
              content: "tests passed",
              is_error: false,
              toolUseID: "legacy-toolu-bash-1",
              toolUseResult: {
                outputBytes: 12,
              },
            },
          ],
        },
        uuid: "tool-result-1",
        timestamp: "2026-06-22T16:00:03.000Z",
        toolUseResult: {
          success: true,
        },
        sourceToolAssistantUUID: "assistant-2",
        userType: "external",
        entrypoint: "cli",
        cwd: "/work/saga",
        sessionId: "claude-transcript-session-1",
        version: "2.1.160",
        gitBranch: "main",
      },
      {
        parentUuid: "tool-result-1",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-5",
          id: "msg-2",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-agent-1",
              name: "Agent",
              caller: "agent-caller-1",
              input: {
                description: "Inspect related code",
                prompt: "Summarize the importer extension point.",
              },
            },
          ],
          stop_reason: "tool_use",
        },
        requestId: "req-2",
        type: "assistant",
        uuid: "assistant-agent-1",
        timestamp: "2026-06-22T16:00:04.000Z",
        userType: "external",
        entrypoint: "cli",
        cwd: "/work/saga",
        sessionId: "claude-transcript-session-1",
        version: "2.1.160",
        gitBranch: "main",
      },
      {
        type: "ai-title",
        aiTitle: "Claude normalization fixture",
        sessionId: "claude-transcript-session-1",
      },
    ]);

    const normalized = normalizeClaudeTranscript({
      contentType: "jsonl",
      rawContent,
      sourceLocator: "/tmp/claude-transcript-session-1.jsonl",
    });
    expect(normalized?.turns.map((turn) => turn.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "subagent",
    ]);
    expect(normalized?.turns[2]?.searchText).toContain("pnpm test");
    expect(normalized?.turns[3]?.searchText).toContain("tests passed");

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          displayName: "Drew",
          handle: "drew",
        },
        capturedAt: "2026-06-22T16:00:05.000Z",
        contentType: "jsonl",
        harness: "claude",
        host: {
          id: "host-claude-normalize",
          label: "local-host",
          projectRoot: "/work/saga",
        },
        locator: "/tmp/claude-transcript-session-1.jsonl",
        rawContent,
        workspaceId,
      }),
    );

    expect(result.operation).toBe("inserted");
    expect(result.session.harnessSessionId).toBe("claude-transcript-session-1");
    expect(result.session).toMatchObject({
      lastActivityAt: new Date("2026-06-22T16:00:04.000Z"),
      model: "claude-sonnet-4-5",
      startedAt: new Date("2026-06-22T16:00:00.000Z"),
      title: "Claude normalization fixture",
    });
    expect(result.session.metadata).toMatchObject({
      cwd: "/work/saga",
      detectedHarnessSessionId: "claude-transcript-session-1",
      normalizer: "claude-transcript-v1",
      turnCount: 5,
      version: "2.1.160",
    });
    expect(result.session.metadata).toMatchObject({
      subagentEvidence: [
        {
          sourceRecordType: "assistant",
          toolUseId: "toolu-agent-1",
          toolInput: {
            description: "Inspect related code",
            prompt: "Summarize the importer extension point.",
          },
        },
      ],
    });
    expect(result.activityInterval.startedAt).toEqual(new Date("2026-06-22T16:00:00.000Z"));
    expect(result.activityInterval.metadata).toMatchObject({
      cwd: "/work/saga",
      lifecycleEvents: [
        {
          mode: "default",
          type: "mode",
        },
        {
          aiTitle: "Claude normalization fixture",
          type: "ai-title",
        },
      ],
      normalizer: "claude-transcript-v1",
      parseErrors: [],
    });

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        cwd: "/work/saga",
        detectedHarnessSessionId: "claude-transcript-session-1",
        normalizer: "claude-transcript-v1",
        turnCount: 5,
      },
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(turns.map((turn) => turn.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "subagent",
    ]);
    expect(turns[0]).toMatchObject({
      actorKind: "host_user",
      harnessTurnId: "user-1:user",
      rawSpan: {
        lineStart: 1,
        lineEnd: 1,
      },
    });
    expect(turns[0]?.metadata).toMatchObject({
      cwd: "/work/saga",
      normalizer: "claude-transcript-v1",
      promptId: "prompt-1",
      sessionId: "claude-transcript-session-1",
      uuid: "user-1",
    });
    expect(turns[0]?.contentParts).toEqual([
      { type: "text", text: "Normalize Claude transcripts." },
    ]);
    expect(turns[2]?.contentParts).toEqual([
      {
        type: "tool_call",
        name: "Bash",
        callId: "toolu-bash-1",
        attributionMcpServer: "claude-bash-mcp",
        attributionMcpTool: "run_command",
        input: {
          command: "pnpm test -- --run",
        },
        toolUseID: "legacy-toolu-bash-1",
      },
    ]);
    expect(turns[3]).toMatchObject({
      actorKind: "tool",
      actorLabel: "Bash",
      harnessTurnId: "toolu-bash-1:result",
    });
    expect(turns[3]?.contentParts).toEqual([
      {
        type: "tool_result",
        name: "Bash",
        callId: "toolu-bash-1",
        attributionMcpServer: "claude-bash-mcp",
        attributionMcpTool: "run_command",
        isError: false,
        output: "tests passed",
        toolUseID: "legacy-toolu-bash-1",
        toolUseResult: {
          outputBytes: 12,
        },
      },
    ]);
    expect(turns[3]?.metadata).toMatchObject({
      toolUseResult: {
        success: true,
      },
    });
    expect(turns[4]).toMatchObject({
      actorKind: "subagent",
      actorLabel: "Agent",
      harnessTurnId: "toolu-agent-1",
    });
    expect(turns[4]?.contentParts).toEqual([
      {
        type: "tool_call",
        name: "Agent",
        callId: "toolu-agent-1",
        caller: "agent-caller-1",
        input: {
          description: "Inspect related code",
          prompt: "Summarize the importer extension point.",
        },
      },
    ]);

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(segments).toHaveLength(4);
    expect(segments.map((segment) => segment.segmentKind)).toEqual([
      "turn",
      "turn",
      "tool_group",
      "turn",
    ]);
    expect(segments[2]?.searchText).toContain("Bash");
    expect(segments[2]?.searchText).toContain("pnpm test -- --run");
    expect(segments[2]?.searchText).toContain("tests passed");
  });

  test("splits large turns into overlapping positioned lexical segments", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("segment-large-turn");
    const longText = Array.from({ length: 2500 }, (_, index) => `token${index}`).join(" ");
    const rawContent = codexTranscript([
      {
        timestamp: "2026-06-22T18:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "codex-large-segment-session",
        },
      },
      {
        timestamp: "2026-06-22T18:00:01.000Z",
        type: "turn_context",
        payload: {
          model: "gpt-5-codex",
          turn_id: "turn-large",
        },
      },
      {
        timestamp: "2026-06-22T18:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: longText }],
          metadata: { turn_id: "turn-large" },
        },
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: "drew",
        },
        capturedAt: "2026-06-22T18:00:03.000Z",
        contentType: "jsonl",
        harness: "codex",
        host: {
          id: "host-large-segment",
        },
        locator: "/tmp/codex-large-segment.jsonl",
        rawContent,
        workspaceId,
      }),
    );

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(segments).toHaveLength(3);
    expect(segments.every((segment) => segment.segmentKind === "turn_chunk")).toBe(true);
    expect(segments.map((segment) => [segment.tokenStart, segment.tokenEnd])).toEqual([
      [0, 917],
      [792, 1709],
      [1584, 2500],
    ]);
    expect((segments[0]?.tokenEnd ?? 0) - (segments[1]?.tokenStart ?? 0)).toBe(125);
    expect((segments[1]?.tokenEnd ?? 0) - (segments[2]?.tokenStart ?? 0)).toBe(125);
    expect(segments[0]?.searchText).toContain("token0");
    expect(segments[1]?.searchText).toContain("token792");
    expect(segments[2]?.searchText).toContain("token2499");
    expect(segments[0]?.metadata).toMatchObject({
      chunkCount: 3,
      chunkIndex: 0,
      normalizer: "session-segments-v1",
      sourceRawSpans: [
        {
          lineStart: 2,
          lineEnd: 2,
        },
      ],
    });
  });

  test("filters low-signal and high-risk content from lexical segments", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("segment-filter");
    const hugeLog = Array.from(
      { length: 850 },
      (_, index) =>
        `2026-06-22T18:10:${String(index % 60).padStart(2, "0")}Z noisy log line ${index}`,
    ).join("\n");
    const base64Blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(30);
    const unboundedDiff = Array.from({ length: 260 }, (_, index) =>
      index % 2 === 0 ? `+added generated line ${index}` : `-removed generated line ${index}`,
    ).join("\n");
    const repeatedGenerated = [
      "// generated file - do not edit",
      ...Array.from({ length: 700 }, () => "export const routeTree = routeTree;"),
    ].join("\n");
    const rawContent = codexTranscript([
      {
        timestamp: "2026-06-22T18:10:00.000Z",
        type: "session_meta",
        payload: {
          id: "codex-filter-session",
        },
      },
      {
        timestamp: "2026-06-22T18:10:01.000Z",
        type: "turn_context",
        payload: {
          model: "gpt-5-codex",
          turn_id: "turn-filter",
        },
      },
      {
        timestamp: "2026-06-22T18:10:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Remember safe searchable context." }],
          metadata: { turn_id: "turn-filter" },
        },
      },
      {
        timestamp: "2026-06-22T18:10:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          status: "completed",
          call_id: "call-log",
          name: "shell",
          arguments: JSON.stringify({ command: "cat build.log" }),
          metadata: { turn_id: "turn-filter" },
        },
      },
      {
        timestamp: "2026-06-22T18:10:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-log",
          output: hugeLog,
        },
      },
      {
        timestamp: "2026-06-22T18:10:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "api_key=sk-supersecretfixturevalue123456789" }],
          metadata: { turn_id: "turn-filter" },
        },
      },
      {
        timestamp: "2026-06-22T18:10:06.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: base64Blob }],
          metadata: { turn_id: "turn-filter" },
        },
      },
      {
        timestamp: "2026-06-22T18:10:07.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "diff-message",
          content: [{ type: "output_text", text: unboundedDiff }],
          metadata: { turn_id: "turn-filter" },
        },
      },
      {
        timestamp: "2026-06-22T18:10:08.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "generated-message",
          content: [{ type: "output_text", text: repeatedGenerated }],
          metadata: { turn_id: "turn-filter" },
        },
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: "drew",
        },
        capturedAt: "2026-06-22T18:10:09.000Z",
        contentType: "jsonl",
        harness: "codex",
        host: {
          id: "host-filter-segment",
        },
        locator: "/tmp/codex-filter-segment.jsonl",
        rawContent,
        workspaceId,
      }),
    );

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.searchText)).toEqual([
      "Remember safe searchable context.",
      'shell {"command":"cat build.log"} completed',
    ]);
    expect(segments.map((segment) => segment.searchText).join("\n")).not.toContain(
      "supersecretfixture",
    );
    expect(segments.map((segment) => segment.searchText).join("\n")).not.toContain(base64Blob);
    expect(segments.map((segment) => segment.searchText).join("\n")).not.toContain(
      "added generated line",
    );
    expect(segments.map((segment) => segment.searchText).join("\n")).not.toContain("routeTree");
    expect(segments[1]?.metadata).toMatchObject({
      filters: [
        {
          reason: "huge_raw_log",
          type: "tool_result",
        },
      ],
      skippedPartCount: 1,
    });
  });

  test("imports Claude sidechain subagent transcripts as separate sessions from an explicit parent id", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("claude-sidechain");
    const parentRawContent = claudeTranscript([
      {
        parentUuid: null,
        isSidechain: false,
        promptId: "parent-prompt",
        type: "user",
        message: {
          role: "user",
          content: "Delegate a focused inspection.",
        },
        uuid: "parent-user",
        timestamp: "2026-06-22T17:00:00.000Z",
        cwd: "/work/saga",
        sessionId: "claude-parent-session",
      },
      {
        parentUuid: "parent-user",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-5",
          id: "parent-msg",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-agent-parent",
              name: "Agent",
              input: {
                description: "Inspect importer",
                prompt: "Check subagent identity.",
              },
            },
          ],
        },
        type: "assistant",
        uuid: "parent-assistant",
        timestamp: "2026-06-22T17:00:01.000Z",
        cwd: "/work/saga",
        sessionId: "claude-parent-session",
      },
    ]);
    const subagentRawContent = claudeTranscript([
      {
        parentUuid: null,
        isSidechain: true,
        agentId: "agent-1",
        promptId: "subagent-prompt",
        type: "user",
        message: {
          role: "user",
          content: "Inspect the importer.",
        },
        uuid: "subagent-user",
        timestamp: "2026-06-22T17:00:02.000Z",
        cwd: "/work/saga",
        sessionId: "claude-parent-session",
        sourceToolAssistantUUID: "parent-assistant",
        sourceToolUseID: "toolu-agent-parent",
      },
      {
        parentUuid: "subagent-user",
        isSidechain: true,
        agentId: "agent-1",
        message: {
          model: "claude-sonnet-4-5",
          id: "subagent-msg",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "The importer currently collapses sessions." }],
        },
        type: "assistant",
        uuid: "subagent-assistant",
        timestamp: "2026-06-22T17:00:03.000Z",
        cwd: "/work/saga",
        sessionId: "claude-parent-session",
        sourceToolAssistantUUID: "parent-assistant",
        sourceToolUseID: "toolu-agent-parent",
      },
    ]);

    const parent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: "drew",
        },
        capturedAt: "2026-06-22T17:00:04.000Z",
        contentType: "jsonl",
        harness: "claude",
        harnessSessionId: "claude-parent-session",
        host: {
          id: "host-claude-sidechain",
        },
        locator: "/tmp/claude-parent-session.jsonl",
        rawContent: parentRawContent,
        workspaceId,
      }),
    );
    const subagent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: "drew",
        },
        capturedAt: "2026-06-22T17:00:05.000Z",
        contentType: "jsonl",
        harness: "claude",
        harnessSessionId: "claude-parent-session",
        host: {
          id: "host-claude-sidechain",
        },
        locator: "/tmp/claude-parent-session/subagents/agent-1.jsonl",
        rawContent: subagentRawContent,
        workspaceId,
      }),
    );

    expect(parent.session.id).not.toBe(subagent.session.id);
    expect(parent.session.harnessSessionId).toBe("claude-parent-session");
    expect(subagent.session.harnessSessionId).toBe("claude-parent-session:subagent:agent-1");
    expect(subagent.rawSessionRecord.harnessSessionId).toBe(
      "claude-parent-session:subagent:agent-1",
    );
    expect(subagent.session.metadata).toMatchObject({
      detectedHarnessSessionId: "claude-parent-session:subagent:agent-1",
      parentHarnessSessionId: "claude-parent-session",
    });
    expect(subagent.session.metadata.subagentEvidence).toEqual(
      expect.arrayContaining([
        {
          sourceLocatorKind: "claude-subagent-transcript",
          sourceLocator: "/tmp/claude-parent-session/subagents/agent-1.jsonl",
        },
        expect.objectContaining({
          agentId: "agent-1",
          isSidechain: true,
          sourceToolUseID: "toolu-agent-parent",
        }),
      ]),
    );

    const workspaceSessions = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));
    expect(workspaceSessions).toHaveLength(2);

    const workspaceRecords = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.workspaceId, workspaceId));
    expect(workspaceRecords).toHaveLength(2);

    const parentTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, parent.session.id))
      .orderBy(asc(sessionTurns.ordinal));
    const subagentTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, subagent.session.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(parentTurns.map((turn) => turn.role)).toEqual(["user", "subagent"]);
    expect(subagentTurns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(subagentTurns[0]?.metadata).toMatchObject({
      agentId: "agent-1",
      isSidechain: true,
      sessionId: "claude-parent-session",
      sourceToolUseID: "toolu-agent-parent",
    });
  });

  test("preserves Claude lifecycle payloads without creating turns", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("claude-lifecycle");
    const rawContent = claudeTranscript([
      {
        type: "system",
        subtype: "stop-hook-summary",
        hookSummaries: [{ hook: "Stop", status: "success" }],
        sessionId: "claude-lifecycle-session",
      },
      {
        type: "worktree-state",
        branch: "sga-122-claude-normalization",
        changedFiles: ["packages/db/src/claude-transcript-normalizer.ts"],
        sessionId: "claude-lifecycle-session",
      },
      {
        type: "pr-link",
        number: 12,
        url: "https://example.invalid/pr/12",
        title: "Normalize Claude transcripts",
        sessionId: "claude-lifecycle-session",
      },
      {
        type: "attachment",
        attachment: {
          fileName: "review.txt",
          mediaType: "text/plain",
        },
        lastPrompt: "Review this blocker.",
        sessionId: "claude-lifecycle-session",
      },
      {
        type: "file-history-snapshot",
        files: [{ path: "packages/db/src/raw-session-import.ts", status: "modified" }],
        sessionId: "claude-lifecycle-session",
      },
      {
        type: "queue-operation",
        operation: "enqueue",
        queue: [{ id: "SGA-135", title: "Derive subagent relationships" }],
        sessionId: "claude-lifecycle-session",
      },
      {
        parentUuid: null,
        isSidechain: false,
        promptId: "lifecycle-prompt",
        type: "user",
        message: {
          role: "user",
          content: "Keep the actual prompt as the only turn.",
        },
        uuid: "lifecycle-user",
        timestamp: "2026-06-22T17:10:00.000Z",
        cwd: "/work/saga",
        sessionId: "claude-lifecycle-session",
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: "drew",
        },
        capturedAt: "2026-06-22T17:10:01.000Z",
        contentType: "jsonl",
        harness: "claude",
        host: {
          id: "host-claude-lifecycle",
        },
        locator: "/tmp/claude-lifecycle-session.jsonl",
        rawContent,
        workspaceId,
      }),
    );

    expect(result.activityInterval.metadata).toMatchObject({
      lifecycleEvents: [
        {
          type: "system",
          subtype: "stop-hook-summary",
          hookSummaries: [{ hook: "Stop", status: "success" }],
        },
        {
          type: "worktree-state",
          branch: "sga-122-claude-normalization",
          changedFiles: ["packages/db/src/claude-transcript-normalizer.ts"],
        },
        {
          type: "pr-link",
          number: 12,
          url: "https://example.invalid/pr/12",
        },
        {
          type: "attachment",
          attachment: {
            fileName: "review.txt",
          },
          lastPrompt: "Review this blocker.",
        },
        {
          type: "file-history-snapshot",
          files: [{ path: "packages/db/src/raw-session-import.ts", status: "modified" }],
        },
        {
          type: "queue-operation",
          queue: [{ id: "SGA-135", title: "Derive subagent relationships" }],
        },
      ],
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("user");

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        lifecycleEvents: [
          {
            type: "system",
            hookSummaries: [{ hook: "Stop", status: "success" }],
          },
          {
            type: "worktree-state",
            changedFiles: ["packages/db/src/claude-transcript-normalizer.ts"],
          },
          {
            type: "pr-link",
            url: "https://example.invalid/pr/12",
          },
          {
            type: "attachment",
            lastPrompt: "Review this blocker.",
          },
          {
            type: "file-history-snapshot",
            files: [{ path: "packages/db/src/raw-session-import.ts", status: "modified" }],
          },
          {
            type: "queue-operation",
            queue: [{ id: "SGA-135", title: "Derive subagent relationships" }],
          },
        ],
        turnCount: 1,
      },
    });
  });

  test("preserves per-record Claude cwd on turn metadata", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("claude-cwd");
    const rawContent = claudeTranscript([
      {
        parentUuid: null,
        isSidechain: false,
        promptId: "cwd-prompt-1",
        type: "user",
        message: {
          role: "user",
          content: "Start in the repo root.",
        },
        uuid: "cwd-user-1",
        timestamp: "2026-06-22T17:20:00.000Z",
        cwd: "/work/saga",
        sessionId: "claude-cwd-session",
      },
      {
        parentUuid: "cwd-user-1",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-5",
          id: "cwd-msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Now I am in packages/db." }],
        },
        type: "assistant",
        uuid: "cwd-assistant-1",
        timestamp: "2026-06-22T17:20:01.000Z",
        cwd: "/work/saga/packages/db",
        sessionId: "claude-cwd-session",
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: "drew",
        },
        capturedAt: "2026-06-22T17:20:02.000Z",
        contentType: "jsonl",
        harness: "claude",
        host: {
          id: "host-claude-cwd",
        },
        locator: "/tmp/claude-cwd-session.jsonl",
        rawContent,
        workspaceId,
      }),
    );

    expect(result.session.metadata).toMatchObject({
      cwd: "/work/saga/packages/db",
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(turns.map((turn) => turn.metadata.cwd)).toEqual([
      "/work/saga",
      "/work/saga/packages/db",
    ]);
  });

  test("unchanged Claude reimport preserves current session turn ids", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("claude-unchanged-turn-ids");
    const rawContent = claudeTranscript([
      {
        parentUuid: null,
        isSidechain: false,
        promptId: "prompt-unchanged",
        type: "user",
        message: {
          role: "user",
          content: "Keep Claude turn ids stable.",
        },
        uuid: "claude-unchanged-user",
        timestamp: "2026-06-22T16:10:00.000Z",
        userType: "external",
        entrypoint: "cli",
        cwd: "/work/saga",
        sessionId: "claude-unchanged-session",
        version: "2.1.160",
        gitBranch: "main",
      },
      {
        parentUuid: "claude-unchanged-user",
        isSidechain: false,
        message: {
          model: "claude-sonnet-4-5",
          id: "msg-unchanged",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Stable." }],
        },
        requestId: "req-unchanged",
        type: "assistant",
        uuid: "claude-unchanged-assistant",
        timestamp: "2026-06-22T16:10:01.000Z",
        userType: "external",
        entrypoint: "cli",
        cwd: "/work/saga",
        sessionId: "claude-unchanged-session",
        version: "2.1.160",
        gitBranch: "main",
      },
    ]);
    const input = {
      author: {
        handle: "drew",
      },
      capturedAt: "2026-06-22T16:10:02.000Z",
      contentType: "jsonl",
      harness: "claude",
      host: {
        id: "host-claude-unchanged-turn-ids",
      },
      locator: "/tmp/claude-unchanged-session.jsonl",
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const firstTurns = await service.db
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const firstSegments = await service.db
      .select({ id: sessionSegments.id })
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));
    const secondTurns = await service.db
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const secondSegments = await service.db
      .select({ id: sessionSegments.id })
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(second.operation).toBe("unchanged");
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(second.session.id).toBe(first.session.id);
    expect(secondTurns.map((turn) => turn.id)).toEqual(firstTurns.map((turn) => turn.id));
    expect(secondSegments.map((segment) => segment.id)).toEqual(
      firstSegments.map((segment) => segment.id),
    );
  });

  test("records invalid Codex JSONL parse errors in normalization metadata", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("codex-parse-errors");
    const rawContent = [
      JSON.stringify({
        timestamp: "2026-06-22T14:10:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/work/saga",
          id: "codex-parse-error-session",
        },
      }),
      '{"timestamp":"2026-06-22T14:10:01.000Z","type":"response_item","payload":',
      JSON.stringify({
        timestamp: "2026-06-22T14:10:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Keep valid records." }],
          metadata: { turn_id: "turn-parse" },
        },
      }),
      "",
    ].join("\n");

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: "drew",
        },
        capturedAt: "2026-06-22T14:10:03.000Z",
        contentType: "jsonl",
        harness: "codex",
        host: {
          id: "host-codex-parse-errors",
        },
        locator: "/tmp/codex-parse-error-session.jsonl",
        rawContent,
        workspaceId,
      }),
    );

    expect(result.activityInterval.metadata).toMatchObject({
      parseErrors: [
        {
          lineNumber: 1,
          rawLine: '{"timestamp":"2026-06-22T14:10:01.000Z","type":"response_item","payload":',
        },
      ],
    });
    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        parseErrors: [
          {
            lineNumber: 1,
          },
        ],
        turnCount: 1,
      },
    });
  });

  test("persists Codex parse errors and compacted lifecycle evidence without turns", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("codex-metadata-only");
    const rawContent = [
      JSON.stringify({
        timestamp: "2026-06-22T14:20:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/work/saga",
          id: "codex-metadata-only-session",
        },
      }),
      '{"timestamp":"2026-06-22T14:20:01.000Z","type":"response_item","payload":',
      JSON.stringify({
        timestamp: "2026-06-22T14:20:02.000Z",
        type: "compacted",
        payload: {
          source: "codex",
          turn_id: "turn-compacted",
        },
      }),
      "",
    ].join("\n");

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: "drew",
        },
        capturedAt: "2026-06-22T14:20:03.000Z",
        contentType: "jsonl",
        harness: "codex",
        host: {
          id: "host-codex-metadata-only",
        },
        locator: "/tmp/codex-metadata-only-session.jsonl",
        rawContent,
        workspaceId,
      }),
    );

    expect(result.activityInterval.metadata).toMatchObject({
      lifecycleEvents: [
        {
          payload: {
            source: "codex",
            turnId: "turn-compacted",
          },
          type: "compacted",
        },
      ],
      parseErrors: [
        {
          lineNumber: 1,
        },
      ],
    });
    expect(result.session.metadata).toMatchObject({
      lifecycleEventCount: 1,
      turnCount: 0,
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id));
    expect(turns).toHaveLength(0);

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        lifecycleEvents: [
          {
            type: "compacted",
          },
        ],
        parseErrors: [
          {
            lineNumber: 1,
          },
        ],
        turnCount: 0,
      },
    });
  });

  test("same-hash Codex reimport repairs derived rows with current normalization", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("codex-repair");
    const rawContent = codexTranscript([
      {
        timestamp: "2026-06-22T14:30:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/work/saga",
          id: "codex-repair-session",
        },
      },
      {
        timestamp: "2026-06-22T14:30:01.000Z",
        type: "turn_context",
        payload: {
          cwd: "/work/saga",
          model: "gpt-5-codex",
          turn_id: "turn-repair",
        },
      },
      {
        timestamp: "2026-06-22T14:30:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          status: "completed",
          call_id: "call-repair",
          name: "web.run",
          arguments: "{}",
          metadata: { turn_id: "turn-repair" },
        },
      },
      {
        timestamp: "2026-06-22T14:30:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-repair",
          output: [
            { type: "text", text: "Repaired structured output" },
            { type: "image", image_url: "file:///tmp/repaired.png" },
          ],
        },
      },
    ]);
    const input = {
      author: {
        handle: "drew",
      },
      capturedAt: "2026-06-22T14:30:04.000Z",
      contentType: "jsonl",
      harness: "codex",
      host: {
        id: "host-codex-repair",
      },
      locator: "/tmp/codex-repair-session.jsonl",
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const initialTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const toolResultTurn = initialTurns.find((turn) =>
      Array.isArray(turn.contentParts)
        ? turn.contentParts.some(
            (part) =>
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "tool_result",
          )
        : false,
    );
    if (toolResultTurn === undefined) throw new Error("tool result turn was not normalized");

    await service.db
      .update(sessionTurns)
      .set({
        contentParts: [{ type: "tool_result", name: "web.run", callId: "call-repair" }],
      })
      .where(eq(sessionTurns.id, toolResultTurn.id));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));

    expect(second.operation).toBe("unchanged");
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);

    const repairedTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(repairedTurns).toHaveLength(2);
    expect(repairedTurns[1]?.contentParts).toEqual([
      {
        type: "tool_result",
        name: "web.run",
        callId: "call-repair",
        output: [
          { type: "text", text: "Repaired structured output" },
          { type: "image", image_url: "file:///tmp/repaired.png" },
        ],
      },
    ]);
  });

  test("adopts legacy locator-scoped Codex session on later session_meta id detection", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("codex-legacy-locator");
    const rawContent = codexTranscript([
      {
        timestamp: "2026-06-22T14:40:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/work/saga",
          id: "codex-legacy-locator-session",
        },
      },
      {
        timestamp: "2026-06-22T14:40:01.000Z",
        type: "turn_context",
        payload: {
          cwd: "/work/saga",
          model: "gpt-5-codex",
          turn_id: "turn-legacy",
        },
      },
      {
        timestamp: "2026-06-22T14:40:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Adopt the legacy locator session." }],
          metadata: { turn_id: "turn-legacy" },
        },
      },
    ]);
    const input = {
      author: {
        handle: "drew",
      },
      capturedAt: "2026-06-22T14:40:02.000Z",
      contentType: "jsonl",
      harness: "codex",
      host: {
        id: "host-codex-legacy-locator",
      },
      locator: "/tmp/codex-legacy-locator.jsonl",
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));

    // Simulate a pre-normalizer import that was identifiable only by locator.
    await service.db
      .update(rawSessionRecords)
      .set({
        harnessSessionId: null,
        metadata: {
          contentBytes: Buffer.byteLength(input.rawContent, "utf8"),
          legacyImporter: true,
        },
      })
      .where(eq(rawSessionRecords.id, first.rawSessionRecord.id));
    await service.db
      .update(sessions)
      .set({
        harnessSessionId: null,
        lastActivityAt: new Date("2026-06-22T14:40:03.000Z"),
        metadata: {
          legacyImporter: true,
        },
        model: "legacy-model",
        startedAt: new Date("2026-06-22T14:40:03.000Z"),
      })
      .where(eq(sessions.id, first.session.id));
    await service.db
      .update(activityIntervals)
      .set({
        metadata: {
          importBoundary: "raw_session",
          legacyImporter: true,
        },
        startedAt: new Date("2026-06-22T14:40:03.000Z"),
      })
      .where(eq(activityIntervals.id, first.activityInterval.id));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));

    expect(second.operation).toBe("unchanged");
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.harnessSessionId).toBe("codex-legacy-locator-session");
    expect(second.session).toMatchObject({
      lastActivityAt: new Date("2026-06-22T14:40:02.000Z"),
      model: "gpt-5-codex",
      startedAt: new Date("2026-06-22T14:40:02.000Z"),
    });
    expect(second.session.metadata).toMatchObject({
      cwd: "/work/saga",
      detectedHarnessSessionId: "codex-legacy-locator-session",
      normalizer: "codex-transcript-v1",
      turnCount: 1,
    });
    expect(second.activityInterval.startedAt).toEqual(new Date("2026-06-22T14:40:02.000Z"));
    expect(second.activityInterval.metadata).toMatchObject({
      cwd: "/work/saga",
      normalizer: "codex-transcript-v1",
      turnContexts: [
        {
          model: "gpt-5-codex",
          turn_id: "turn-legacy",
        },
      ],
    });
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);

    const workspaceSessions = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));
    expect(workspaceSessions).toHaveLength(1);
    expect(workspaceSessions[0]?.harnessSessionId).toBe("codex-legacy-locator-session");
    expect(workspaceSessions[0]?.metadata).toMatchObject({
      normalizer: "codex-transcript-v1",
      turnCount: 1,
    });

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id));
    expect(records).toHaveLength(1);
    expect(records[0]?.harnessSessionId).toBe("codex-legacy-locator-session");
    expect(records[0]?.metadata).toMatchObject({
      normalization: {
        normalizer: "codex-transcript-v1",
        turnCount: 1,
      },
    });
  });

  test("unchanged Codex reimport preserves current session turn ids", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const workspaceId = await createBoundWorkspace("codex-unchanged-turn-ids");
    const rawContent = codexTranscript([
      {
        timestamp: "2026-06-22T14:50:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/work/saga",
          id: "codex-unchanged-turn-ids-session",
        },
      },
      {
        timestamp: "2026-06-22T14:50:01.000Z",
        type: "turn_context",
        payload: {
          cwd: "/work/saga",
          model: "gpt-5-codex",
          turn_id: "turn-unchanged",
        },
      },
      {
        timestamp: "2026-06-22T14:50:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Keep my turn ids." }],
          metadata: { turn_id: "turn-unchanged" },
        },
      },
      {
        timestamp: "2026-06-22T14:50:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "assistant-unchanged",
          role: "assistant",
          content: [{ type: "output_text", text: "The turn ids should not churn." }],
          metadata: { turn_id: "turn-unchanged" },
        },
      },
    ]);
    const input = {
      author: {
        handle: "drew",
      },
      capturedAt: "2026-06-22T14:50:04.000Z",
      contentType: "jsonl",
      harness: "codex",
      host: {
        id: "host-codex-unchanged-turn-ids",
      },
      locator: "/tmp/codex-unchanged-turn-ids.jsonl",
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const firstTurns = await service.db
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const firstSegments = await service.db
      .select({ id: sessionSegments.id })
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));
    const secondTurns = await service.db
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const secondSegments = await service.db
      .select({ id: sessionSegments.id })
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(second.operation).toBe("unchanged");
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(secondTurns.map((turn) => turn.id)).toEqual(firstTurns.map((turn) => turn.id));
    expect(secondSegments.map((segment) => segment.id)).toEqual(
      firstSegments.map((segment) => segment.id),
    );
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
    expect(activeSegments).toHaveLength(2);
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

function claudeTranscript(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
