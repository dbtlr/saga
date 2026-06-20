import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import postgres from "postgres";
import {
  insertClaimEventAndProject,
  insertClaimReviewEventAndProject,
  insertExtractedCandidateClaim,
  listCurrentClaims,
} from "./claim.js";
import { makeDatabase, runMigrations, type DatabaseService } from "./database.js";
import { insertRawEvent, listRecentRawEvents } from "./raw-event.js";
import {
  claimEvents,
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
});
