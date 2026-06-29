import { describe, expect, it } from 'vitest';

import {
  redactAgentFacingSessionText,
  redactAgentFacingSourceLocator,
} from './session-output-redaction.js';

describe('session output redaction', () => {
  it('redacts local transcript paths with spaces and UNC paths', () => {
    const redacted = redactAgentFacingSessionText(
      [
        'posix=/Users/Drew Smith/.codex/transcripts/session.jsonl',
        String.raw`windows=C:\Users\Drew Smith\.codex\transcripts\session.jsonl`,
        String.raw`unc=\\server\share\Users\drew\.codex\transcripts\session.jsonl`,
        'file=file:///Users/Drew Smith/.codex/transcripts/session.jsonl',
      ].join('\n'),
    );

    expect(redacted).toContain('posix=[local-path-redacted]');
    expect(redacted).toContain('windows=[local-path-redacted]');
    expect(redacted).toContain('unc=[local-path-redacted]');
    expect(redacted).toContain('file=[local-path-redacted]');
    expect(redacted).not.toContain('/Users/Drew Smith');
    expect(redacted).not.toContain(String.raw`C:\Users\Drew Smith`);
    expect(redacted).not.toContain(String.raw`\\server\share`);
    expect(redacted).not.toContain('file://');
  });

  it('redacts directory roots and extensionless paths with spaces', () => {
    const redacted = redactAgentFacingSessionText(
      [
        'root=/Users/Drew Smith/Workspaces/saga',
        'spaced project=/Users/Drew Smith/Workspaces/My Project',
        String.raw`win noext=C:\Users\Drew Smith\.codex\transcripts\session`,
        String.raw`win spaced=C:\Users\Drew Smith\Workspaces\My Project`,
        String.raw`unc noext=\\server\share\Users\drew\.codex\transcripts\session`,
        'file root=file:///Users/Drew Smith/Workspaces/saga',
        'file spaced=file:///Users/Drew Smith/Workspaces/My Project',
      ].join('\n'),
    );

    expect(redacted).toContain('root=[local-path-redacted]');
    expect(redacted).toContain('spaced project=[local-path-redacted]');
    expect(redacted).toContain('win noext=[local-path-redacted]');
    expect(redacted).toContain('win spaced=[local-path-redacted]');
    expect(redacted).toContain('unc noext=[local-path-redacted]');
    expect(redacted).toContain('file root=[local-path-redacted]');
    expect(redacted).toContain('file spaced=[local-path-redacted]');
    expect(redacted).not.toContain('/Users/Drew Smith');
    expect(redacted).not.toContain(String.raw`C:\Users\Drew Smith`);
    expect(redacted).not.toContain(String.raw`\\server\share`);
    expect(redacted).not.toContain('file://');
  });

  it('preserves safe agent-facing URI schemes', () => {
    const redacted = redactAgentFacingSessionText(
      [
        'https://example.test/Users/Drew%20Smith/session.jsonl',
        'codex://session/abc123',
        'github://repo/owner/name/pull/1',
        'norn://workspace/note',
        'mimir://task/SGA-141',
        'saga:context/session-provenance',
      ].join(' '),
    );

    expect(redacted).toContain('https://example.test/Users/Drew%20Smith/session.jsonl');
    expect(redacted).toContain('codex://session/abc123');
    expect(redacted).toContain('github://repo/owner/name/pull/1');
    expect(redacted).toContain('norn://workspace/note');
    expect(redacted).toContain('mimir://task/SGA-141');
    expect(redacted).toContain('saga:context/session-provenance');
    expect(redacted).not.toContain('[local-path-redacted]');
  });

  it('preserves safe agent-facing source locators', () => {
    expect(redactAgentFacingSourceLocator('https://example.test/session/abc123')).toBe(
      'https://example.test/session/abc123',
    );
    expect(redactAgentFacingSourceLocator('codex://session/abc123')).toBe('codex://session/abc123');
    expect(redactAgentFacingSourceLocator('github://repo/owner/name/pull/1')).toBe(
      'github://repo/owner/name/pull/1',
    );
    expect(redactAgentFacingSourceLocator('norn://workspace/note')).toBe('norn://workspace/note');
    expect(redactAgentFacingSourceLocator('mimir://task/SGA-141')).toBe('mimir://task/SGA-141');
    expect(redactAgentFacingSourceLocator('saga:context/session-provenance')).toBe(
      'saga:context/session-provenance',
    );
  });

  it('nulls unsafe local and file source locators', () => {
    expect(redactAgentFacingSourceLocator(null)).toBeNull();
    expect(
      redactAgentFacingSourceLocator('file:///Users/Drew Smith/.codex/session.jsonl'),
    ).toBeNull();
    expect(redactAgentFacingSourceLocator('/Users/Drew Smith/.codex/session.jsonl')).toBeNull();
    expect(
      redactAgentFacingSourceLocator(String.raw`C:\Users\Drew Smith\.codex\session.jsonl`),
    ).toBeNull();
    expect(
      redactAgentFacingSourceLocator(String.raw`\\server\share\Users\drew\.codex\session.jsonl`),
    ).toBeNull();
    expect(
      redactAgentFacingSourceLocator(
        'https://example.test/session/abc123 /Users/Drew Smith/.codex/session.jsonl',
      ),
    ).toBeNull();
  });
});
