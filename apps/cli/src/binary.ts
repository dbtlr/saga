import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * How this process was launched. A `bun build --compile` single-file binary
 * runs with `process.execPath` pointing at the compiled artifact (basename
 * `saga`), whereas a from-source run goes through the Node/Bun runtime
 * (`process.execPath` basename `node`/`bun`, with tsx loading the TypeScript).
 * Self-update swaps `process.execPath`, so it must only ever run in the compiled
 * case; the plist install path likewise points at the compiled stable-path
 * binary when compiled and falls back to the tsx+source invocation otherwise.
 */
export function isRunningFromSource(binPath: string = process.execPath): boolean {
  return /^(node|bun)/u.test(basename(binPath));
}

export function isCompiledBinary(binPath: string = process.execPath): boolean {
  return !isRunningFromSource(binPath);
}

/**
 * The single stable install path a compiled binary lives at (ADR-0044). The
 * launchd plist and self-update both converge on this one path so an update
 * swaps exactly the binary launchd re-execs.
 */
export function stableBinPath(home: string = homedir()): string {
  return join(home, '.local', 'bin', 'saga');
}
