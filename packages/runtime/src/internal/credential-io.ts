// Shared, internal-only building blocks for the credential/policy/auth readers. These are the
// single source of truth for the file-reading and value-guard logic that the embedding and
// inference modules would otherwise duplicate byte-for-byte and drift apart. NOT exported from
// the package barrel — import it directly from a sibling module.

// The OPENAI_API_KEY / OPENAI_API_KEY_FILE environment tier. A key is either supplied
// ('found'), not configured ('absent', a quiet skip), or configured-but-broken ('issue').
export type EnvApiKeyResult =
  | { apiKey: string; detail: string; displayPath: string; status: 'found' }
  | { issue: string; status: 'issue' }
  | { status: 'absent' };

export function readOpenAiApiKeyFromEnv(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): EnvApiKeyResult {
  const direct = optionalString(env.OPENAI_API_KEY);
  if (direct !== undefined) {
    return {
      apiKey: direct,
      detail: 'OPENAI_API_KEY present in the environment',
      displayPath: 'OPENAI_API_KEY',
      status: 'found',
    };
  }

  const filePath = optionalString(env.OPENAI_API_KEY_FILE);
  if (filePath === undefined) {
    return { status: 'absent' };
  }
  let contents: string;
  try {
    contents = readFile(filePath);
  } catch (error) {
    return {
      issue: `OPENAI_API_KEY_FILE could not be read: ${errorMessage(error)}`,
      status: 'issue',
    };
  }
  const value = optionalString(contents);
  if (value === undefined) {
    return { issue: `OPENAI_API_KEY_FILE points at an empty file (${filePath})`, status: 'issue' };
  }
  return {
    apiKey: value,
    detail: `OPENAI_API_KEY read from ${filePath} (OPENAI_API_KEY_FILE)`,
    displayPath: 'OPENAI_API_KEY_FILE',
    status: 'found',
  };
}

// The missing / unreadable / malformed trichotomy for the installation config, with the
// never-echo-raw-text guard baked in (a malformed config may hold secrets). Callers append
// their own policy-specific tail to the pre-built messages.
export type InstallationConfigRead =
  | { status: 'parsed'; value: unknown }
  | { status: 'missing' }
  | { message: string; status: 'unreadable' }
  | { message: string; status: 'malformed' };

export function readInstallationConfig(
  location: { displayPath: string; path: string },
  readFile: (path: string) => string,
): InstallationConfigRead {
  let raw: string;
  try {
    raw = readFile(location.path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: 'missing' };
    }
    return {
      message: `could not read ${location.displayPath}: ${errorMessage(error)}`,
      status: 'unreadable',
    };
  }

  try {
    return { status: 'parsed', value: JSON.parse(raw) as unknown };
  } catch {
    return { message: `could not parse ${location.displayPath}`, status: 'malformed' };
  }
}

// The Codex auth-file candidate walk: read → ENOENT-continue → unreadable/malformed
// classification, parameterized by field extraction. `onParsed` returns a terminal result to
// stop the walk, or undefined to continue to the next candidate; when the candidates are
// exhausted, `onExhausted` supplies the fallback.
export type CodexAuthWalkVisit<C, T> = {
  onExhausted: () => T;
  onMalformed: (candidate: C, message: string) => T;
  onParsed: (value: unknown, candidate: C) => T | undefined;
  onUnreadable: (candidate: C, message: string) => T;
};

export function walkCodexAuthFiles<C extends { displayPath: string; path: string }, T>(
  candidates: readonly C[],
  readFile: (path: string) => string,
  visit: CodexAuthWalkVisit<C, T>,
): T {
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = readFile(candidate.path);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      return visit.onUnreadable(
        candidate,
        `could not read ${candidate.displayPath}: ${errorMessage(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return visit.onMalformed(candidate, `could not parse ${candidate.displayPath}`);
    }

    const result = visit.onParsed(parsed, candidate);
    if (result !== undefined) {
      return result;
    }
  }
  return visit.onExhausted();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
