// Local option parsing shared by the READ client commands (SGA-239 slice 2).
// A faithful port of the parser the original apps/cli recall/sessions commands
// use, so the client surface accepts the same flags/positionals and emits the
// same "unknown option"/"expects a value" errors.

export type LocalOptions = {
  booleans: Set<string>;
  flags: Record<string, string>;
  positionals: string[];
};

export function parseLocalOptions(
  args: readonly string[],
  spec: { booleanFlags: ReadonlySet<string>; flagsWithValues: ReadonlySet<string>; noun: string },
): LocalOptions {
  const booleans = new Set<string>();
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const [rawName, inlineValue] = arg.slice(2).split('=', 2);
    const name = rawName ?? '';
    if (spec.booleanFlags.has(name)) {
      if (inlineValue !== undefined) {
        throw new Error(`--${name} does not take a value`);
      }
      booleans.add(name);
      continue;
    }
    if (!spec.flagsWithValues.has(name)) {
      throw new Error(`unknown ${spec.noun} option: --${name}`);
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined) {
      throw new Error(`--${name} expects a value`);
    }
    flags[name] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return { booleans, flags, positionals };
}

export function parsePositiveIntegerFlag(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`--${label} must be a positive integer`);
  }
  return parsed;
}

export function parseNonNegativeIntegerFlag(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`--${label} must be a non-negative integer`);
  }
  return parsed;
}

export function parseScoreFlag(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--${label} must be between 0 and 1`);
  }
  return parsed;
}

export function firstFlag(
  flags: Record<string, string>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
