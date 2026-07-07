#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));

const result = spawnSync(process.execPath, [tsxCli, main, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error !== undefined) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
