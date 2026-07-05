import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const dbIndex = fileURLToPath(new URL('../../../packages/db/src/index.ts', import.meta.url));

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('@saga/db module import', () => {
  it('performs no tmp writes at import time', () => {
    // The compiled-binary migration path materializes embedded migrations
    // only inside runMigrations, never as an import side effect. Import the
    // module in a fresh process with TMPDIR pointed at an empty probe dir and
    // assert nothing appears there.
    const scriptDir = mkdtempSync(join(tmpdir(), 'saga-import-script-'));
    const probeTmp = mkdtempSync(join(tmpdir(), 'saga-import-probe-'));
    cleanups.push(scriptDir, probeTmp);

    const script = join(scriptDir, 'import-db.mjs');
    writeFileSync(script, `await import(${JSON.stringify(pathToFileURL(dbIndex).href)});\n`);

    const result = spawnSync(process.execPath, [tsxCli, script], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: probeTmp },
    });

    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    // tsx drops its own loader cache in TMPDIR; only saga writes matter here.
    expect(readdirSync(probeTmp).filter((entry) => entry.startsWith('saga-'))).toStrictEqual([]);
  });
});
