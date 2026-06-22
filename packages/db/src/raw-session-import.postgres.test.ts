import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeDatabase, runMigrations, type DatabaseService } from "./database.js";
import { importRawSessionRecord } from "./raw-session-import.js";
import {
  rawSessionRecords,
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
