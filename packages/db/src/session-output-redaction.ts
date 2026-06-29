type JsonRecord = Record<string, unknown>;

const LOCAL_PATH_REDACTION = '[local-path-redacted]';
const SAFE_URI_PATTERN =
  /\b(?:(?:https?|codex|github|norn|mimir):\/\/[^\s"',}\])]+|saga:(?!\/)[^\s"',}\])]+)/gu;
const SAFE_SOURCE_LOCATOR_PATTERN =
  /^(?:(?:https?|codex|github|norn|mimir):\/\/[^\s"',}\])]+|saga:(?!\/)[^\s"',}\])]+)$/u;
const LOCAL_FILE_URI_WITH_SPACES_PATTERN =
  /\bfile:\/\/[^=\r\n"',}\])]*\.[A-Za-z0-9][A-Za-z0-9._-]*(?=$|[\s"',}\])])/gu;
const LOCAL_FILE_URI_WITH_SPACES_BOUNDED_NO_EXTENSION_PATTERN =
  /(^|["'([{=,:])(file:\/\/\/?(?:[^/=\r\n"',}\])]+\/){1,}[^/=\r\n"',}\])]*[A-Za-z0-9._@%+-])(?=$|[\r\n"',}\])])/gu;
const LOCAL_FILE_URI_WITH_SPACES_NO_EXTENSION_PATTERN =
  /\bfile:\/\/\/?(?:[^/=\r\n"',}\])]+\/){1,}[A-Za-z0-9._@%+-]+(?=$|[\s"',}\])])/gu;
const LOCAL_FILE_URI_PATTERN = /\bfile:\/\/[^\s"',}\])]+/gu;
const POSIX_LOCAL_PATH_WITH_SPACES_PATTERN =
  /(^|[\s"'([{=,:])(\/(?!\/)(?=[A-Za-z0-9._@%+-])(?:[^/:=\r\n"',}\])]+\/){1,}[^/:=\r\n"',}\])]*\.[A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[\s"',}\])])/gu;
const POSIX_LOCAL_PATH_WITH_SPACES_BOUNDED_NO_EXTENSION_PATTERN =
  /(^|["'([{=,:])(\/(?!\/)(?=[A-Za-z0-9._@%+-])(?:[^/:=\r\n"',}\])]+\/){1,}[^/:=\r\n"',}\])]*[A-Za-z0-9._@%+-])(?=$|[\r\n"',}\])])/gu;
const POSIX_LOCAL_PATH_WITH_SPACES_NO_EXTENSION_PATTERN =
  /(^|[\s"'([{=,:])(\/(?!\/)(?=[A-Za-z0-9._@%+-])(?:[^/:=\r\n"',}\])]+\/){1,}[A-Za-z0-9._@%+-]+)(?=$|[\s"',}\])])/gu;
const POSIX_LOCAL_PATH_PATTERN =
  /(^|[\s"'([{=,:])(\/(?!\/)(?=[A-Za-z0-9._@%+-])(?:(?:[A-Za-z0-9._@%+-]+\/){1,}[A-Za-z0-9._@%+-]*|(?:home|work|Users|Volumes|private|tmp|var|opt|etc|usr|bin|sbin|lib|lib64|mnt|media|srv|run|root|nix|workspace|app|repo|repos|projects|builds)\b[^\s"',}\])]*))/gu;
const WINDOWS_LOCAL_PATH_WITH_SPACES_PATTERN =
  /(^|[\s"'([{=,:])([A-Za-z]:\\[^=\r\n"',}\])]*\.[A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[\s"',}\])])/gu;
const WINDOWS_LOCAL_PATH_WITH_SPACES_BOUNDED_NO_EXTENSION_PATTERN =
  /(^|["'([{=,:])([A-Za-z]:\\(?:[^\\=\r\n"',}\])]+\\){1,}[^\\=\r\n"',}\])]*[A-Za-z0-9._@%+-])(?=$|[\r\n"',}\])])/gu;
const WINDOWS_LOCAL_PATH_WITH_SPACES_NO_EXTENSION_PATTERN =
  /(^|[\s"'([{=,:])([A-Za-z]:\\(?:[^\\=\r\n"',}\])]+\\){1,}[A-Za-z0-9._@%+-]+)(?=$|[\s"',}\])])/gu;
const WINDOWS_LOCAL_PATH_PATTERN = /(^|[\s"'([{=,:])([A-Za-z]:\\[^\s"',}\])]+)/gu;
const WINDOWS_UNC_LOCAL_PATH_WITH_SPACES_PATTERN =
  /(^|[\s"'([{=,:])(\\\\[^\\=\r\n"',}\])]+\\[^\\=\r\n"',}\])]+\\[^=\r\n"',}\])]*\.[A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[\s"',}\])])/gu;
const WINDOWS_UNC_LOCAL_PATH_WITH_SPACES_BOUNDED_NO_EXTENSION_PATTERN =
  /(^|["'([{=,:])(\\\\[^\\=\r\n"',}\])]+\\[^\\=\r\n"',}\])]+\\(?:[^\\=\r\n"',}\])]+\\){0,}[^\\=\r\n"',}\])]*[A-Za-z0-9._@%+-])(?=$|[\r\n"',}\])])/gu;
const WINDOWS_UNC_LOCAL_PATH_WITH_SPACES_NO_EXTENSION_PATTERN =
  /(^|[\s"'([{=,:])(\\\\[^\\=\r\n"',}\])]+\\[^\\=\r\n"',}\])]+\\(?:[^\\=\r\n"',}\])]+\\){0,}[A-Za-z0-9._@%+-]+)(?=$|[\s"',}\])])/gu;
const WINDOWS_UNC_LOCAL_PATH_PATTERN =
  /(^|[\s"'([{=,:])(\\\\[^\\\s"',}\])]+\\[^\\\s"',}\])]+\\[^\s"',}\])]+)/gu;

export function redactAgentFacingSessionValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((entry) => redactAgentFacingSessionValue(entry));
  if (typeof value === 'string') return redactLocalPathString(value);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactAgentFacingSessionValue(entry)]),
  );
}

export function redactAgentFacingJsonRecord(value: JsonRecord): JsonRecord {
  const redacted = redactAgentFacingSessionValue(value);
  return isRecord(redacted) ? redacted : {};
}

export function redactAgentFacingSessionText(value: string): string {
  const redacted = redactAgentFacingSessionValue(value);
  return typeof redacted === 'string' ? redacted : value;
}

export function redactAgentFacingSourceLocator(value: string | null): string | null {
  if (value === null) return null;

  const redacted = redactLocalPathString(value);
  if (redacted !== value) return null;

  return SAFE_SOURCE_LOCATOR_PATTERN.test(value) ? value : null;
}

function redactLocalPathString(value: string): string {
  const protectedUris: string[] = [];
  const protectedValue = value.replaceAll(SAFE_URI_PATTERN, (match) => {
    const token = `SAGA_DB_PROTECTED_URI_${String(protectedUris.length)}_TOKEN`;
    protectedUris.push(match);
    return token;
  });
  const redacted = protectedValue
    .replaceAll(LOCAL_FILE_URI_WITH_SPACES_PATTERN, LOCAL_PATH_REDACTION)
    .replaceAll(
      LOCAL_FILE_URI_WITH_SPACES_BOUNDED_NO_EXTENSION_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(LOCAL_FILE_URI_WITH_SPACES_NO_EXTENSION_PATTERN, LOCAL_PATH_REDACTION)
    .replaceAll(LOCAL_FILE_URI_PATTERN, LOCAL_PATH_REDACTION)
    .replaceAll(
      WINDOWS_UNC_LOCAL_PATH_WITH_SPACES_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      WINDOWS_UNC_LOCAL_PATH_WITH_SPACES_BOUNDED_NO_EXTENSION_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      WINDOWS_UNC_LOCAL_PATH_WITH_SPACES_NO_EXTENSION_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      WINDOWS_UNC_LOCAL_PATH_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      WINDOWS_LOCAL_PATH_WITH_SPACES_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      WINDOWS_LOCAL_PATH_WITH_SPACES_BOUNDED_NO_EXTENSION_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      WINDOWS_LOCAL_PATH_WITH_SPACES_NO_EXTENSION_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      WINDOWS_LOCAL_PATH_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      POSIX_LOCAL_PATH_WITH_SPACES_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      POSIX_LOCAL_PATH_WITH_SPACES_BOUNDED_NO_EXTENSION_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      POSIX_LOCAL_PATH_WITH_SPACES_NO_EXTENSION_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    )
    .replaceAll(
      POSIX_LOCAL_PATH_PATTERN,
      (_match, prefix: string) => `${prefix}${LOCAL_PATH_REDACTION}`,
    );

  return protectedUris.reduce(
    (output, uri, index) => output.replaceAll(`SAGA_DB_PROTECTED_URI_${String(index)}_TOKEN`, uri),
    redacted,
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
