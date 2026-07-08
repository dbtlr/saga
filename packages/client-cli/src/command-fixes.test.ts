import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SagaApiClient } from '@saga/api-client';
import { describe, expect, it } from 'vitest';

import { parseLocalOptions } from './command-args.js';
import { doctorProject } from './doctor.js';
import { ingestClaudeHook, ingestCodexHook } from './ingest.js';
import { runRecallCommand } from './recall.js';

const RECORDS_OPTIONS = {
  ascii: true,
  color: 'never',
  format: 'records',
  isTty: false,
} as const;

// Regression: a hook parse failure (non-empty, invalid JSON on stdin) must honor
// the harness { continue: true } contract and the skip systemMessage form —
// NOT throw / exit 1. The parse used to run OUTSIDE the capture guard.
describe('ingest hook parse failure honors the harness contract', () => {
  it('returns { continue: true } with a skip message for the claude hook', async () => {
    const output = await ingestClaudeHook(RECORDS_OPTIONS, {}, { stdin: 'not json{' });
    const parsed = JSON.parse(output) as { continue: boolean; systemMessage?: string };
    expect(parsed.continue).toBe(true);
    expect(parsed.systemMessage).toContain('Saga Claude Code capture skipped:');
  });

  it('returns { continue: true } with a skip message for the codex hook', async () => {
    const output = await ingestCodexHook(RECORDS_OPTIONS, {}, { stdin: 'not json{' });
    const parsed = JSON.parse(output) as { continue: boolean; systemMessage?: string };
    expect(parsed.continue).toBe(true);
    expect(parsed.systemMessage).toContain('Saga Codex capture skipped:');
  });
});

// Regression: the recall command now renders the service-supplied posture
// (result.search). A response missing that field — an older/skewed service — must
// degrade to a lexical render, not crash dereferencing an undefined posture.
describe('recall search tolerates a response without a posture (version skew)', () => {
  it('renders lexical instead of throwing when the service omits `search`', async () => {
    const recallResult = {
      intervals: [],
      matchCount: 0,
      query: 'q',
      searchedAt: '2026-06-21T14:00:00.000Z',
      sessions: [],
      workspaceId: 'ws-1',
      // no `search` field — a pre-SGA-253 service or a skewed deployment
    };
    const partialClient = { recall: async () => recallResult } as unknown as SagaApiClient;

    const output = await runRecallCommand(['search', 'q'], RECORDS_OPTIONS, {
      client: partialClient,
      workspaceId: 'ws-1',
    });

    expect(output).toContain('lexical');
  });
});

// Regression: an inline flag value containing '=' must be preserved in full.
describe('parseLocalOptions keeps "=" in inline values', () => {
  it('does not truncate --session-id=a=b=c', () => {
    const parsed = parseLocalOptions(['--session-id=a=b=c'], {
      booleanFlags: new Set(),
      flagsWithValues: new Set(['session-id']),
      noun: 'recall',
    });
    expect(parsed.flags['session-id']).toBe('a=b=c');
  });
});

// Regression: a 200 response with a missing/partial ServiceInfo body must yield a
// clean fail `service` check, not a thrown TypeError from reading undefined
// migrations/extraction outside the guard.
describe('doctor handles a partial ServiceInfo body', () => {
  it('renders a fail service check without throwing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-doctor-partial-'));
    const home = mkdtempSync(join(tmpdir(), 'saga-doctor-home-'));
    const partialClient = { info: async () => ({}) } as unknown as SagaApiClient;

    const checks = await doctorProject(
      { client: partialClient, cwd },
      { configOptions: { homeDir: home } },
    );

    const service = checks.find((check) => check.label === 'service');
    expect(service).toBeDefined();
    expect(service?.status).toBe('fail');
  });
});
