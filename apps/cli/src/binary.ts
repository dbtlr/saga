import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How this process was launched. A `bun build --compile` standalone binary runs
 * its entrypoint out of Bun's embedded filesystem, so `process.argv[1]` starts
 * with `/$bunfs/` — a positive, name-independent signal present regardless of
 * what the binary is called or which user args follow. A from-source run (bun
 * or node+tsx) has a real filesystem path there instead. Detection is
 * fail-closed: an unrecognized launcher is treated as source and refuses to
 * self-update. Self-update still swaps `process.execPath` (the running binary);
 * only the compiled-vs-source *decision* keys off argv[1].
 */
export function isCompiledBinary(argv1: string | undefined = process.argv[1]): boolean {
  return (argv1 ?? '').startsWith('/$bunfs/');
}

export function isRunningFromSource(argv1: string | undefined = process.argv[1]): boolean {
  return !isCompiledBinary(argv1);
}

/**
 * The single stable install path a compiled binary lives at (ADR-0044). The
 * launchd plist and self-update both converge on this one path so an update
 * swaps exactly the binary launchd re-execs.
 */
export function stableBinPath(home: string = homedir()): string {
  return join(home, '.local', 'bin', 'saga');
}
