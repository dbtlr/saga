import { readFileSync } from 'node:fs';

import { codexAuthFileCandidates } from './codex-auth.js';
import type { CodexAuthFileSource, CodexAuthResolutionOptions } from './codex-auth.js';

// Read-only reuse of the Codex CLI's ChatGPT OAuth login at $CODEX_HOME/auth.json (default
// ~/.codex/auth.json). The subscription inference transport authenticates with the login's
// access token; Saga NEVER refreshes or writes these tokens back — refresh tokens are
// single-use/rotating, and a write-back would corrupt the Codex CLI's own copy. Expired
// credentials therefore surface as an HTTP 401 at call time, not here.
export type CodexInferenceAuthResolutionOptions = CodexAuthResolutionOptions;

export type CodexInferenceAuthUnavailableReason =
  | 'missing-auth-file'
  | 'unreadable-auth-file'
  | 'malformed-auth-file'
  | 'not-chatgpt-mode'
  | 'missing-access-token'
  | 'missing-account-id';

export type CodexInferenceAuthAvailable = {
  accessToken: string;
  accountId: string;
  authFile: string;
  detail: string;
  displayPath: string;
  source: CodexAuthFileSource;
  status: 'available';
};

export type CodexInferenceAuthUnavailable = {
  detail: string;
  reason: CodexInferenceAuthUnavailableReason;
  status: 'unavailable';
};

export type CodexInferenceAuthStatus = CodexInferenceAuthAvailable | CodexInferenceAuthUnavailable;

export function resolveCodexInferenceAuth(
  options: CodexInferenceAuthResolutionOptions = {},
): CodexInferenceAuthStatus {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const candidates = codexAuthFileCandidates(options);
  let sawFile = false;

  for (const candidate of candidates) {
    let rawAuth: string;
    try {
      rawAuth = readFile(candidate.path);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      return {
        detail: `could not read ${candidate.displayPath}: ${errorMessage(error)}`,
        reason: 'unreadable-auth-file',
        status: 'unavailable',
      };
    }

    sawFile = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawAuth) as unknown;
    } catch {
      // Never echo raw auth text: it holds bearer tokens.
      return {
        detail: `could not parse ${candidate.displayPath}`,
        reason: 'malformed-auth-file',
        status: 'unavailable',
      };
    }

    if (!isRecord(parsed) || parsed.auth_mode !== 'chatgpt') {
      return {
        detail: `${candidate.displayPath} is not a ChatGPT login (auth_mode is not "chatgpt")`,
        reason: 'not-chatgpt-mode',
        status: 'unavailable',
      };
    }

    const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
    const accessToken =
      tokens !== undefined && typeof tokens.access_token === 'string'
        ? optionalString(tokens.access_token)
        : undefined;
    if (accessToken === undefined) {
      return {
        detail: `${candidate.displayPath} has no tokens.access_token`,
        reason: 'missing-access-token',
        status: 'unavailable',
      };
    }

    const accountId =
      tokens !== undefined && typeof tokens.account_id === 'string'
        ? optionalString(tokens.account_id)
        : undefined;
    if (accountId === undefined) {
      return {
        detail: `${candidate.displayPath} has no tokens.account_id`,
        reason: 'missing-account-id',
        status: 'unavailable',
      };
    }

    return {
      accessToken,
      accountId,
      authFile: candidate.path,
      detail: `ChatGPT login tokens present in ${candidate.displayPath}`,
      displayPath: candidate.displayPath,
      source: candidate.source,
      status: 'available',
    };
  }

  return {
    detail: sawFile
      ? 'no readable Codex auth file found'
      : `no Codex auth file found; checked ${candidates.map((file) => file.displayPath).join(', ')}`,
    reason: 'missing-auth-file',
    status: 'unavailable',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
