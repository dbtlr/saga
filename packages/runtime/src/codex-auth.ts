import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type CodexAuthFileSource = 'codex-home' | 'user-home';
export type CodexAuthMode =
  | 'api-key'
  | 'login'
  | 'missing'
  | 'malformed'
  | 'unreadable'
  | 'unknown';
export type CodexAuthUnavailableReason =
  | 'missing-auth-file'
  | 'login-without-api-key'
  | 'malformed-auth-file'
  | 'unreadable-auth-file'
  | 'openai-api-key-missing';

export type CodexAuthFileCandidate = {
  displayPath: string;
  path: string;
  source: CodexAuthFileSource;
};

export type CodexAuthResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readFile?: (path: string) => string;
};

export type CodexAuthAvailable = {
  authFile: string;
  checkedFiles: readonly CodexAuthFileCandidate[];
  detail: string;
  displayPath: string;
  guidance: string;
  mode: 'api-key';
  openaiApiKey: string;
  source: CodexAuthFileSource;
  status: 'available';
};

export type CodexAuthUnavailable = {
  checkedFiles: readonly CodexAuthFileCandidate[];
  detail: string;
  guidance: string;
  mode: Exclude<CodexAuthMode, 'api-key'>;
  reason: CodexAuthUnavailableReason;
  status: 'unavailable';
};

export type CodexAuthStatus = CodexAuthAvailable | CodexAuthUnavailable;

const OPENAI_API_KEY = 'OPENAI_API_KEY';
const LOGIN_INDICATOR_KEYS = new Set([
  'access_token',
  'account',
  'account_id',
  'accounts',
  'auth_method',
  'email',
  'id_token',
  'login',
  'refresh_token',
  'tokens',
  'user',
]);

export function codexAuthFileCandidates(
  options: CodexAuthResolutionOptions = {},
): readonly CodexAuthFileCandidate[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const candidates: CodexAuthFileCandidate[] = [];
  const seen = new Set<string>();

  const codexHome = optionalString(env.CODEX_HOME);
  if (codexHome !== undefined) {
    addCandidate(candidates, seen, {
      displayPath: 'CODEX_HOME/auth.json',
      path: resolve(codexHome, 'auth.json'),
      source: 'codex-home',
    });
  }

  addCandidate(candidates, seen, {
    displayPath: '~/.codex/auth.json',
    path: resolve(home, '.codex', 'auth.json'),
    source: 'user-home',
  });

  return candidates;
}

export function resolveCodexAuth(options: CodexAuthResolutionOptions = {}): CodexAuthStatus {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const checkedFiles = codexAuthFileCandidates(options);
  let fallbackUnavailable: CodexAuthUnavailable | undefined;

  for (const candidate of checkedFiles) {
    let rawAuth: string;
    try {
      rawAuth = readFile(candidate.path);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      return unavailable({
        checkedFiles,
        detail: `could not read ${candidate.displayPath}: ${errorMessage(error)}`,
        guidance:
          'Embedding generation is skipped; fix Codex auth file permissions or remove the unreadable file. Lexical recall remains available.',
        mode: 'unreadable',
        reason: 'unreadable-auth-file',
      });
    }

    const parsed = parseAuthJson(rawAuth);
    if (parsed.status === 'malformed') {
      return unavailable({
        checkedFiles,
        detail: `could not parse ${candidate.displayPath}`,
        guidance:
          'Embedding generation is skipped; repair Codex auth or provide valid embedding credentials. Lexical recall remains available.',
        mode: 'malformed',
        reason: 'malformed-auth-file',
      });
    }

    const apiKey = readOpenAiApiKey(parsed.value);
    if (apiKey !== undefined) {
      return {
        authFile: candidate.path,
        checkedFiles,
        detail: `cached OPENAI_API_KEY found in ${candidate.displayPath}`,
        displayPath: candidate.displayPath,
        guidance:
          'OpenAI embeddings can use the cached Codex OPENAI_API_KEY. Saga will not refresh or rewrite Codex credentials.',
        mode: 'api-key',
        openaiApiKey: apiKey,
        source: candidate.source,
        status: 'available',
      };
    }

    if (hasLoginIndicators(parsed.value)) {
      fallbackUnavailable = mostRelevantUnavailable(
        fallbackUnavailable,
        unavailable({
          checkedFiles,
          detail: `Codex login/account tokens found in ${candidate.displayPath}, but no cached OPENAI_API_KEY is present`,
          guidance:
            'Embedding generation needs a cached OPENAI_API_KEY in Codex auth. Login/account tokens are read-only and will not be refreshed or rewritten. Lexical recall remains available.',
          mode: 'login',
          reason: 'login-without-api-key',
        }),
      );
      continue;
    }

    fallbackUnavailable = mostRelevantUnavailable(
      fallbackUnavailable,
      unavailable({
        checkedFiles,
        detail: `${candidate.displayPath} does not contain a cached OPENAI_API_KEY`,
        guidance:
          'Embedding generation is skipped until Codex auth includes OPENAI_API_KEY. Lexical recall remains available.',
        mode: 'unknown',
        reason: 'openai-api-key-missing',
      }),
    );
  }

  if (fallbackUnavailable !== undefined) {
    return fallbackUnavailable;
  }

  return unavailable({
    checkedFiles,
    detail: `no Codex auth file found; checked ${checkedFiles.map((file) => file.displayPath).join(', ')}`,
    guidance:
      'Embedding generation is skipped until Codex auth includes a cached OPENAI_API_KEY. Lexical recall remains available.',
    mode: 'missing',
    reason: 'missing-auth-file',
  });
}

function addCandidate(
  candidates: CodexAuthFileCandidate[],
  seen: Set<string>,
  candidate: CodexAuthFileCandidate,
): void {
  if (seen.has(candidate.path)) {
    return;
  }
  seen.add(candidate.path);
  candidates.push(candidate);
}

function unavailable(input: Omit<CodexAuthUnavailable, 'status'>): CodexAuthUnavailable {
  return {
    ...input,
    status: 'unavailable',
  };
}

function mostRelevantUnavailable(
  current: CodexAuthUnavailable | undefined,
  candidate: CodexAuthUnavailable,
): CodexAuthUnavailable {
  if (current === undefined) {
    return candidate;
  }
  return unavailableRank(candidate) > unavailableRank(current) ? candidate : current;
}

function unavailableRank(status: CodexAuthUnavailable): number {
  switch (status.reason) {
    case 'login-without-api-key': {
      return 3;
    }
    case 'openai-api-key-missing': {
      return 2;
    }
    case 'missing-auth-file': {
      return 1;
    }
    case 'malformed-auth-file':
    case 'unreadable-auth-file': {
      return 0;
    }
  }
}

function parseAuthJson(rawAuth: string):
  | {
      status: 'ok';
      value: unknown;
    }
  | {
      status: 'malformed';
    } {
  try {
    return {
      status: 'ok',
      value: JSON.parse(rawAuth) as unknown,
    };
  } catch {
    return {
      status: 'malformed',
    };
  }
}

function readOpenAiApiKey(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const apiKey = value[OPENAI_API_KEY];
  return typeof apiKey === 'string' ? optionalString(apiKey) : undefined;
}

function hasLoginIndicators(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasLoginIndicators(item, depth + 1));
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (LOGIN_INDICATOR_KEYS.has(key.toLowerCase())) {
      return true;
    }
    if (hasLoginIndicators(nestedValue, depth + 1)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
