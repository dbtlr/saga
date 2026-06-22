import { eq } from "drizzle-orm";
import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeDatabase, runMigrations, type DatabaseService } from "./database.js";
import {
  indexSessionSegmentEmbeddings,
  sessionSegmentEmbeddingInputHash,
  type SessionEmbeddingGenerator,
} from "./session-embeddings.js";
import {
  activityIntervals,
  rawSessionRecords,
  sessions,
  sessionSegmentEmbeddings,
  sessionSegments,
  sessionTurns,
  sourceBindings,
  users,
  workspaces,
} from "./schema.js";

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("session segment embeddings", () => {
  const databaseName = `saga_session_embeddings_${Date.now().toString(36)}`;
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

  test("indexes eligible active segments idempotently and refreshes stale embeddings", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const fixture = await seedEmbeddingFixture(service, "idempotent");
    const embeddedTexts: string[] = [];
    const generator = fakeGenerator(embeddedTexts);

    const first = await Effect.runPromise(
      indexSessionSegmentEmbeddings(service, {
        generator,
        now: new Date("2026-06-22T12:00:00.000Z"),
        workspaceId: fixture.workspaceId,
      }),
    );

    expect(first).toMatchObject({
      eligibleCount: 2,
      existingCount: 0,
      indexedCount: 2,
      skipped: {
        count: 0,
      },
      staleCount: 0,
      status: "completed",
    });
    expect(embeddedTexts).toEqual(["Alpha vector recall target", "Beta lexical fallback target"]);
    await expectEmbeddingRows(service, {
      count: 2,
      provider: generator.provider.id,
      workspaceId: fixture.workspaceId,
    });

    const second = await Effect.runPromise(
      indexSessionSegmentEmbeddings(service, {
        generator,
        now: new Date("2026-06-22T12:05:00.000Z"),
        workspaceId: fixture.workspaceId,
      }),
    );
    expect(second).toMatchObject({
      eligibleCount: 2,
      existingCount: 2,
      indexedCount: 0,
      staleCount: 0,
    });
    await expectEmbeddingRows(service, {
      count: 2,
      provider: generator.provider.id,
      workspaceId: fixture.workspaceId,
    });

    await service.db
      .update(sessionSegments)
      .set({ searchText: "Alpha vector recall target after edit" })
      .where(eq(sessionSegments.id, fixture.segmentIds.alpha));

    const third = await Effect.runPromise(
      indexSessionSegmentEmbeddings(service, {
        generator,
        now: new Date("2026-06-22T12:10:00.000Z"),
        workspaceId: fixture.workspaceId,
      }),
    );
    expect(third).toMatchObject({
      eligibleCount: 2,
      existingCount: 1,
      indexedCount: 1,
      staleCount: 1,
    });
    await expectEmbeddingRows(service, {
      count: 2,
      provider: generator.provider.id,
      workspaceId: fixture.workspaceId,
    });

    const [updated] = await service.db
      .select()
      .from(sessionSegmentEmbeddings)
      .where(eq(sessionSegmentEmbeddings.segmentId, fixture.segmentIds.alpha));
    expect(updated?.inputHash).toBe(
      sessionSegmentEmbeddingInputHash("Alpha vector recall target after edit", generator.provider),
    );
    expect(updated?.metadata).toMatchObject({
      indexedAt: "2026-06-22T12:10:00.000Z",
      inputHashVersion: 1,
      provider: {
        dimensions: 3,
        id: "openai",
        model: "deterministic-test-embedding",
      },
      status: "indexed",
    });
  });

  test("skips pending embeddings when default OpenAI credentials are unavailable", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const fixture = await seedEmbeddingFixture(service, "missing-credentials");

    const result = await Effect.runPromise(
      indexSessionSegmentEmbeddings(service, {
        authOptions: {
          env: {},
          homeDir: "/tmp/saga-test-missing-codex-home",
          readFile: () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
        },
        workspaceId: fixture.workspaceId,
      }),
    );

    expect(result).toMatchObject({
      eligibleCount: 2,
      indexedCount: 0,
      provider: {
        dimensions: 1536,
        id: "openai",
        model: "text-embedding-3-small",
      },
      skipped: {
        count: 2,
        reason: "missing-auth-file",
      },
      status: "skipped",
    });
    await expectEmbeddingRows(service, {
      count: 0,
      provider: "openai",
      workspaceId: fixture.workspaceId,
    });
  });
});

interface EmbeddingFixture {
  segmentIds: {
    alpha: string;
    beta: string;
  };
  workspaceId: string;
}

interface FixtureBundle {
  authorUserId: string;
  sourceBindingId: string;
  workspaceId: string;
}

function fakeGenerator(embeddedTexts: string[]): SessionEmbeddingGenerator {
  return {
    provider: {
      dimensions: 3,
      id: "openai",
      model: "deterministic-test-embedding",
    },
    embedSegments: async (inputs) => {
      embeddedTexts.push(...inputs.map((input) => input.text));
      return inputs.map((input) => ({
        embedding: [
          input.text.length / 100,
          input.text.toLowerCase().includes("alpha") ? 1 : 0,
          input.text.toLowerCase().includes("beta") ? 1 : 0,
        ],
        segmentId: input.segmentId,
      }));
    },
  };
}

async function seedEmbeddingFixture(
  service: DatabaseService,
  suffix: string,
): Promise<EmbeddingFixture> {
  const bundle = await createBundle(service, suffix, {
    enabled: true,
  });
  const active = await insertSessionWithSegments(service, bundle, {
    activeRawRecord: true,
    harnessSessionId: `${suffix}-active`,
    searchTexts: ["Alpha vector recall target", "Beta lexical fallback target", "   "],
  });

  const disabledBundle = await createBundle(service, `${suffix}-disabled`, {
    enabled: false,
    workspaceId: bundle.workspaceId,
  });
  await insertSessionWithSegments(service, disabledBundle, {
    activeRawRecord: true,
    harnessSessionId: `${suffix}-disabled`,
    searchTexts: ["Disabled source binding should not be embedded"],
  });

  await insertSessionWithSegments(service, bundle, {
    activeRawRecord: false,
    harnessSessionId: `${suffix}-inactive`,
    searchTexts: ["Inactive raw record should not be embedded"],
  });

  return {
    segmentIds: {
      alpha: active.segmentIds[0] ?? "",
      beta: active.segmentIds[1] ?? "",
    },
    workspaceId: bundle.workspaceId,
  };
}

async function createBundle(
  service: DatabaseService,
  suffix: string,
  input: {
    enabled: boolean;
    workspaceId?: string | undefined;
  },
): Promise<FixtureBundle> {
  const workspaceId =
    input.workspaceId ??
    (
      await service.db
        .insert(workspaces)
        .values({
          handle: `embedding-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        })
        .returning()
    )[0]?.id;
  if (workspaceId === undefined) throw new Error("workspace insert returned no row");

  const [sourceBinding] = await service.db
    .insert(sourceBindings)
    .values({
      config: {
        fixture: "session-embeddings",
      },
      displayName: `embedding ${suffix}`,
      enabled: input.enabled,
      sourceType: "codex",
      sourceUri: `codex://embedding/${suffix}`,
      workspaceId,
    })
    .returning();
  if (sourceBinding === undefined) throw new Error("source binding insert returned no row");

  const [author] = await service.db
    .insert(users)
    .values({
      displayName: "Drew",
      externalSubject: `host-${suffix}`,
      handle: `drew-${suffix}`,
      identitySource: "host",
      metadata: {
        fixture: "session-embeddings",
      },
      workspaceId,
    })
    .returning();
  if (author === undefined) throw new Error("user insert returned no row");

  return {
    authorUserId: author.id,
    sourceBindingId: sourceBinding.id,
    workspaceId,
  };
}

async function insertSessionWithSegments(
  service: DatabaseService,
  bundle: FixtureBundle,
  input: {
    activeRawRecord: boolean;
    harnessSessionId: string;
    searchTexts: string[];
  },
): Promise<{ segmentIds: string[] }> {
  const capturedAt = new Date("2026-06-22T11:00:00.000Z");
  const [session] = await service.db
    .insert(sessions)
    .values({
      authorUserId: bundle.authorUserId,
      harness: "codex",
      harnessSessionId: input.harnessSessionId,
      lastActivityAt: capturedAt,
      model: "gpt-5-codex",
      sourceBindingId: bundle.sourceBindingId,
      startedAt: capturedAt,
      status: "completed",
      title: input.harnessSessionId,
      workspaceId: bundle.workspaceId,
    })
    .returning();
  if (session === undefined) throw new Error("session insert returned no row");

  const [interval] = await service.db
    .insert(activityIntervals)
    .values({
      endedAt: new Date("2026-06-22T11:01:00.000Z"),
      ordinal: 0,
      sessionId: session.id,
      settledAt: new Date("2026-06-22T11:01:00.000Z"),
      settlementReason: "stop_event",
      startedAt: capturedAt,
      status: "settled",
      workspaceId: bundle.workspaceId,
    })
    .returning();
  if (interval === undefined) throw new Error("activity interval insert returned no row");

  const [rawRecord] = await service.db
    .insert(rawSessionRecords)
    .values({
      activityIntervalId: interval.id,
      authorUserId: bundle.authorUserId,
      bodyText: input.searchTexts.join("\n"),
      capturedAt,
      contentHash: `sha256:${input.harnessSessionId}`,
      contentType: "text",
      harness: "codex",
      harnessSessionId: input.harnessSessionId,
      isActive: input.activeRawRecord,
      sessionId: session.id,
      snapshotOrdinal: 0,
      sourceBindingId: bundle.sourceBindingId,
      sourceLocator: `/tmp/${input.harnessSessionId}.txt`,
      status: "captured",
      workspaceId: bundle.workspaceId,
    })
    .returning();
  if (rawRecord === undefined) throw new Error("raw record insert returned no row");

  const [turn] = await service.db
    .insert(sessionTurns)
    .values({
      activityIntervalId: interval.id,
      actorKind: "host_user",
      actorLabel: "Drew",
      contentParts: input.searchTexts.map((text) => ({ text, type: "text" })),
      harnessTurnId: `${input.harnessSessionId}-turn`,
      model: "gpt-5-codex",
      ordinal: 0,
      rawEventIds: [],
      rawSessionRecordId: rawRecord.id,
      role: "user",
      sessionId: session.id,
      workspaceId: bundle.workspaceId,
    })
    .returning();
  if (turn === undefined) throw new Error("turn insert returned no row");

  const segmentIds: string[] = [];
  for (const [ordinal, searchText] of input.searchTexts.entries()) {
    const [segment] = await service.db
      .insert(sessionSegments)
      .values({
        activityIntervalId: interval.id,
        ordinal,
        rawSessionRecordId: rawRecord.id,
        searchText,
        segmentKind: "turn",
        sessionId: session.id,
        snippet: searchText.trim() === "" ? null : searchText,
        turnId: turn.id,
        workspaceId: bundle.workspaceId,
      })
      .returning();
    if (segment === undefined) throw new Error("segment insert returned no row");
    segmentIds.push(segment.id);
  }

  return { segmentIds };
}

async function expectEmbeddingRows(
  service: DatabaseService,
  input: {
    count: number;
    provider: string;
    workspaceId: string;
  },
): Promise<void> {
  const rows = await service.sql<Array<{ count: string }>>`
    select count(*)::text as count
    from session_segment_embeddings
    where workspace_id = ${input.workspaceId}
      and provider = ${input.provider}
  `;
  expect(Number(rows[0]?.count ?? "0")).toBe(input.count);
}
