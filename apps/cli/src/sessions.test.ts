import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionSafetyError } from '@saga/db';
import type {
  DeleteSessionSafetyResult,
  RawSessionImportInput,
  RawSessionImportResult,
  RecentSessionRecord,
  RedactSessionSafetyResult,
  SessionDetail,
  SessionRawSessionRecordMetadata,
} from '@saga/db';
import { describe, expect, it } from 'vitest';

import { BINDING_FILE_NAME, writeBindingFile } from './init.js';
import { runSessionsCommand } from './sessions.js';

const renderOptions = {
  ascii: true,
  color: 'never',
  format: 'json',
  isTty: false,
} as const;

describe('runSessionsCommand', () => {
  it('imports a raw session file with Phase 1 metadata flags', async () => {
    const projectRoot = boundProject();
    const inputPath = join(projectRoot, 'session.jsonl');
    writeFileSync(inputPath, '{"type":"user","text":"Import this session"}\n');
    let capturedInput: RawSessionImportInput | undefined;

    const output = await runSessionsCommand(
      [
        'import',
        inputPath,
        '--harness',
        'codex',
        '--harness-session-id',
        'codex-session-1',
        '--model',
        'gpt-5',
        '--author',
        'drew',
        '--author-name',
        'Drew',
        '--metadata',
        '{"ticket":"SGA-125"}',
        '--provenance',
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
        displayName: 'Drew',
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'codex',
      harnessSessionId: 'codex-session-1',
      host: {
        id: 'host-id',
        label: 'test-host',
        projectRoot,
      },
      metadata: {
        importMode: 'manual',
        ticket: 'SGA-125',
      },
      model: 'gpt-5',
      provenance: {
        importedBy: 'saga sessions import',
        source: 'fixture',
      },
      rawContent: '{"type":"user","text":"Import this session"}\n',
      workspaceId: 'workspace-id',
    });
    expect(capturedInput?.locator).toMatch(/^file:/);

    expect(JSON.parse(output)).toMatchObject({
      operation: 'inserted',
      rawSessionRecord: {
        id: 'raw-record-id',
      },
      session: {
        id: 'session-id',
      },
    });
    expect(output).not.toContain(inputPath);
    expect(output).not.toContain(projectRoot);
    expect(output).not.toContain('file://');
  });

  it('lists recent raw session records with records and ids formats', async () => {
    const projectRoot = boundProject();
    const rows = [recentRecord()];

    const records = await runSessionsCommand(
      ['recent', '--limit', '5', '--active-only'],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        listRecent: async (input) => {
          expect(input).toMatchObject({
            activeOnly: true,
            limit: 5,
            workspaceId: 'workspace-id',
          });
          return rows;
        },
      },
    );
    const ids = await runSessionsCommand(
      ['recent'],
      {
        ...renderOptions,
        format: 'ids',
      },
      {
        cwd: projectRoot,
        listRecent: async () => rows,
      },
    );

    expect(records).toContain('Raw Session Records');
    expect(records).toContain('Activity Interval');
    expect(records).toContain('host-user');
    expect(records).toContain('provenance');
    expect(records).toContain('[local-path-redacted]');
    expect(records).not.toContain('/tmp/session.jsonl');
    expect(records).not.toContain('/work/saga');
    expect(records).not.toContain('file://');
    expect(ids).toBe('raw-record-id');
  });

  it('redacts local locators from recent structured output', async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(['recent'], renderOptions, {
      cwd: projectRoot,
      listRecent: async () => [recentRecord()],
    });

    expect(output).toContain('[local-path-redacted]');
    expect(output).not.toContain('/tmp/session.jsonl');
    expect(output).not.toContain('/work/saga');
    expect(output).not.toContain('file://');
  });

  it('deletes a session by explicit id with structured safety metadata', async () => {
    const projectRoot = boundProject();
    const secretReason = 'delete-reason-secret-token';
    const output = await runSessionsCommand(
      ['delete', 'raw-record-id', '--reason', secretReason],
      renderOptions,
      {
        cwd: projectRoot,
        deleteSession: async (input) => {
          expect(input).toStrictEqual({
            id: 'raw-record-id',
            origin: 'saga sessions delete',
            reason: secretReason,
            workspaceId: 'workspace-id',
          });
          return deleteResult();
        },
      },
    );

    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      deleted: {
        rawSessionRecords: 1,
        segments: 2,
        turns: 2,
      },
      operation: 'deleted',
      originClassification: 'cli',
      reasonProvided: true,
      sessionId: 'session-id',
    });
    expect(output).not.toContain(secretReason);
  });

  it('redacts a session with repeated literal and regex patterns without echoing audit text', async () => {
    const projectRoot = boundProject();
    const secretOrigin = 'redact-origin-secret-token';
    const secretReason = 'redact-reason-secret-token';
    const output = await runSessionsCommand(
      [
        'redact',
        'session-id',
        '--literal',
        'secret-token',
        '--literal=second-secret',
        '--regex',
        String.raw`API_KEY=[^\s]+`,
        '--replacement',
        '[REMOVED]',
        '--origin',
        secretOrigin,
        '--reason',
        secretReason,
      ],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        redactSession: async (input) => {
          expect(input).toMatchObject({
            id: 'session-id',
            origin: secretOrigin,
            reason: secretReason,
            workspaceId: 'workspace-id',
          });
          expect(input.patterns).toStrictEqual([
            { kind: 'literal', pattern: 'secret-token', replacement: '[REMOVED]' },
            { kind: 'literal', pattern: 'second-secret', replacement: '[REMOVED]' },
            {
              flags: undefined,
              kind: 'regex',
              pattern: 'API_KEY=[^\\s]+',
              replacement: '[REMOVED]',
            },
          ]);
          return redactResult();
        },
      },
    );

    expect(output).toContain('Session redacted');
    expect(output).toContain('replacements');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('second-secret');
    expect(output).not.toContain('API_KEY=');
    expect(output).not.toContain(secretOrigin);
    expect(output).not.toContain(secretReason);
  });

  it('surfaces invalid regex redaction errors without echoing the supplied pattern', async () => {
    const projectRoot = boundProject();
    const secretNeedle = 'cli-regex-secret-token';
    const rawPattern = `${secretNeedle}(`;

    await expect(
      runSessionsCommand(['redact', 'session-id', '--regex', rawPattern], renderOptions, {
        cwd: projectRoot,
        redactSession: async (input) => {
          expect(input.patterns).toStrictEqual([
            {
              flags: undefined,
              kind: 'regex',
              pattern: rawPattern,
              replacement: '[REDACTED]',
            },
          ]);
          throw new SessionSafetyError({
            message: 'invalid redaction regex pattern at index 1: invalid syntax',
          });
        },
      }),
    ).rejects.toThrow('invalid redaction regex pattern at index 1: invalid syntax');

    let errorText: string | undefined;
    try {
      await runSessionsCommand(['redact', 'session-id', '--regex', rawPattern], renderOptions, {
        cwd: projectRoot,
        redactSession: async () => {
          throw new SessionSafetyError({
            message: 'invalid redaction regex pattern at index 1: invalid syntax',
          });
        },
      });
    } catch (cause) {
      errorText = String(cause);
    }

    expect(errorText).toBeDefined();
    expect(errorText).toContain('invalid redaction regex pattern');
    expect(errorText).not.toContain(secretNeedle);
    expect(errorText).not.toContain(rawPattern);
    expect(errorText).not.toContain(`/${rawPattern}/`);
  });

  it('omits free-form redaction audit text from json output', async () => {
    const projectRoot = boundProject();
    const secretOrigin = 'json-redact-origin-secret-token';
    const secretReason = 'json-redact-reason-secret-token';
    const output = await runSessionsCommand(
      [
        'redact',
        'session-id',
        '--literal',
        'secret-token',
        '--origin',
        secretOrigin,
        '--reason',
        secretReason,
      ],
      renderOptions,
      {
        cwd: projectRoot,
        redactSession: async () => redactResult(),
      },
    );

    expect(JSON.parse(output)).toMatchObject({
      operation: 'redacted',
      originClassification: 'custom',
      reasonProvided: true,
    });
    expect(output).not.toContain(secretOrigin);
    expect(output).not.toContain(secretReason);
    expect(output).not.toContain('secret-token');
  });

  it('shows a bounded session detail with Activity Intervals, turns, segments, and metadata', async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(
      ['show', 'session-id', '--turns', '1', '--segments', '1', '--raw-records', '2', '--raw-body'],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        getDetail: async (input) => {
          expect(input).toMatchObject({
            id: 'session-id',
            includeRawBody: true,
            maxRawRecords: 2,
            maxSegmentsPerTurn: 1,
            maxTurns: 1,
            workspaceId: 'workspace-id',
          });
          return sessionDetail();
        },
      },
    );

    expect(output).toContain('Session');
    expect(output).toContain('Raw Session Record');
    expect(output).toContain('Activity Interval 0');
    expect(output).toContain('Turn 0');
    expect(output).toContain('Segment 0');
    expect(output).toContain('host-user');
    expect(output).toContain('provenance');
    expect(output).toContain('Bounds');
    expect(output).toContain('[local-path-redacted]');
    expect(output).not.toContain('/tmp/session.jsonl');
    expect(output).not.toContain('/Users/example/.codex/transcripts/session.jsonl');
    expect(output).not.toContain('file:///Users/example/.codex/transcripts/session.jsonl');
    expect(output).not.toContain('/work/saga');
    expect(output).not.toContain('file://');
  });

  it('redacts local paths from sessions show structured segment text', async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(['show', 'session-id'], renderOptions, {
      cwd: projectRoot,
      getDetail: async () => sessionDetail(),
    });

    expect(JSON.parse(output)).toMatchObject({
      activityIntervals: [
        {
          turns: [
            {
              segments: [
                {
                  searchText: 'Hello from [local-path-redacted] and [local-path-redacted]',
                  snippet: 'Hello from [local-path-redacted]',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(output).toContain('[local-path-redacted]');
    expect(output).not.toContain('/Users/example/.codex/transcripts/session.jsonl');
    expect(output).not.toContain('file:///Users/example/.codex/transcripts/session.jsonl');
  });

  it('omits raw body fields by default when showing session detail', async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(
      ['show', 'session-id'],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        getDetail: async (input) => {
          expect(input).toMatchObject({
            id: 'session-id',
            includeRawBody: false,
            workspaceId: 'workspace-id',
          });
          return sessionDetail();
        },
      },
    );

    expect(output).not.toContain('body text');
    expect(output).not.toContain('body json');
  });

  it('renders raw body fields only when requested', async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(
      ['show', 'session-id', '--raw-body'],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        getDetail: async (input) => {
          expect(input).toMatchObject({
            id: 'session-id',
            includeRawBody: true,
            workspaceId: 'workspace-id',
          });
          return sessionDetail({ includeRawBody: true });
        },
      },
    );

    expect(output).toContain('Raw Body Exposure');
    expect(output).toContain('WARNING');
    expect(output).toContain('body text');
    expect(output).toContain('raw transcript body');
    expect(output).toContain('body json');
    expect(output).toContain('raw-json-body');
    expect(output).toContain('raw body warning');
    expect(output).toContain('raw forensic body text');
    expect(output).toContain('raw forensic body json');
    expect(output).toContain('normal Saga surfaces hide');
  });

  it('keeps explicit raw forensic body fields raw in structured output', async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(['show', 'session-id', '--raw-body'], renderOptions, {
      cwd: projectRoot,
      getDetail: async () => sessionDetail({ includeRawBody: true }),
    });

    const parsed = JSON.parse(output);
    expect(parsed.rawSessionRecords[0]).toMatchObject({
      rawBodyExposure: {
        mode: 'raw_forensic',
        requestedBy: 'includeRawBody',
      },
    });
    expect(parsed.rawSessionRecords[0].rawBodyExposure.warning).toContain(
      'normal Saga surfaces hide',
    );
    expect(parsed.rawSessionRecords[0].bodyText).toContain('/Users/example/raw/session.jsonl');
    expect(parsed.rawSessionRecords[0].bodyJson.path).toBe('/Users/example/raw/session.jsonl');
    expect(parsed.session.sourceLocator).toBe('[local-path-redacted]');
    expect(JSON.stringify(parsed.activityIntervals)).not.toContain(
      '/Users/example/.codex/transcripts/session.jsonl',
    );
  });

  it.each([
    ['missing warning', { mode: 'raw_forensic', requestedBy: 'includeRawBody' }],
    ['blank warning', { mode: 'raw_forensic', requestedBy: 'includeRawBody', warning: '   ' }],
    [
      'missing requestedBy',
      {
        mode: 'raw_forensic',
        warning:
          'Explicit raw forensic access: bodyText/bodyJson are persisted raw session bodies and may include skipped, omitted, local, or sensitive content that normal Saga surfaces hide.',
      },
    ],
  ])(
    'does not restore raw forensic body fields in structured output with %s metadata',
    async (_name, rawBodyExposure) => {
      const projectRoot = boundProject();
      const detail = sessionDetail({ includeRawBody: true });
      const rawRecord = detail.rawSessionRecords[0];
      if (rawRecord === undefined) {
        throw new Error('missing raw session record');
      }
      rawRecord.rawBodyExposure = rawBodyExposure as NonNullable<
        SessionRawSessionRecordMetadata['rawBodyExposure']
      >;

      const output = await runSessionsCommand(['show', 'session-id', '--raw-body'], renderOptions, {
        cwd: projectRoot,
        getDetail: async () => detail,
      });

      const parsed = JSON.parse(output);
      expect(parsed.rawSessionRecords[0].bodyText).toContain('[local-path-redacted]');
      expect(parsed.rawSessionRecords[0].bodyJson.path).toBe('[local-path-redacted]');
      expect(parsed.rawSessionRecords[0].bodyText).not.toContain(
        '/Users/example/raw/session.jsonl',
      );
      expect(parsed.rawSessionRecords[0].bodyJson.path).not.toBe(
        '/Users/example/raw/session.jsonl',
      );
    },
  );

  it('renders the bounded raw session snapshot list without duplicate active or selected blocks', async () => {
    const projectRoot = boundProject();
    const output = await runSessionsCommand(
      ['show', 'session-id', '--raw-records', '2'],
      {
        ...renderOptions,
        format: 'records',
      },
      {
        cwd: projectRoot,
        getDetail: async (input) => {
          expect(input).toMatchObject({
            id: 'session-id',
            maxRawRecords: 2,
            workspaceId: 'workspace-id',
          });
          return sessionDetailWithRawRecords();
        },
      },
    );

    expect(countOccurrences(output, 'Raw Session Record')).toBe(2);
    expect(output).not.toContain('Active Raw Session Record');
    expect(output).not.toContain('Selected Raw Session Record');
    expect(output).toContain('raw-record-id');
    expect(output).toContain('raw-record-older');
  });

  it('does not backfill host into a no-host binding for sessions recent', async () => {
    const projectRoot = boundProjectWithoutHost();
    const before = readFileSync(join(projectRoot, BINDING_FILE_NAME), 'utf8');

    await runSessionsCommand(['recent'], renderOptions, {
      cwd: projectRoot,
      listRecent: async (input) => {
        expect(input).toMatchObject({
          workspaceId: 'workspace-id',
        });
        return [];
      },
    });

    expect(readFileSync(join(projectRoot, BINDING_FILE_NAME), 'utf8')).toBe(before);
  });

  it('does not backfill host into a no-host binding for sessions show', async () => {
    const projectRoot = boundProjectWithoutHost();
    const before = readFileSync(join(projectRoot, BINDING_FILE_NAME), 'utf8');

    await runSessionsCommand(['show', 'session-id'], renderOptions, {
      cwd: projectRoot,
      getDetail: async (input) => {
        expect(input).toMatchObject({
          id: 'session-id',
          workspaceId: 'workspace-id',
        });
        return sessionDetail();
      },
    });

    expect(readFileSync(join(projectRoot, BINDING_FILE_NAME), 'utf8')).toBe(before);
  });
});

function boundProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saga-sessions-'));
  writeBindingFile(projectRoot, {
    host: {
      generatedAt: '2026-06-22T00:00:00.000Z',
      id: 'host-id',
      label: 'test-host',
    },
    project: {
      gitRemote: undefined,
      root: projectRoot,
    },
    schemaVersion: 1,
    service: {
      databaseUrl: 'environment',
    },
    sourceBinding: {
      id: 'source-id',
    },
    workspace: {
      handle: 'saga',
      id: 'workspace-id',
    },
  });
  return projectRoot;
}

function boundProjectWithoutHost(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saga-sessions-no-host-'));
  writeFileSync(
    join(projectRoot, BINDING_FILE_NAME),
    `${JSON.stringify(
      {
        project: {
          root: projectRoot,
        },
        schemaVersion: 1,
        service: {
          databaseUrl: 'environment',
        },
        sourceBinding: {
          id: 'source-id',
        },
        workspace: {
          handle: 'saga',
          id: 'workspace-id',
        },
      },
      null,
      2,
    )}\n`,
  );
  return projectRoot;
}

function importResult(input: RawSessionImportInput): RawSessionImportResult {
  const capturedAt = new Date('2026-06-22T10:00:00.000Z');
  return {
    activityInterval: {
      createdAt: capturedAt,
      endedAt: null,
      id: 'activity-interval-id',
      metadata: {},
      ordinal: 0,
      sessionId: 'session-id',
      settledAt: null,
      settlementReason: null,
      settlementTriggerRawEventId: null,
      startedAt: capturedAt,
      status: 'active',
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
    authorUser: {
      createdAt: capturedAt,
      displayName: input.author.displayName ?? null,
      externalSubject: input.host.id,
      handle: input.author.handle,
      id: 'user-id',
      identitySource: 'host',
      metadata: {},
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
    contentHash: 'sha256:test',
    operation: 'inserted',
    rawSessionRecord: {
      activityIntervalId: 'activity-interval-id',
      authorUserId: 'user-id',
      bodyJson: null,
      bodyText: input.rawContent,
      capturedAt,
      contentBytes: Buffer.byteLength(input.rawContent, 'utf8'),
      contentHash: 'sha256:test',
      contentType: input.contentType,
      createdAt: capturedAt,
      harness: input.harness,
      harnessSessionId: input.harnessSessionId ?? null,
      id: 'raw-record-id',
      isActive: true,
      metadata: input.metadata ?? {},
      provenance: input.provenance ?? {},
      redactedFromRawSessionRecordId: null,
      sessionId: 'session-id',
      snapshotOrdinal: 0,
      sourceBindingId: 'source-binding-id',
      sourceLocator: input.locator ?? null,
      status: 'captured',
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
    session: {
      authorUserId: 'user-id',
      createdAt: capturedAt,
      endedAt: null,
      harness: input.harness,
      harnessSessionId: input.harnessSessionId ?? null,
      id: 'session-id',
      lastActivityAt: capturedAt,
      metadata: {},
      model: input.model ?? null,
      provenance: {},
      sourceBindingId: 'source-binding-id',
      sourceLocator: input.locator ?? null,
      sourceLocatorHash: null,
      startedAt: capturedAt,
      status: input.status ?? 'active',
      title: input.title ?? null,
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
    sourceBinding: {
      config: {},
      createdAt: capturedAt,
      displayName: 'Codex on test-host',
      enabled: true,
      id: 'source-binding-id',
      sourceType: input.harness,
      sourceUri: `${input.harness}://host/${input.host.id}`,
      updatedAt: capturedAt,
      workspaceId: input.workspaceId,
    },
  };
}

function recentRecord(): RecentSessionRecord {
  const capturedAt = new Date('2026-06-22T10:00:00.000Z');
  return {
    activityInterval: {
      endedAt: null,
      id: 'activity-interval-id',
      metadata: {},
      ordinal: 0,
      sessionId: 'session-id',
      settledAt: null,
      settlementReason: null,
      startedAt: capturedAt,
      status: 'active',
    },
    authorUser: {
      displayName: 'Drew',
      externalSubject: 'host-id',
      handle: 'drew',
      id: 'user-id',
      identitySource: 'host',
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
      contentHash: 'sha256:test',
      contentType: 'jsonl',
      harness: 'codex',
      harnessSessionId: 'codex-session-1',
      id: 'raw-record-id',
      isActive: true,
      metadata: {},
      provenance: {
        importedBy: 'test',
        transcriptPath: '/tmp/session.jsonl',
        transcriptUri: 'file:///tmp/session.jsonl',
      },
      sessionId: 'session-id',
      snapshotOrdinal: 0,
      sourceLocator: 'file:///tmp/session.jsonl',
      status: 'captured',
    },
    session: {
      endedAt: null,
      harness: 'codex',
      harnessSessionId: 'codex-session-1',
      id: 'session-id',
      lastActivityAt: capturedAt,
      metadata: {},
      model: 'gpt-5',
      provenance: {},
      sourceBindingId: 'source-binding-id',
      sourceLocator: 'file:///tmp/session.jsonl',
      startedAt: capturedAt,
      status: 'active',
      title: null,
      workspaceId: 'workspace-id',
    },
    sourceBinding: {
      config: {
        projectRoot: '/work/saga',
      },
      displayName: 'Codex on test-host',
      enabled: true,
      id: 'source-binding-id',
      sourceType: 'codex',
      sourceUri: 'codex://host/host-id',
    },
  };
}

function deleteResult(): DeleteSessionSafetyResult {
  return {
    deleted: {
      consolidationDispositions: 0,
      consolidationEvidencePointers: 0,
      consolidationFindings: 0,
      consolidationRecords: 0,
      embeddings: 0,
      rawEvents: 1,
      rawSessionRecords: 1,
      segments: 2,
      turns: 2,
    },
    deletedAt: new Date('2026-06-22T10:05:00.000Z'),
    operation: 'deleted',
    originClassification: 'cli',
    reasonProvided: true,
    sessionId: 'session-id',
    workspaceId: 'workspace-id',
  };
}

function redactResult(): RedactSessionSafetyResult {
  const rawImport = importResult({
    author: {
      displayName: 'Drew',
      handle: 'drew',
    },
    contentType: 'jsonl',
    harness: 'codex',
    harnessSessionId: 'codex-session-1',
    host: {
      id: 'host-id',
      label: 'test-host',
      projectRoot: '/work/saga',
    },
    rawContent: 'redacted body',
    workspaceId: 'workspace-id',
  });
  return {
    operation: 'redacted',
    originClassification: 'custom',
    patternCount: 3,
    previousRawSessionRecordId: 'raw-record-old',
    rawSessionImport: {
      ...rawImport,
      rawSessionRecord: {
        ...rawImport.rawSessionRecord,
        id: 'raw-record-redacted',
        redactedFromRawSessionRecordId: 'raw-record-old',
        snapshotOrdinal: 1,
        status: 'redacted',
      },
    },
    reasonProvided: true,
    redactedAt: new Date('2026-06-22T10:06:00.000Z'),
    redactedRawEvents: 1,
    replacementCount: 4,
    sessionId: 'session-id',
    workspaceId: 'workspace-id',
  };
}

function sessionDetail(input: { includeRawBody?: boolean } = {}): SessionDetail {
  const row = recentRecord();
  const rawSessionRecord: SessionRawSessionRecordMetadata =
    input.includeRawBody === true
      ? {
          ...row.rawSessionRecord,
          bodyJson: {
            path: '/Users/example/raw/session.jsonl',
            value: 'raw-json-body',
          },
          bodyText: 'raw transcript body /Users/example/raw/session.jsonl skipped-secret-needle',
          rawBodyExposure: {
            mode: 'raw_forensic',
            requestedBy: 'includeRawBody',
            warning:
              'Explicit raw forensic access: bodyText/bodyJson are persisted raw session bodies and may include skipped, omitted, local, or sensitive content that normal Saga surfaces hide.',
          },
        }
      : row.rawSessionRecord;
  return {
    activeRawSessionRecord: rawSessionRecord,
    activityIntervals: [
      {
        activityInterval: row.activityInterval ?? {
          endedAt: null,
          id: 'activity-interval-id',
          metadata: {},
          ordinal: 0,
          sessionId: 'session-id',
          settledAt: null,
          settlementReason: null,
          startedAt: new Date('2026-06-22T10:00:00.000Z'),
          status: 'active',
        },
        turns: [
          {
            contentParts: [
              {
                type: 'text',
                text: 'Hello from /Users/example/.codex/transcripts/session.jsonl',
              },
            ],
            endedAt: null,
            metadata: {
              cwd: '/work/saga',
            },
            rawEventIds: [],
            rawSpan: {},
            segments: [
              {
                charEnd: 108,
                charStart: 0,
                id: 'segment-id',
                metadata: {},
                ordinal: 0,
                searchText:
                  'Hello from /Users/example/.codex/transcripts/session.jsonl and file:///Users/example/.codex/transcripts/session.jsonl',
                segmentKind: 'turn',
                snippet: 'Hello from /Users/example/.codex/transcripts/session.jsonl',
                tokenEnd: 1,
                tokenStart: 0,
              },
            ],
            startedAt: new Date('2026-06-22T10:00:00.000Z'),
            turn: {
              actorKind: 'host_user',
              actorLabel: 'drew',
              harnessTurnId: 'turn-1',
              id: 'turn-id',
              model: 'gpt-5',
              ordinal: 0,
              role: 'user',
            },
          },
        ],
      },
    ],
    authorUser: row.authorUser,
    limits: {
      includeRawBody: input.includeRawBody === true,
      maxRawRecords: 10,
      maxSegmentsPerTurn: 1,
      maxTurns: 1,
    },
    rawSessionRecords: [rawSessionRecord],
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
  if (detail.activeRawSessionRecord === null) {
    throw new Error('missing active raw record');
  }
  const olderRawRecord = {
    ...detail.activeRawSessionRecord,
    capturedAt: new Date('2026-06-22T09:55:00.000Z'),
    contentHash: 'sha256:older',
    id: 'raw-record-older',
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
