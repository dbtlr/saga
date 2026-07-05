import { DATABASE_URL_ENV } from '@saga/runtime';

// Test support for the *.postgres.test.ts suites: they point the app at a
// throwaway database by setting the runtime DB env var, then restore it. The
// variable name is single-sourced in @saga/runtime (DATABASE_URL_ENV), so these
// helpers keep the name out of every integration test — a future rename is one
// edit. Not reachable from main.ts, so it never enters the compiled binary.

export function setDatabaseUrlEnv(url: string): string | undefined {
  const previous = process.env[DATABASE_URL_ENV];
  process.env[DATABASE_URL_ENV] = url;
  return previous;
}

export function restoreDatabaseUrlEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[DATABASE_URL_ENV];
    return;
  }
  process.env[DATABASE_URL_ENV] = previous;
}
