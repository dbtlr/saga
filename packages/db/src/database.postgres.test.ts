import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import postgres from "postgres";
import {
  insertClaimEventAndProject,
  insertClaimMaintenanceEventAndProject,
  insertClaimPromotionEventAndProject,
  insertClaimReviewEventAndProject,
  insertExtractedCandidateClaim,
  listActiveContextClaims,
  listCurrentClaims,
} from "./claim.js";
import { makeDatabase, runMigrations, type DatabaseService } from "./database.js";
import { insertRawEvent, listRecentRawEvents } from "./raw-event.js";
import {
  listActiveContextIndexEntries,
  listContextIndexEntries,
  makeSagaContextLink,
  resolveSagaLink,
  upsertContextIndexEntry,
} from "./context-index.js";
import {
  claimEvents,
  contextIndexEntries,
  currentClaims,
  rawEvents,
  sourceBindings,
  workspaceProfiles,
  workspaces,
} from "./schema.js";

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("postgres integration", () => {
  const databaseName = `saga_test_${Date.now().toString(36)}`;
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

  async function createWorkspaceWithCodexSource(handlePrefix: string) {
    if (service === undefined) throw new Error("database service was not initialized");
    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `${handlePrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      })
      .returning();
    if (workspace === undefined) throw new Error("workspace insert returned no row");

    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        sourceType: "codex",
        sourceUri: "codex://local",
        workspaceId: workspace.id,
      })
      .returning();
    if (sourceBinding === undefined) throw new Error("source binding insert returned no row");
    return { sourceBinding, workspace };
  }

  async function insertCodexPromptEvent(input: {
    prompt: string;
    sourceBindingId: string;
    turn: string;
    workspaceId: string;
  }) {
    if (service === undefined) throw new Error("database service was not initialized");
    return Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: `codex:${input.workspaceId}:${input.turn}`,
        occurredAt: "2026-06-19T20:00:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: input.prompt,
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: input.sourceBindingId,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: input.turn,
        trustLevel: "raw",
        workspaceId: input.workspaceId,
      }),
    );
  }

  test("runs migrations and persists workspace registration rows", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        displayName: "Saga Integration Workspace",
        handle: `saga-${Date.now().toString(36)}`,
      })
      .returning();

    expect(workspace).toBeDefined();
    if (workspace === undefined) throw new Error("workspace insert returned no row");

    const [profile] = await service.db
      .insert(workspaceProfiles)
      .values({
        profile: { northstar: "integration test" },
        summary: "integration profile",
        workspaceId: workspace.id,
      })
      .returning();

    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        config: { branch: "main" },
        displayName: "Saga repository",
        sourceType: "git",
        sourceUri: "file:///Volumes/data/workspaces/saga",
        workspaceId: workspace.id,
      })
      .returning();

    expect(profile?.workspaceId).toBe(workspace.id);
    expect(sourceBinding?.workspaceId).toBe(workspace.id);
    expect(sourceBinding?.enabled).toBe(true);
  });

  test("persists Context Index entries and resolves Saga Links through source bindings", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const { sourceBinding, workspace } = await createWorkspaceWithCodexSource("context-index");

    const entry = await Effect.runPromise(
      upsertContextIndexEntry(service, {
        description: "Architecture seed note.",
        externalId: "notes/saga-v2-architecture-seed.md",
        importance: 0.9,
        includePolicy: "always",
        key: "architecture-seed",
        metadata: { section: "design-notes" },
        sourceBindingId: sourceBinding.id,
        title: "Architecture Seed",
        workspaceId: workspace.id,
      }),
    );

    expect(entry.sagaLink).toBe(makeSagaContextLink("architecture-seed"));

    const activeEntries = await Effect.runPromise(
      listActiveContextIndexEntries(service, {
        workspaceId: workspace.id,
      }),
    );
    expect(activeEntries).toHaveLength(1);
    expect(activeEntries[0]).toMatchObject({
      key: "architecture-seed",
      sourceBinding: {
        id: sourceBinding.id,
        sourceType: "codex",
        sourceUri: "codex://local",
      },
    });

    const resolved = await Effect.runPromise(
      resolveSagaLink(service, {
        sagaLink: entry.sagaLink,
        workspaceId: workspace.id,
      }),
    );
    expect(resolved).toMatchObject({
      entry: {
        externalId: "notes/saga-v2-architecture-seed.md",
        sourceBinding: {
          id: sourceBinding.id,
          sourceType: "codex",
        },
      },
      provenance: {
        sagaLink: entry.sagaLink,
        sourceBindingId: sourceBinding.id,
        workspaceId: workspace.id,
      },
    });

    await Effect.runPromise(
      upsertContextIndexEntry(service, {
        externalId: "notes/saga-v2-architecture-seed.md",
        includePolicy: "when_relevant",
        key: "architecture-seed",
        sourceBindingId: sourceBinding.id,
        title: "Updated Architecture Seed",
        workspaceId: workspace.id,
      }),
    );

    const allEntries = await Effect.runPromise(
      listContextIndexEntries(service, {
        includePolicies: ["always", "when_relevant"],
        workspaceId: workspace.id,
      }),
    );
    expect(allEntries).toHaveLength(1);
    expect(allEntries[0]).toMatchObject({
      includePolicy: "when_relevant",
      title: "Updated Architecture Seed",
    });

    const rows = await service.db
      .select()
      .from(contextIndexEntries)
      .where(eq(contextIndexEntries.workspaceId, workspace.id));
    expect(rows).toHaveLength(1);
  });

  test("rejects Context Index entries that reference another workspace source binding", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const first = await createWorkspaceWithCodexSource("context-index-first");
    const second = await createWorkspaceWithCodexSource("context-index-second");

    await expect(
      Effect.runPromise(
        upsertContextIndexEntry(service, {
          externalId: "notes/cross-workspace.md",
          key: "cross-workspace",
          sourceBindingId: first.sourceBinding.id,
          title: "Cross Workspace",
          workspaceId: second.workspace.id,
        }),
      ),
    ).rejects.toThrow("Context Index source binding must belong to the same workspace");
  });

  test("persists raw events", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        displayName: "Raw Event Workspace",
        handle: `raw-${Date.now().toString(36)}`,
      })
      .returning();
    if (workspace === undefined) throw new Error("workspace insert returned no row");

    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        sourceType: "codex",
        sourceUri: "codex://local",
        workspaceId: workspace.id,
      })
      .returning();
    if (sourceBinding === undefined) throw new Error("source binding insert returned no row");

    const event = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.Stop",
        externalEventId: "codex:Stop:session-id:turn-id:/tmp/transcript.jsonl:test",
        occurredAt: "2026-06-19T20:00:00.000Z",
        payload: { hook_event_name: "Stop" },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session-id",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn-id",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );

    const rows = await service.db.select().from(rawEvents);
    expect(event.eventType).toBe("codex.Stop");
    expect(rows.some((row) => row.id === event.id)).toBe(true);

    const duplicate = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.Stop",
        externalEventId: "codex:Stop:session-id:turn-id:/tmp/transcript.jsonl:test",
        occurredAt: "2026-06-19T20:00:00.000Z",
        payload: { hook_event_name: "Stop" },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session-id",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn-id",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );
    expect(duplicate.id).toBe(event.id);

    const recent = await Effect.runPromise(
      listRecentRawEvents(service, {
        workspaceId: workspace.id,
      }),
    );
    expect(recent[0]?.id).toBe(event.id);
  });

  test("scopes raw event idempotency to workspace", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const [firstWorkspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `raw-first-${Date.now().toString(36)}`,
      })
      .returning();
    const [secondWorkspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `raw-second-${Date.now().toString(36)}`,
      })
      .returning();
    if (firstWorkspace === undefined || secondWorkspace === undefined) {
      throw new Error("workspace insert returned no row");
    }

    const [firstSource] = await service.db
      .insert(sourceBindings)
      .values({
        sourceType: "codex",
        sourceUri: "codex://local",
        workspaceId: firstWorkspace.id,
      })
      .returning();
    const [secondSource] = await service.db
      .insert(sourceBindings)
      .values({
        sourceType: "codex",
        sourceUri: "codex://local",
        workspaceId: secondWorkspace.id,
      })
      .returning();
    if (firstSource === undefined || secondSource === undefined) {
      throw new Error("source binding insert returned no row");
    }

    const sharedEvent = {
      actorId: "codex",
      eventType: "codex.Stop",
      externalEventId: "codex:Stop:shared-session:shared-turn:/tmp/transcript.jsonl:test",
      occurredAt: "2026-06-19T20:00:00.000Z",
      payload: { hook_event_name: "Stop" },
      provenance: { transcriptPath: "/tmp/transcript.jsonl" },
      sessionId: "shared-session",
      sourceId: "codex:local",
      sourceType: "codex",
      traceId: "shared-turn",
      trustLevel: "raw" as const,
    };

    const firstEvent = await Effect.runPromise(
      insertRawEvent(service, {
        ...sharedEvent,
        sourceBindingId: firstSource.id,
        workspaceId: firstWorkspace.id,
      }),
    );
    const secondEvent = await Effect.runPromise(
      insertRawEvent(service, {
        ...sharedEvent,
        sourceBindingId: secondSource.id,
        workspaceId: secondWorkspace.id,
      }),
    );
    const firstDuplicate = await Effect.runPromise(
      insertRawEvent(service, {
        ...sharedEvent,
        sourceBindingId: firstSource.id,
        workspaceId: firstWorkspace.id,
      }),
    );

    expect(secondEvent.id).not.toBe(firstEvent.id);
    expect(firstDuplicate.id).toBe(firstEvent.id);
  });

  test("rejects claim evidence that references another workspace raw event", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const first = await createWorkspaceWithCodexSource("evidence-first");
    const second = await createWorkspaceWithCodexSource("evidence-second");
    const rawEvent = await insertCodexPromptEvent({
      prompt: "Agreed. Cross workspace evidence should fail.",
      sourceBindingId: first.sourceBinding.id,
      turn: "turn-1",
      workspaceId: first.workspace.id,
    });

    await expect(
      Effect.runPromise(
        insertClaimEventAndProject(service, {
          attributes: { extractor: "deterministic-v1" },
          claimKey: "cross-workspace-claim",
          confidence: 0.72,
          evidence: {
            eventType: rawEvent.eventType,
            externalEventId: rawEvent.externalEventId,
            occurredAt: rawEvent.occurredAt.toISOString(),
            quote: "Agreed. Cross workspace evidence should fail.",
            rawEventId: rawEvent.id,
            sessionId: rawEvent.sessionId ?? undefined,
            sourceId: rawEvent.sourceId,
            sourceType: rawEvent.sourceType,
            traceId: rawEvent.traceId ?? undefined,
          },
          eventType: "extracted",
          kind: "decision",
          text: "Cross workspace evidence should fail.",
          workspaceId: second.workspace.id,
        }),
      ),
    ).rejects.toThrow("claim evidence rawEventId belongs to a different workspace");
  });

  test("stores extracted claim events and projects current claims", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `claims-${Date.now().toString(36)}`,
      })
      .returning();
    if (workspace === undefined) throw new Error("workspace insert returned no row");

    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        sourceType: "codex",
        sourceUri: "codex://local",
        workspaceId: workspace.id,
      })
      .returning();
    if (sourceBinding === undefined) throw new Error("source binding insert returned no row");

    const rawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: "codex:UserPromptSubmit:session:turn:/tmp/transcript.jsonl:test",
        occurredAt: "2026-06-19T20:00:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: "Agreed. We should compile Active Context from claims.",
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );

    const candidate = {
      attributes: { extractor: "deterministic-v1" },
      confidence: 0.72,
      evidence: {
        eventType: rawEvent.eventType,
        externalEventId: rawEvent.externalEventId,
        occurredAt: rawEvent.occurredAt.toISOString(),
        quote: "Agreed. We should compile Active Context from claims.",
        rawEventId: rawEvent.id,
        sessionId: rawEvent.sessionId ?? undefined,
        sourceId: rawEvent.sourceId,
        sourceType: rawEvent.sourceType,
        traceId: rawEvent.traceId ?? undefined,
      },
      kind: "decision" as const,
      text: "We should compile Active Context from claims.",
      workspaceId: workspace.id,
    };

    const firstProjection = await Effect.runPromise(
      insertExtractedCandidateClaim(service, candidate),
    );
    const duplicateProjection = await Effect.runPromise(
      insertExtractedCandidateClaim(service, candidate),
    );
    const secondRawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: "codex:UserPromptSubmit:session:turn-2:/tmp/transcript.jsonl:test",
        occurredAt: "2026-06-19T20:05:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: "Agreed. We should compile Active Context from claims.",
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn-2",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );
    const secondCandidate = {
      ...candidate,
      evidence: {
        ...candidate.evidence,
        externalEventId: secondRawEvent.externalEventId,
        occurredAt: secondRawEvent.occurredAt.toISOString(),
        rawEventId: secondRawEvent.id,
        traceId: secondRawEvent.traceId ?? undefined,
      },
    };
    const supportedProjection = await Effect.runPromise(
      insertClaimEventAndProject(service, {
        attributes: secondCandidate.attributes,
        claimKey: firstProjection.currentClaim.claimKey,
        confidence: 0.9,
        evidence: secondCandidate.evidence,
        eventType: "supported",
        kind: secondCandidate.kind,
        text: secondCandidate.text,
        workspaceId: secondCandidate.workspaceId,
      }),
    );
    const staleProjection = await Effect.runPromise(
      insertExtractedCandidateClaim(service, candidate),
    );
    const current = await Effect.runPromise(
      listCurrentClaims(service, {
        workspaceId: workspace.id,
      }),
    );

    expect(duplicateProjection.event.id).toBe(firstProjection.event.id);
    expect(supportedProjection.event.id).not.toBe(firstProjection.event.id);
    expect(firstProjection.event.attributes).toMatchObject({
      confidenceBase: 0.72,
      confidenceInputs: {
        base: 0.72,
        sourceQuality: 0.01,
      },
    });
    expect(supportedProjection.event.confidence).toBeGreaterThan(firstProjection.event.confidence);
    expect(staleProjection.currentClaim.id).toBe(supportedProjection.currentClaim.id);
    expect(staleProjection.currentClaim.state).toBe("supported");
    expect(staleProjection.currentClaim.attributes).toMatchObject({
      confidenceInputs: expect.objectContaining({
        base: 0.9,
      }),
    });
    expect(current[0]?.claimText).toBe("We should compile Active Context from claims.");
    expect(current[0]?.state).toBe("supported");
    expect(await service.db.select().from(claimEvents)).toContainEqual(
      expect.objectContaining({ id: firstProjection.event.id }),
    );
    expect(await service.db.select().from(currentClaims)).toContainEqual(
      expect.objectContaining({ id: firstProjection.currentClaim.id }),
    );
  });

  test("excludes review flag churn from confidence recurrence", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const { sourceBinding, workspace } = await createWorkspaceWithCodexSource("recurrence");
    const firstRawEvent = await insertCodexPromptEvent({
      prompt: "Agreed. Recurrence should count supporting evidence only.",
      sourceBindingId: sourceBinding.id,
      turn: "turn-1",
      workspaceId: workspace.id,
    });
    const firstProjection = await Effect.runPromise(
      insertExtractedCandidateClaim(service, {
        attributes: { extractor: "deterministic-v1" },
        confidence: 0.72,
        evidence: {
          eventType: firstRawEvent.eventType,
          externalEventId: firstRawEvent.externalEventId,
          occurredAt: firstRawEvent.occurredAt.toISOString(),
          quote: "Agreed. Recurrence should count supporting evidence only.",
          rawEventId: firstRawEvent.id,
          sessionId: firstRawEvent.sessionId ?? undefined,
          sourceId: firstRawEvent.sourceId,
          sourceType: firstRawEvent.sourceType,
          traceId: firstRawEvent.traceId ?? undefined,
        },
        kind: "decision",
        text: "Recurrence should count supporting evidence only.",
        workspaceId: workspace.id,
      }),
    );
    for (const action of ["pin", "watch", "unwatch"] as const) {
      await Effect.runPromise(
        insertClaimReviewEventAndProject(service, {
          action,
          claimKey: firstProjection.currentClaim.claimKey,
          occurredAt: "2026-06-19T20:01:00.000Z",
          workspaceId: workspace.id,
        }),
      );
    }

    const secondRawEvent = await insertCodexPromptEvent({
      prompt: "Agreed. Recurrence should count supporting evidence only.",
      sourceBindingId: sourceBinding.id,
      turn: "turn-2",
      workspaceId: workspace.id,
    });
    const secondProjection = await Effect.runPromise(
      insertClaimEventAndProject(service, {
        attributes: { extractor: "deterministic-v1" },
        claimKey: firstProjection.currentClaim.claimKey,
        confidence: 0.72,
        evidence: {
          eventType: secondRawEvent.eventType,
          externalEventId: secondRawEvent.externalEventId,
          occurredAt: secondRawEvent.occurredAt.toISOString(),
          quote: "Agreed. Recurrence should count supporting evidence only.",
          rawEventId: secondRawEvent.id,
          sessionId: secondRawEvent.sessionId ?? undefined,
          sourceId: secondRawEvent.sourceId,
          sourceType: secondRawEvent.sourceType,
          traceId: secondRawEvent.traceId ?? undefined,
        },
        eventType: "supported",
        kind: "decision",
        text: "Recurrence should count supporting evidence only.",
        workspaceId: workspace.id,
      }),
    );

    expect(secondProjection.event.attributes).toMatchObject({
      confidenceInputs: {
        recurrence: 0.04,
      },
    });
  });

  test("lists active context claims by filtering terminal states before limit", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const { sourceBinding, workspace } = await createWorkspaceWithCodexSource("active-filter");

    async function insertClaim(text: string, turn: string) {
      if (service === undefined) throw new Error("database service was not initialized");
      const rawEvent = await insertCodexPromptEvent({
        prompt: text,
        sourceBindingId: sourceBinding.id,
        turn,
        workspaceId: workspace.id,
      });
      return Effect.runPromise(
        insertExtractedCandidateClaim(service, {
          attributes: { extractor: "deterministic-v1" },
          confidence: 0.72,
          evidence: {
            eventType: rawEvent.eventType,
            externalEventId: rawEvent.externalEventId,
            occurredAt: rawEvent.occurredAt.toISOString(),
            quote: text,
            rawEventId: rawEvent.id,
            sessionId: rawEvent.sessionId ?? undefined,
            sourceId: rawEvent.sourceId,
            sourceType: rawEvent.sourceType,
            traceId: rawEvent.traceId ?? undefined,
          },
          kind: "decision",
          text,
          workspaceId: workspace.id,
        }),
      );
    }

    for (let index = 0; index < 9; index += 1) {
      const projection = await insertClaim(
        `Agreed. Terminal claim ${index.toString()} should be hidden.`,
        `terminal-${index.toString()}`,
      );
      await Effect.runPromise(
        insertClaimMaintenanceEventAndProject(service, {
          action: "supersede",
          claimKey: projection.currentClaim.claimKey,
          occurredAt: `2026-06-19T21:${index.toString().padStart(2, "0")}:00.000Z`,
          workspaceId: workspace.id,
        }),
      );
    }
    await insertClaim("Agreed. Live claim should survive terminal row pressure.", "live");

    const activeClaims = await Effect.runPromise(
      listActiveContextClaims(service, {
        limit: 1,
        workspaceId: workspace.id,
      }),
    );

    expect(activeClaims).toHaveLength(1);
    expect(activeClaims[0]?.claimText).toBe(
      "Agreed. Live claim should survive terminal row pressure.",
    );
  });

  test("detects contradictory candidate evidence and marks existing claims contradicted", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `contradictions-${Date.now().toString(36)}`,
      })
      .returning();
    if (workspace === undefined) throw new Error("workspace insert returned no row");

    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        sourceType: "codex",
        sourceUri: "codex://local",
        workspaceId: workspace.id,
      })
      .returning();
    if (sourceBinding === undefined) throw new Error("source binding insert returned no row");

    const firstRawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: `codex:contradiction:${workspace.id}:turn-1`,
        occurredAt: "2026-06-19T20:00:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: "We should use SSR for the control plane.",
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn-1",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );
    const firstProjection = await Effect.runPromise(
      insertExtractedCandidateClaim(service, {
        attributes: { extractor: "deterministic-v1" },
        confidence: 0.66,
        evidence: {
          eventType: firstRawEvent.eventType,
          externalEventId: firstRawEvent.externalEventId,
          occurredAt: firstRawEvent.occurredAt.toISOString(),
          quote: "We should use SSR for the control plane.",
          rawEventId: firstRawEvent.id,
          sessionId: firstRawEvent.sessionId ?? undefined,
          sourceId: firstRawEvent.sourceId,
          sourceType: firstRawEvent.sourceType,
          traceId: firstRawEvent.traceId ?? undefined,
        },
        kind: "follow_up",
        text: "We should use SSR for the control plane.",
        workspaceId: workspace.id,
      }),
    );

    const secondRawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: `codex:contradiction:${workspace.id}:turn-2`,
        occurredAt: "2026-06-19T20:05:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: "We should not use SSR for the control plane.",
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn-2",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );
    await Effect.runPromise(
      insertExtractedCandidateClaim(service, {
        attributes: { extractor: "deterministic-v1" },
        confidence: 0.66,
        evidence: {
          eventType: secondRawEvent.eventType,
          externalEventId: secondRawEvent.externalEventId,
          occurredAt: secondRawEvent.occurredAt.toISOString(),
          quote: "We should not use SSR for the control plane.",
          rawEventId: secondRawEvent.id,
          sessionId: secondRawEvent.sessionId ?? undefined,
          sourceId: secondRawEvent.sourceId,
          sourceType: secondRawEvent.sourceType,
          traceId: secondRawEvent.traceId ?? undefined,
        },
        kind: "follow_up",
        text: "We should not use SSR for the control plane.",
        workspaceId: workspace.id,
      }),
    );

    const current = await Effect.runPromise(
      listCurrentClaims(service, {
        workspaceId: workspace.id,
      }),
    );
    const contradictedClaim = current.find(
      (claim) => claim.claimKey === firstProjection.currentClaim.claimKey,
    );

    expect(contradictedClaim?.state).toBe("contradicted");
    expect(contradictedClaim?.attributes).toMatchObject({
      contradiction: {
        detectedByClaimText: "We should not use SSR for the control plane.",
      },
    });
  });

  test("projects claim maintenance actions for decay and supersede", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `maintenance-${Date.now().toString(36)}`,
      })
      .returning();
    if (workspace === undefined) throw new Error("workspace insert returned no row");

    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        sourceType: "codex",
        sourceUri: "codex://local",
        workspaceId: workspace.id,
      })
      .returning();
    if (sourceBinding === undefined) throw new Error("source binding insert returned no row");
    const maintenanceWorkspaceId = workspace.id;
    const maintenanceSourceBindingId = sourceBinding.id;

    async function seedClaim(text: string, turn: string) {
      if (service === undefined) throw new Error("database service was not initialized");
      const rawEvent = await Effect.runPromise(
        insertRawEvent(service, {
          actorId: "codex",
          eventType: "codex.UserPromptSubmit",
          externalEventId: `codex:maintenance:${maintenanceWorkspaceId}:${turn}`,
          occurredAt: "2026-06-19T20:00:00.000Z",
          payload: {
            hook_event_name: "UserPromptSubmit",
            prompt: text,
          },
          provenance: { transcriptPath: "/tmp/transcript.jsonl" },
          sessionId: "session",
          sourceBindingId: maintenanceSourceBindingId,
          sourceId: "codex:local",
          sourceType: "codex",
          traceId: turn,
          trustLevel: "raw",
          workspaceId: maintenanceWorkspaceId,
        }),
      );
      return Effect.runPromise(
        insertExtractedCandidateClaim(service, {
          attributes: { extractor: "deterministic-v1" },
          confidence: 0.72,
          evidence: {
            eventType: rawEvent.eventType,
            externalEventId: rawEvent.externalEventId,
            occurredAt: rawEvent.occurredAt.toISOString(),
            quote: text,
            rawEventId: rawEvent.id,
            sessionId: rawEvent.sessionId ?? undefined,
            sourceId: rawEvent.sourceId,
            sourceType: rawEvent.sourceType,
            traceId: rawEvent.traceId ?? undefined,
          },
          kind: "decision",
          text,
          workspaceId: maintenanceWorkspaceId,
        }),
      );
    }

    const decayed = await seedClaim("Agreed. We should keep the old local cache.", "turn-1");
    const superseded = await seedClaim("Agreed. We should keep the old CLI surface.", "turn-2");
    const decayedProjection = await Effect.runPromise(
      insertClaimMaintenanceEventAndProject(service, {
        action: "decay",
        claimKey: decayed.currentClaim.claimKey,
        occurredAt: "2026-06-19T21:00:00.000Z",
        reason: "stale evidence",
        workspaceId: maintenanceWorkspaceId,
      }),
    );
    const supersededProjection = await Effect.runPromise(
      insertClaimMaintenanceEventAndProject(service, {
        action: "supersede",
        claimKey: superseded.currentClaim.claimKey,
        occurredAt: "2026-06-19T21:05:00.000Z",
        reason: "new CLI contract",
        targetClaimKeys: [decayed.currentClaim.claimKey],
        workspaceId: maintenanceWorkspaceId,
      }),
    );

    expect(decayedProjection.currentClaim.state).toBe("decayed");
    expect(decayedProjection.currentClaim.confidence).toBeLessThan(decayed.currentClaim.confidence);
    expect(decayedProjection.currentClaim.attributes).toMatchObject({
      maintenanceLastAction: "decayed",
      maintenanceReason: "stale evidence",
    });
    expect(supersededProjection.currentClaim.state).toBe("superseded");
    expect(supersededProjection.currentClaim.attributes).toMatchObject({
      maintenanceLastAction: "superseded",
      maintenanceTargetClaimKeys: [decayed.currentClaim.claimKey],
    });
  });

  test("projects claim review actions from append-only events", async () => {
    if (service === undefined) throw new Error("database service was not initialized");

    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `review-${Date.now().toString(36)}`,
      })
      .returning();
    if (workspace === undefined) throw new Error("workspace insert returned no row");

    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        sourceType: "codex",
        sourceUri: "codex://local",
        workspaceId: workspace.id,
      })
      .returning();
    if (sourceBinding === undefined) throw new Error("source binding insert returned no row");

    const rawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: `codex:review:${workspace.id}:turn-1`,
        occurredAt: "2026-06-19T20:00:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: "Agreed. Claim review should be durable.",
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn-1",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );

    const firstProjection = await Effect.runPromise(
      insertExtractedCandidateClaim(service, {
        attributes: { extractor: "deterministic-v1" },
        confidence: 0.72,
        evidence: {
          eventType: rawEvent.eventType,
          externalEventId: rawEvent.externalEventId,
          occurredAt: rawEvent.occurredAt.toISOString(),
          quote: "Agreed. Claim review should be durable.",
          rawEventId: rawEvent.id,
          sessionId: rawEvent.sessionId ?? undefined,
          sourceId: rawEvent.sourceId,
          sourceType: rawEvent.sourceType,
          traceId: rawEvent.traceId ?? undefined,
        },
        kind: "decision",
        text: "Claim review should be durable.",
        workspaceId: workspace.id,
      }),
    );

    const acceptedProjection = await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: "accept",
        claimKey: firstProjection.currentClaim.claimKey,
        occurredAt: "2026-06-19T20:10:00.000Z",
        workspaceId: workspace.id,
      }),
    );
    const pinnedProjection = await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: "pin",
        claimKey: firstProjection.currentClaim.claimKey,
        occurredAt: "2026-06-19T20:11:00.000Z",
        workspaceId: workspace.id,
      }),
    );
    const watchedProjection = await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: "watch",
        claimKey: firstProjection.currentClaim.claimKey,
        occurredAt: "2026-06-19T20:12:00.000Z",
        workspaceId: workspace.id,
      }),
    );
    const laterRawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: `codex:review:${workspace.id}:turn-2`,
        occurredAt: "2026-06-19T20:20:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: "Agreed. Claim review should be durable.",
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn-2",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );
    const laterSourceProjection = await Effect.runPromise(
      insertClaimEventAndProject(service, {
        attributes: { extractor: "deterministic-v2" },
        claimKey: firstProjection.currentClaim.claimKey,
        confidence: 0.91,
        evidence: {
          eventType: laterRawEvent.eventType,
          externalEventId: laterRawEvent.externalEventId,
          occurredAt: laterRawEvent.occurredAt.toISOString(),
          quote: "Agreed. Claim review should be durable.",
          rawEventId: laterRawEvent.id,
          sessionId: laterRawEvent.sessionId ?? undefined,
          sourceId: laterRawEvent.sourceId,
          sourceType: laterRawEvent.sourceType,
          traceId: laterRawEvent.traceId ?? undefined,
        },
        eventType: "supported",
        kind: "decision",
        text: "Claim review should be durable.",
        workspaceId: workspace.id,
      }),
    );
    const unwatchedProjection = await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: "unwatch",
        claimKey: firstProjection.currentClaim.claimKey,
        occurredAt: "2026-06-19T20:20:30.000Z",
        workspaceId: workspace.id,
      }),
    );
    const rejectedProjection = await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: "reject",
        claimKey: firstProjection.currentClaim.claimKey,
        occurredAt: "2026-06-19T20:21:00.000Z",
        workspaceId: workspace.id,
      }),
    );
    const revivedProjection = await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: "accept",
        claimKey: firstProjection.currentClaim.claimKey,
        occurredAt: "2026-06-19T20:22:00.000Z",
        workspaceId: workspace.id,
      }),
    );
    const contradictedRawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: `codex:review:${workspace.id}:turn-3`,
        occurredAt: "2026-06-19T20:23:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: "Actually, claim review should not be durable.",
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "turn-3",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );
    const contradictedProjection = await Effect.runPromise(
      insertClaimEventAndProject(service, {
        attributes: { extractor: "deterministic-v2" },
        claimKey: firstProjection.currentClaim.claimKey,
        confidence: 0.87,
        evidence: {
          eventType: contradictedRawEvent.eventType,
          externalEventId: contradictedRawEvent.externalEventId,
          occurredAt: contradictedRawEvent.occurredAt.toISOString(),
          quote: "Actually, claim review should not be durable.",
          rawEventId: contradictedRawEvent.id,
          sessionId: contradictedRawEvent.sessionId ?? undefined,
          sourceId: contradictedRawEvent.sourceId,
          sourceType: contradictedRawEvent.sourceType,
          traceId: contradictedRawEvent.traceId ?? undefined,
        },
        eventType: "contradicted",
        kind: "decision",
        text: "Claim review should be durable.",
        workspaceId: workspace.id,
      }),
    );
    const revivedFromContradictedProjection = await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: "accept",
        claimKey: firstProjection.currentClaim.claimKey,
        occurredAt: "2026-06-19T20:24:00.000Z",
        workspaceId: workspace.id,
      }),
    );
    const staleProjection = await Effect.runPromise(
      insertExtractedCandidateClaim(service, {
        attributes: { extractor: "deterministic-v1" },
        confidence: 0.72,
        evidence: {
          eventType: rawEvent.eventType,
          externalEventId: rawEvent.externalEventId,
          occurredAt: rawEvent.occurredAt.toISOString(),
          quote: "Agreed. Claim review should be durable.",
          rawEventId: rawEvent.id,
          sessionId: rawEvent.sessionId ?? undefined,
          sourceId: rawEvent.sourceId,
          sourceType: rawEvent.sourceType,
          traceId: rawEvent.traceId ?? undefined,
        },
        kind: "decision",
        text: "Claim review should be durable.",
        workspaceId: workspace.id,
      }),
    );
    const reviewEvents = await service.db
      .select()
      .from(claimEvents)
      .where(eq(claimEvents.claimKey, firstProjection.currentClaim.claimKey));

    expect(acceptedProjection.event.eventType).toBe("supported");
    expect(acceptedProjection.event.rawEventId).not.toBe(rawEvent.id);
    expect(acceptedProjection.event.occurredAt.toISOString()).toBe("2026-06-19T20:10:00.000Z");
    expect(pinnedProjection.event.eventType).toBe("pinned");
    expect(pinnedProjection.currentClaim.state).toBe("supported");
    expect(pinnedProjection.currentClaim.attributes).toMatchObject({
      reviewLastAction: "pinned",
      reviewPinned: true,
    });
    expect(watchedProjection.event.eventType).toBe("watched");
    expect(watchedProjection.currentClaim.attributes).toMatchObject({
      reviewLastAction: "watched",
      reviewPinned: true,
      reviewWatched: true,
    });
    expect(laterSourceProjection.currentClaim.attributes).toMatchObject({
      extractor: "deterministic-v2",
      reviewLastAction: "watched",
      reviewPinned: true,
      reviewWatched: true,
    });
    expect(unwatchedProjection.event.eventType).toBe("unwatched");
    expect(unwatchedProjection.currentClaim.attributes).toMatchObject({
      reviewLastAction: "unwatched",
      reviewPinned: true,
      reviewWatched: false,
    });
    expect(rejectedProjection.currentClaim.state).toBe("rejected");
    expect(revivedProjection.currentClaim.state).toBe("supported");
    expect(revivedProjection.currentClaim.attributes).toMatchObject({
      reviewLastAction: "supported",
      reviewPinned: true,
      reviewWatched: false,
    });
    expect(contradictedProjection.currentClaim.state).toBe("contradicted");
    expect(contradictedProjection.currentClaim.attributes).toMatchObject({
      reviewPinned: true,
      reviewWatched: false,
    });
    expect(revivedFromContradictedProjection.currentClaim.state).toBe("supported");
    expect(revivedFromContradictedProjection.currentClaim.attributes).toMatchObject({
      reviewLastAction: "supported",
      reviewPinned: true,
      reviewWatched: false,
    });
    expect(staleProjection.currentClaim.state).toBe("supported");
    expect(staleProjection.currentClaim.attributes).toMatchObject({
      reviewLastAction: "supported",
      reviewPinned: true,
      reviewWatched: false,
    });
    expect(reviewEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "contradicted",
        "extracted",
        "pinned",
        "rejected",
        "supported",
        "unwatched",
        "watched",
      ]),
    );
  });

  test("promotes a current claim into an event-backed decision record", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const { sourceBinding, workspace } = await createWorkspaceWithCodexSource("promotion");
    const rawEvent = await insertCodexPromptEvent({
      prompt: "Observation: Saga should expose claim promotion from the governance UI.",
      sourceBindingId: sourceBinding.id,
      turn: "promotion-1",
      workspaceId: workspace.id,
    });
    const projection = await Effect.runPromise(
      insertExtractedCandidateClaim(service, {
        attributes: { extractor: "deterministic-v1" },
        confidence: 0.62,
        evidence: {
          eventType: rawEvent.eventType,
          externalEventId: rawEvent.externalEventId,
          occurredAt: rawEvent.occurredAt.toISOString(),
          quote: "Observation: Saga should expose claim promotion from the governance UI.",
          rawEventId: rawEvent.id,
          sessionId: rawEvent.sessionId ?? undefined,
          sourceId: rawEvent.sourceId,
          sourceType: rawEvent.sourceType,
          traceId: rawEvent.traceId ?? undefined,
        },
        kind: "observation",
        text: "Saga should expose claim promotion from the governance UI.",
        workspaceId: workspace.id,
      }),
    );

    const promoted = await Effect.runPromise(
      insertClaimPromotionEventAndProject(service, {
        claimKey: projection.currentClaim.claimKey,
        occurredAt: "2026-06-19T21:00:00.000Z",
        title: "Expose Claim Promotion",
        workspaceId: workspace.id,
      }),
    );
    const [promotionRawEvent] = await service.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, promoted.event.rawEventId))
      .limit(1);

    expect(promoted.event.eventType).toBe("promoted");
    expect(promoted.event.claimKind).toBe("decision");
    expect(promoted.event.evidence).toMatchObject({
      eventType: "saga.claim.promotion",
      quote: "Promoted to decision record: Expose Claim Promotion",
    });
    expect(promoted.currentClaim).toMatchObject({
      claimKind: "decision",
      state: "supported",
    });
    expect(promoted.currentClaim.confidence).toBeGreaterThan(projection.currentClaim.confidence);
    expect(promoted.currentClaim.attributes).toMatchObject({
      adrPromoted: true,
      adrPromotedAt: "2026-06-19T21:00:00.000Z",
      adrTitle: "Expose Claim Promotion",
    });
    expect(promotionRawEvent).toMatchObject({
      eventType: "saga.claim.promotion",
      sourceId: "saga:control-plane",
      sourceType: "saga",
      workspaceId: workspace.id,
    });

    const laterRawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: "codex",
        eventType: "codex.UserPromptSubmit",
        externalEventId: `codex:${workspace.id}:promotion-2`,
        occurredAt: "2026-06-19T21:05:00.000Z",
        payload: {
          hook_event_name: "UserPromptSubmit",
          prompt: "Actually, Saga should not expose claim promotion from the governance UI.",
        },
        provenance: { transcriptPath: "/tmp/transcript.jsonl" },
        sessionId: "session",
        sourceBindingId: sourceBinding.id,
        sourceId: "codex:local",
        sourceType: "codex",
        traceId: "promotion-2",
        trustLevel: "raw",
        workspaceId: workspace.id,
      }),
    );
    const contradicted = await Effect.runPromise(
      insertClaimEventAndProject(service, {
        attributes: { extractor: "deterministic-v2" },
        claimKey: projection.currentClaim.claimKey,
        confidence: 0.84,
        evidence: {
          eventType: laterRawEvent.eventType,
          externalEventId: laterRawEvent.externalEventId,
          occurredAt: laterRawEvent.occurredAt.toISOString(),
          quote: "Actually, Saga should not expose claim promotion from the governance UI.",
          rawEventId: laterRawEvent.id,
          sessionId: laterRawEvent.sessionId ?? undefined,
          sourceId: laterRawEvent.sourceId,
          sourceType: laterRawEvent.sourceType,
          traceId: laterRawEvent.traceId ?? undefined,
        },
        eventType: "contradicted",
        kind: "decision",
        text: "Saga should expose claim promotion from the governance UI.",
        workspaceId: workspace.id,
      }),
    );

    expect(contradicted.currentClaim.attributes).toMatchObject({
      adrPromoted: true,
      adrPromotedAt: "2026-06-19T21:00:00.000Z",
      adrTitle: "Expose Claim Promotion",
      extractor: "deterministic-v2",
    });
  });

  test("does not promote terminal claims", async () => {
    if (service === undefined) throw new Error("database service was not initialized");
    const db = service;
    const { sourceBinding, workspace } = await createWorkspaceWithCodexSource("terminal-promotion");

    async function seedClaim(text: string, turn: string) {
      const rawEvent = await insertCodexPromptEvent({
        prompt: text,
        sourceBindingId: sourceBinding.id,
        turn,
        workspaceId: workspace.id,
      });
      return Effect.runPromise(
        insertExtractedCandidateClaim(db, {
          attributes: { extractor: "deterministic-v1" },
          confidence: 0.68,
          evidence: {
            eventType: rawEvent.eventType,
            externalEventId: rawEvent.externalEventId,
            occurredAt: rawEvent.occurredAt.toISOString(),
            quote: text,
            rawEventId: rawEvent.id,
            sessionId: rawEvent.sessionId ?? undefined,
            sourceId: rawEvent.sourceId,
            sourceType: rawEvent.sourceType,
            traceId: rawEvent.traceId ?? undefined,
          },
          kind: "decision",
          text,
          workspaceId: workspace.id,
        }),
      );
    }

    const rejected = await seedClaim("Rejected claims should remain terminal.", "terminal-1");
    await Effect.runPromise(
      insertClaimReviewEventAndProject(service, {
        action: "reject",
        claimKey: rejected.currentClaim.claimKey,
        occurredAt: "2026-06-19T21:10:00.000Z",
        workspaceId: workspace.id,
      }),
    );
    const superseded = await seedClaim("Superseded claims should remain terminal.", "terminal-2");
    await Effect.runPromise(
      insertClaimMaintenanceEventAndProject(service, {
        action: "supersede",
        claimKey: superseded.currentClaim.claimKey,
        occurredAt: "2026-06-19T21:11:00.000Z",
        workspaceId: workspace.id,
      }),
    );

    await expect(
      Effect.runPromise(
        insertClaimPromotionEventAndProject(service, {
          claimKey: rejected.currentClaim.claimKey,
          workspaceId: workspace.id,
        }),
      ),
    ).rejects.toThrow("terminal claims are not available for promotion");
    await expect(
      Effect.runPromise(
        insertClaimPromotionEventAndProject(service, {
          claimKey: superseded.currentClaim.claimKey,
          workspaceId: workspace.id,
        }),
      ),
    ).rejects.toThrow("terminal claims are not available for promotion");
  });
});
