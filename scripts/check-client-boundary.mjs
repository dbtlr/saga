#!/usr/bin/env node

// SGA-237 boundary guard (ADR-0048). The client tier runs from a bare binary and
// must never pull in the database tier: @saga/client-cli may not depend on
// @saga/db — directly, through the transitive workspace-dep closure, or via a
// source import (bare specifier or a relative path into packages/db). This guard
// makes that install-shape invariant a CI-checked property instead of a review
// convention. It fails loud (non-zero exit, named offenders) so a future edit
// that reaches for @saga/db is caught here rather than bloating the client binary.
//
// Usage: node scripts/check-client-boundary.mjs

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = '@saga/db';
const CLIENT_PACKAGE = '@saga/client-cli';

const failures = [];

// --- Build a name -> package.json path map across every workspace package. ---
const workspacePackages = new Map();
for (const group of ['apps', 'packages']) {
  const groupDir = join(repoRoot, group);
  if (!existsSync(groupDir)) {
    continue;
  }
  for (const entry of readdirSync(groupDir)) {
    const manifestPath = join(groupDir, entry, 'package.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name === 'string') {
      workspacePackages.set(manifest.name, { dir: join(groupDir, entry), manifest });
    }
  }
}

const clientEntry = workspacePackages.get(CLIENT_PACKAGE);
if (clientEntry === undefined) {
  console.error(`check-client-boundary: cannot find ${CLIENT_PACKAGE} in the workspace`);
  process.exit(1);
}

// --- 1. Transitive workspace-dep closure must not include @saga/db. ---
function workspaceDeps(manifest) {
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter(
    (name) => workspacePackages.has(name),
  );
}

const visited = new Set();
const closure = new Set();
function walk(name) {
  if (visited.has(name)) {
    return;
  }
  visited.add(name);
  const entry = workspacePackages.get(name);
  if (entry === undefined) {
    return;
  }
  for (const dep of workspaceDeps(entry.manifest)) {
    closure.add(dep);
    walk(dep);
  }
}
walk(CLIENT_PACKAGE);

if (closure.has(FORBIDDEN)) {
  if (workspaceDeps(clientEntry.manifest).includes(FORBIDDEN)) {
    failures.push(`${CLIENT_PACKAGE}'s package.json declares a forbidden dependency: ${FORBIDDEN}`);
  } else {
    failures.push(
      `${CLIENT_PACKAGE} reaches ${FORBIDDEN} through its transitive workspace-dependency closure`,
    );
  }
}

// --- 2. No source file under packages/client-cli/src may import @saga/db, ---
// ---    nor a relative path into packages/db.                             ---
const dbDir = join(repoRoot, 'packages', 'db');
const srcDir = join(clientEntry.dir, 'src');
const importPattern =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir) {
  const files = [];
  if (!existsSync(dir)) {
    return files;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (full.endsWith('.ts') || full.endsWith('.tsx') || full.endsWith('.mts')) {
      files.push(full);
    }
  }
  return files;
}

for (const file of sourceFiles(srcDir)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined) {
      continue;
    }
    const rel = relative(repoRoot, file);
    if (specifier === FORBIDDEN || specifier.startsWith(`${FORBIDDEN}/`)) {
      failures.push(`${rel} imports ${FORBIDDEN}`);
    } else if (specifier.startsWith('.')) {
      const resolved = resolve(dirname(file), specifier);
      if (resolved === dbDir || resolved.startsWith(`${dbDir}/`)) {
        failures.push(`${rel} imports a relative path into packages/db: ${specifier}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `check-client-boundary: ${CLIENT_PACKAGE} must never depend on ${FORBIDDEN} (ADR-0048)`,
  );
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`check-client-boundary: ok — ${CLIENT_PACKAGE} is clear of ${FORBIDDEN}`);
