import { readFileSync } from 'node:fs';

import { codexAuthFileCandidates } from './codex-auth.js';
import type {
  CodexAuthFileCandidate,
  CodexAuthFileSource,
  CodexAuthResolutionOptions,
} from './codex-auth.js';
import { isRecord, optionalString, walkCodexAuthFiles } from './internal/credential-io.js';

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

  // First-readable-wins is deliberate and matches the Codex CLI: when CODEX_HOME is set, its
  // auth.json is authoritative and the default ~/.codex is not consulted. So a non-ChatGPT
  // CODEX_HOME auth file fails here even if ~/.codex holds a valid ChatGPT login — CODEX_HOME
  // is exclusive, not a first tier of a fallback chain. Every readable candidate is therefore
  // terminal (onParsed always resolves); only a missing file continues to the next candidate.
  return walkCodexAuthFiles<CodexAuthFileCandidate, CodexInferenceAuthStatus>(
    candidates,
    readFile,
    {
      onExhausted: () => ({
        detail: `no Codex auth file found; checked ${candidates.map((file) => file.displayPath).join(', ')}`,
        reason: 'missing-auth-file',
        status: 'unavailable',
      }),
      // Never echo raw auth text: it holds bearer tokens.
      onMalformed: (_candidate, message) => ({
        detail: message,
        reason: 'malformed-auth-file',
        status: 'unavailable',
      }),
      onParsed: (parsed, candidate) => extractChatGptAuth(parsed, candidate),
      onUnreadable: (_candidate, message) => ({
        detail: message,
        reason: 'unreadable-auth-file',
        status: 'unavailable',
      }),
    },
  );
}

function extractChatGptAuth(
  parsed: unknown,
  candidate: CodexAuthFileCandidate,
): CodexInferenceAuthStatus {
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
