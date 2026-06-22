import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  RawSessionImportInput,
  RawSessionImportResult,
  RecentSessionRecord,
  SessionDetail,
} from "@saga/db";
import { writeBindingFile } from "./init.js";
import { runSessionsCommand } from "./sessions.js";

const renderOptions = {
  ascii: true,
  color: "never",
  format: "json",
  isTty: false,
} as const;

describe("runSessionsCommand", () => {
  test("imports a raw session file with Phase 1 metadata flags", async () => {
    const projectRoot = boundProject();
    const inputPath = join(projectRoot, "session.jsonl");
    writeFileSync(inputPath, '{"type":"user","text":"Import this session"}\n');
    let capturedInput: RawSessionImportInput | undefined;

    const output = await runSessionsCommand(
      [
        "import",
        inputPath,
        "--harness",
        "codex",
        "--harness-session-id",
        "codex-session-1",
        "--model",
        "gpt-5",
        "--author",
        "drew",
        "--author-name",
        "Drew",
        "--metadata",
        '{"ticket":"SGA-125"}',
        "--provenance",
        '{"source":"fixture"}',
      ],
      renderOptions,
      {
        cwd: projectRoot,
        importRecord: async (input) => {
          capturedInput = input;
          return importResult(input);
        },
      },
    );

    expect(capturedInput).toMatchObject({
      author: {
        displayName: "Drew",
        handle: "drew",
      },
      contentType: "jsonl",
      harness: "codex",
      harnessSessionId: "codex-session-1",
      host: {
        id: "host-id",
        label: "test-host",
        projectRoot,
      },
      metadata: {
        importMode: "manual",
        ticket: "SGA-125",
      },
      model: "gpt-5",
      provenance: {
        importedBy: "saga sessions import",
        source: "fixture",
      },
      rawContent: '{"type":"user","text":"Import this session"}\n',
      workspaceId: "workspace-id",
    });
    expect(capturedInput?.locator).toMatch(/^file:/);

    expect(JSON.parse(output)).toMatchObject({
      operation: "inserted",
      rawSessionRecord: {
        id: "raw-record-id",
      },
      session: {
        id: "session-id",
      },
    });
  });

  test("lists recent raw session records with records and ids formats", async () => {
    const projectRoot = boundProject();
    const rows = [recentRecord()];

    const records = await runSessionsCommand(
      ["recent", "--limit", "5", "--active-only"],
      {
        ...renderOptions,
        format: "records",
      },
      {
        cwd: projectRoot,
        listRecent: async (input) => {
          expect(input).toMatchObject({
            activeOnly: true,
            limit: 5,
            workspaceId: "workspace-id",
          });
          return rows;
        },
      },
    );
    const ids = await runSessionsCommand(
      ["recent"],
      {
        ...renderOptions,
        format: "ids",
      },
      {
        cwd: projectRoot,
        listRecent: async () => rows,
      },
    );

    expect(records).toContain("Raw Session Records");
    expect(records).toContain("Activity Interval");
    expect(records).toContain("host-user");
    expect(records).toContain("provenance");
    expect(ids).toBe("raw-record-id");
  });

  test("shows a bounded session detail with Activity Intervals, turns, segments, and metadata", async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(
      ["show", "session-id", "--turns", "1", "--segments", "1", "--raw-records", "2", "--raw-body"],
      {
        ...renderOptions,
        format: "records",
      },
      {
        cwd: projectRoot,
        getDetail: async (input) => {
          expect(input).toMatchObject({
            id: "session-id",
            includeRawBody: true,
            maxRawRecords: 2,
            maxSegmentsPerTurn: 1,
            maxTurns: 1,
            workspaceId: "workspace-id",
          });
          return sessionDetail();
        },
      },
    );

    expect(output).toContain("Session");
    expect(output).toContain("Raw Session Record");
    expect(output).toContain("Activity Interval 0");
    expect(output).toContain("Turn 0");
    expect(output).toContain("Segment 0");
    expect(output).toContain("host-user");
    expect(output).toContain("provenance");
    expect(output).toContain("Bounds");
  });

  test("renders the bounded raw session snapshot list without duplicate active or selected blocks", async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(
      ["show", "session-id", "--raw-records", "2"],
      {
        ...renderOptions,
        format: "records",
      },
      {
        cwd: projectRoot,
        getDetail: async (input) => {
          expect(input).toMatchObject({
            id: "session-id",
            maxRawRecords: 2,
            workspaceId: "workspace-id",
          });
          return sessionDetailWithRawRecords();
        },
      },
    );

    expect(countOccurrences(output, "Raw Session Record")).toBe(2);
    expect(output).not.toContain("Active Raw Session Record");
    expect(output).not.toContain("Selected Raw Session Record");
    expect(output).toContain("raw-record-id");
    expect(output).toContain("raw-record-older");
  });
});

function boundProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "saga-sessions-"));
  writeBindingFile(projectRoot, {
    host: {
      generatedAt: "2026-06-22T00:00:00.000Z",
      id: "host-id",
      label: "test-host",
    },
    project: {
      gitRemote: undefined,
      root: projectRoot,
    },
    schemaVersion: 1,
    service: {
      databaseUrl: "env:DATABASE_URL",
    },
    sourceBinding: {
      id: "source-id",
    },
    workspace: {
      handle: "saga",
      id: "workspace-id",
    },
  });
  return projectRoot;
}

function importResult(input: RawSessionImportInput): RawSessionImportResult {
  const capturedAt = new Date("2026-06-22T10:00:00.000Z");
  return {
    activityInterval: {
      createdAt: capturedAt,
      endedAt: null,
      id: "activity-interval-id",
      metadata: {},
      ordinal: 0,
      sessionId: "session-id",
      settledAt: null,
      settlementReason: null,
      settlementTriggerRawEventId: null,
      startedAt: capturedAt,
      status: "active",
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
    authorUser: {
      createdAt: capturedAt,
      displayName: input.author.displayName ?? null,
      externalSubject: input.host.id,
      handle: input.author.handle,
      id: "user-id",
      identitySource: "host",
      metadata: {},
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
    contentHash: "sha256:test",
    operation: "inserted",
    rawSessionRecord: {
      activityIntervalId: "activity-interval-id",
      authorUserId: "user-id",
      bodyJson: null,
      bodyText: input.rawContent,
      capturedAt,
      contentBytes: Buffer.byteLength(input.rawContent, "utf8"),
      contentHash: "sha256:test",
      contentType: input.contentType,
      createdAt: capturedAt,
      harness: input.harness,
      harnessSessionId: input.harnessSessionId ?? null,
      id: "raw-record-id",
      isActive: true,
      metadata: input.metadata ?? {},
      provenance: input.provenance ?? {},
      redactedFromRawSessionRecordId: null,
      sessionId: "session-id",
      snapshotOrdinal: 0,
      sourceBindingId: "source-binding-id",
      sourceLocator: input.locator ?? null,
      status: "captured",
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
    session: {
      authorUserId: "user-id",
      createdAt: capturedAt,
      endedAt: null,
      harness: input.harness,
      harnessSessionId: input.harnessSessionId ?? null,
      id: "session-id",
      lastActivityAt: capturedAt,
      metadata: {},
      model: input.model ?? null,
      provenance: {},
      sourceBindingId: "source-binding-id",
      sourceLocator: input.locator ?? null,
      sourceLocatorHash: null,
      startedAt: capturedAt,
      status: input.status ?? "active",
      title: input.title ?? null,
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
    sourceBinding: {
      config: {},
      createdAt: capturedAt,
      displayName: "Codex on test-host",
      enabled: true,
      id: "source-binding-id",
      sourceType: input.harness,
      sourceUri: `${input.harness}://host/${input.host.id}`,
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
  };
}

function recentRecord(): RecentSessionRecord {
  const capturedAt = new Date("2026-06-22T10:00:00.000Z");
  return {
    activityInterval: {
      endedAt: null,
      id: "activity-interval-id",
      metadata: {},
      ordinal: 0,
      sessionId: "session-id",
      settledAt: null,
      settlementReason: null,
      startedAt: capturedAt,
      status: "active",
    },
    authorUser: {
      displayName: "Drew",
      externalSubject: "host-id",
      handle: "drew",
      id: "user-id",
      identitySource: "host",
      metadata: {},
    },
    counts: {
      activityIntervals: 1,
      rawSessionRecords: 1,
      segments: 1,
      turns: 1,
    },
    rawSessionRecord: {
      capturedAt,
      contentBytes: 12,
      contentHash: "sha256:test",
      contentType: "jsonl",
      harness: "codex",
      harnessSessionId: "codex-session-1",
      id: "raw-record-id",
      isActive: true,
      metadata: {},
      provenance: {
        importedBy: "test",
      },
      sessionId: "session-id",
      snapshotOrdinal: 0,
      sourceLocator: "file:///tmp/session.jsonl",
      status: "captured",
    },
    session: {
      endedAt: null,
      harness: "codex",
      harnessSessionId: "codex-session-1",
      id: "session-id",
      lastActivityAt: capturedAt,
      metadata: {},
      model: "gpt-5",
      provenance: {},
      sourceBindingId: "source-binding-id",
      sourceLocator: "file:///tmp/session.jsonl",
      startedAt: capturedAt,
      status: "active",
      title: null,
      workspaceId: "workspace-id",
    },
    sourceBinding: {
      config: {},
      displayName: "Codex on test-host",
      enabled: true,
      id: "source-binding-id",
      sourceType: "codex",
      sourceUri: "codex://host/host-id",
    },
  };
}

function sessionDetail(): SessionDetail {
  const row = recentRecord();
  return {
    activeRawSessionRecord: row.rawSessionRecord,
    activityIntervals: [
      {
        activityInterval: row.activityInterval ?? {
          endedAt: null,
          id: "activity-interval-id",
          metadata: {},
          ordinal: 0,
          sessionId: "session-id",
          settledAt: null,
          settlementReason: null,
          startedAt: new Date("2026-06-22T10:00:00.000Z"),
          status: "active",
        },
        turns: [
          {
            contentParts: [{ type: "text", text: "Hello" }],
            endedAt: null,
            metadata: {
              cwd: "/work/saga",
            },
            rawEventIds: [],
            rawSpan: {},
            segments: [
              {
                charEnd: 5,
                charStart: 0,
                id: "segment-id",
                metadata: {},
                ordinal: 0,
                searchText: "Hello",
                segmentKind: "turn",
                snippet: "Hello",
                tokenEnd: 1,
                tokenStart: 0,
              },
            ],
            startedAt: new Date("2026-06-22T10:00:00.000Z"),
            turn: {
              actorKind: "host_user",
              actorLabel: "drew",
              harnessTurnId: "turn-1",
              id: "turn-id",
              model: "gpt-5",
              ordinal: 0,
              role: "user",
            },
          },
        ],
      },
    ],
    authorUser: row.authorUser,
    limits: {
      includeRawBody: true,
      maxRawRecords: 10,
      maxSegmentsPerTurn: 1,
      maxTurns: 1,
    },
    rawSessionRecords: [row.rawSessionRecord],
    selectedRawSessionRecord: null,
    session: row.session,
    sourceBinding: row.sourceBinding,
    truncated: {
      rawSessionRecords: false,
      segments: false,
      turns: true,
    },
  };
}

function sessionDetailWithRawRecords(): SessionDetail {
  const detail = sessionDetail();
  if (detail.activeRawSessionRecord === null) throw new Error("missing active raw record");
  const olderRawRecord = {
    ...detail.activeRawSessionRecord,
    capturedAt: new Date("2026-06-22T09:55:00.000Z"),
    contentHash: "sha256:older",
    id: "raw-record-older",
    isActive: false,
    snapshotOrdinal: 0,
  };
  const activeRawRecord = {
    ...detail.activeRawSessionRecord,
    snapshotOrdinal: 1,
  };
  return {
    ...detail,
    activeRawSessionRecord: activeRawRecord,
    rawSessionRecords: [activeRawRecord, olderRawRecord],
    selectedRawSessionRecord: olderRawRecord,
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
